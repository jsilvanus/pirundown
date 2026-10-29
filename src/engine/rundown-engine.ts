import type { RundownV2, RundownItem } from "../schema/rundown-v2.js";
import type { VariableStore } from "../variables/variable-store.js";
import type { VarfetchEngine } from "../variables/varfetch-engine.js";
import type { CueMatcher } from "../cues/cue-matcher.js";
import type { ActionDispatcher, ExecutionResult } from "../actions/action-dispatcher.js";
import type { RundownEventBroker } from "../events.js";

export type ItemStatus = "pending" | "active" | "completed" | "skipped";

export interface ItemStateSnapshot {
  id: string;
  title: string;
  section?: string;
  status: ItemStatus;
  hasCue: boolean;
  actionCount: number;
  notes?: string;
}

export interface RundownStatusSnapshot {
  loaded: boolean;
  title?: string;
  service?: string;
  church?: string;
  date?: string;
  currentIndex: number;
  totalItems: number;
  currentItem: ItemStateSnapshot | null;
  items: ItemStateSnapshot[];
  variables: Record<string, string>;
  history: Array<{ timestamp: string; type: string; detail: unknown }>;
}

export class RundownEngine {
  private rundown: RundownV2 | null = null;
  private currentIndex = -1;
  private readonly itemStates = new Map<string, ItemStatus>();
  private readonly history: Array<{ timestamp: string; type: string; detail: unknown }> = [];

  private readonly variableStore: VariableStore;
  private readonly varfetchEngine: VarfetchEngine;
  private readonly cueMatcher: CueMatcher;
  private readonly actionDispatcher: ActionDispatcher;
  private readonly eventBroker: RundownEventBroker;

  constructor(
    variableStore: VariableStore,
    varfetchEngine: VarfetchEngine,
    cueMatcher: CueMatcher,
    actionDispatcher: ActionDispatcher,
    eventBroker: RundownEventBroker
  ) {
    this.variableStore = variableStore;
    this.varfetchEngine = varfetchEngine;
    this.cueMatcher = cueMatcher;
    this.actionDispatcher = actionDispatcher;
    this.eventBroker = eventBroker;

    // Forward variable changes to event broker
    this.variableStore.subscribe((variable) => {
      this.eventBroker.emit("variable_updated", variable);
    });
  }

  async load(doc: RundownV2): Promise<void> {
    this.rundown = doc;
    this.itemStates.clear();
    this.history.length = 0;

    // 1. Register connectors
    if (doc.connectors) {
      this.varfetchEngine.registerConnectors(doc.connectors);
    }

    // 2. Set preflight initial variables
    if (doc.preflight?.variables) {
      for (const [key, val] of Object.entries(doc.preflight.variables)) {
        this.variableStore.set(key, String(val ?? ""), "preflight");
      }
    }

    // 3. Mark all items as pending
    for (const item of doc.rundown) {
      this.itemStates.set(item.id, "pending");
    }

    // 4. Fire preflight fetches if configured
    if (doc.preflight?.fetch && doc.preflight.fetch.length > 0) {
      for (const f of doc.preflight.fetch) {
        await this.varfetchEngine.fetch(f.connector, f.request);
      }
    }

    // 5. Activate first item
    if (doc.rundown.length > 0 && doc.rundown[0]) {
      this.currentIndex = 0;
      this.itemStates.set(doc.rundown[0].id, "active");
    } else {
      this.currentIndex = -1;
    }

    this.emitState();
  }

  reset(): void {
    if (!this.rundown) return;
    for (const item of this.rundown.rundown) {
      this.itemStates.set(item.id, "pending");
    }
    if (this.rundown.rundown.length > 0 && this.rundown.rundown[0]) {
      this.currentIndex = 0;
      this.itemStates.set(this.rundown.rundown[0].id, "active");
    } else {
      this.currentIndex = -1;
    }
    this.emitState();
  }

  getCurrentItem(): RundownItem | null {
    if (!this.rundown || this.currentIndex < 0 || this.currentIndex >= this.rundown.rundown.length) {
      return null;
    }
    return this.rundown.rundown[this.currentIndex] ?? null;
  }

  async next(): Promise<boolean> {
    if (!this.rundown || this.currentIndex < 0) return false;
    const current = this.getCurrentItem();
    if (current) {
      this.itemStates.set(current.id, "completed");
    }

    const nextIndex = this.currentIndex + 1;
    if (nextIndex < this.rundown.rundown.length && this.rundown.rundown[nextIndex]) {
      this.currentIndex = nextIndex;
      this.itemStates.set(this.rundown.rundown[nextIndex]!.id, "active");
      this.emitState();
      return true;
    } else {
      this.currentIndex = this.rundown.rundown.length;
      this.emitState();
      return false;
    }
  }

  previous(): boolean {
    if (!this.rundown || this.currentIndex <= 0) return false;
    const current = this.getCurrentItem();
    if (current) {
      this.itemStates.set(current.id, "pending");
    }

    this.currentIndex--;
    const prev = this.getCurrentItem();
    if (prev) {
      this.itemStates.set(prev.id, "active");
      this.emitState();
      return true;
    }
    return false;
  }

  goto(id: string): boolean {
    if (!this.rundown) return false;
    const targetIdx = this.rundown.rundown.findIndex((it) => it.id === id);
    if (targetIdx === -1) return false;

    // Mark items prior to target as completed, target as active, after as pending
    this.rundown.rundown.forEach((it, idx) => {
      if (idx < targetIdx) {
        if (this.itemStates.get(it.id) === "pending") this.itemStates.set(it.id, "completed");
      } else if (idx === targetIdx) {
        this.itemStates.set(it.id, "active");
      } else {
        this.itemStates.set(it.id, "pending");
      }
    });

    this.currentIndex = targetIdx;
    this.emitState();
    return true;
  }

  skip(id?: string): boolean {
    if (!this.rundown) return false;
    const targetItem = id
      ? this.rundown.rundown.find((it) => it.id === id)
      : this.getCurrentItem();

    if (!targetItem) return false;

    this.itemStates.set(targetItem.id, "skipped");
    this.logHistory("item_skipped", { id: targetItem.id, title: targetItem.title });

    if (this.getCurrentItem()?.id === targetItem.id) {
      return this.advanceAfterCompletion(targetItem);
    }
    this.emitState();
    return true;
  }

  async fire(id?: string): Promise<{ ok: boolean; executed: ExecutionResult[] }> {
    if (!this.rundown) return { ok: false, executed: [] };
    const targetItem = id
      ? this.rundown.rundown.find((it) => it.id === id)
      : this.getCurrentItem();

    if (!targetItem) return { ok: false, executed: [] };

    // Fire cue manually
    this.eventBroker.emit("cue_fired", {
      itemId: targetItem.id,
      title: targetItem.title,
      manual: true,
      timestamp: new Date().toISOString(),
    });

    const executed = await this.executeItemActions(targetItem);
    this.itemStates.set(targetItem.id, "completed");

    this.advanceAfterCompletion(targetItem);
    return { ok: true, executed };
  }

  async onTranscript(text: string): Promise<boolean> {
    if (!this.rundown || this.currentIndex < 0 || this.currentIndex >= this.rundown.rundown.length) {
      return false;
    }

    const current = this.getCurrentItem();
    const vars = this.variableStore.getAll();

    // 1. Check current active item's cue
    if (current && current.cue) {
      const match = this.cueMatcher.evaluate(
        current.cue,
        { text, variables: vars },
        current.id
      );

      if (match.matched) {
        await this.handleCueMatch(current, match.reason);
        return true;
      }
    }

    // 2. Check future items that allow 'skip' or 'any' mode
    for (let idx = this.currentIndex + 1; idx < this.rundown.rundown.length; idx++) {
      const futureItem = this.rundown.rundown[idx]!;
      if (futureItem.cue && (futureItem.cue.mode === "skip" || futureItem.cue.mode === "any")) {
        const match = this.cueMatcher.evaluate(
          futureItem.cue,
          { text, variables: vars },
          futureItem.id
        );
        if (match.matched) {
          // Mark skipped items in between
          for (let skipIdx = this.currentIndex; skipIdx < idx; skipIdx++) {
            const skipped = this.rundown.rundown[skipIdx]!;
            this.itemStates.set(skipped.id, "skipped");
          }
          this.currentIndex = idx;
          await this.handleCueMatch(futureItem, match.reason);
          return true;
        }
      }
    }

    return false;
  }

  async onSoundEvent(
    event: "music_start" | "music_stop" | "speech_start" | "speech_stop" | "silence"
  ): Promise<boolean> {
    if (!this.rundown || this.currentIndex < 0 || this.currentIndex >= this.rundown.rundown.length) {
      return false;
    }

    const current = this.getCurrentItem();
    if (!current || !current.cue) return false;

    const match = this.cueMatcher.evaluate(
      current.cue,
      { soundEvent: event },
      current.id
    );

    if (match.matched) {
      await this.handleCueMatch(current, match.reason);
      return true;
    }

    return false;
  }

  private async handleCueMatch(item: RundownItem, reason?: string): Promise<void> {
    this.eventBroker.emit("cue_fired", {
      itemId: item.id,
      title: item.title,
      reason,
      timestamp: new Date().toISOString(),
    });
    this.logHistory("cue_fired", { id: item.id, title: item.title, reason });

    const executed = await this.executeItemActions(item);
    this.itemStates.set(item.id, "completed");

    this.advanceAfterCompletion(item);
  }

  private advanceAfterCompletion(item: RundownItem): boolean {
    const currentIdx = this.rundown?.rundown.findIndex((it) => it.id === item.id) ?? -1;
    if (this.rundown && currentIdx >= 0) {
      const nextIdx = currentIdx + 1;
      if (nextIdx < this.rundown.rundown.length && this.rundown.rundown[nextIdx]) {
        this.currentIndex = nextIdx;
        this.itemStates.set(this.rundown.rundown[nextIdx]!.id, "active");
      } else {
        this.currentIndex = this.rundown.rundown.length;
      }
    }
    this.emitState();
    return true;
  }

  private async executeItemActions(item: RundownItem): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    for (const action of item.actions) {
      const res = await this.actionDispatcher.dispatch(action);
      results.push(res);
      this.eventBroker.emit("action_executed", {
        itemId: item.id,
        action,
        ok: res.ok,
        target: res.target,
        error: res.error,
      });
      this.logHistory("action_executed", { id: item.id, action, ok: res.ok, error: res.error });
    }
    return results;
  }

  private emitState(): void {
    const snapshot = this.getStatus();
    this.eventBroker.emit("rundown_state", snapshot);
  }

  private logHistory(type: string, detail: unknown): void {
    this.history.unshift({
      timestamp: new Date().toISOString(),
      type,
      detail,
    });
    if (this.history.length > 100) {
      this.history.pop();
    }
  }

  getStatus(): RundownStatusSnapshot {
    if (!this.rundown) {
      return {
        loaded: false,
        currentIndex: -1,
        totalItems: 0,
        currentItem: null,
        items: [],
        variables: this.variableStore.getAll(),
        history: [...this.history],
      };
    }

    const items: ItemStateSnapshot[] = this.rundown.rundown.map((it) => ({
      id: it.id,
      title: it.title,
      section: it.section,
      status: this.itemStates.get(it.id) ?? "pending",
      hasCue: Boolean(it.cue),
      actionCount: it.actions.length,
      notes: it.notes,
    }));

    const currentItem =
      this.currentIndex >= 0 && this.currentIndex < items.length
        ? items[this.currentIndex] ?? null
        : null;

    return {
      loaded: true,
      title: this.rundown.title,
      service: this.rundown.service,
      church: this.rundown.church,
      date: this.rundown.date,
      currentIndex: this.currentIndex,
      totalItems: items.length,
      currentItem,
      items,
      variables: this.variableStore.getAll(),
      history: [...this.history],
    };
  }
}
