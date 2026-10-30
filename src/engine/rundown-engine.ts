import type { RundownV2, RundownItem } from "../schema/rundown-v2.js";
import type { VariableStore } from "../variables/variable-store.js";
import type { VarfetchEngine } from "../variables/varfetch-engine.js";
import type { CueMatcher } from "../cues/cue-matcher.js";
import type { ActionDispatcher, ExecutionResult } from "../actions/action-dispatcher.js";
import type { RundownEventBroker } from "../events.js";

export type ItemStatus = "pending" | "active" | "completed" | "skipped";

export interface ItemStateSnapshot {
  id: string;
  line: number;
  index: number;
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
  currentLine: number | null;
  totalItems: number;
  currentItem: ItemStateSnapshot | null;
  items: ItemStateSnapshot[];
  variables: Record<string, string>;
  cueEngineEnabled: boolean;
  history: Array<{ timestamp: string; type: string; detail: unknown }>;
}

export class RundownEngine {
  private rundown: RundownV2 | null = null;
  private currentIndex = -1;
  private readonly itemStates = new Map<string, ItemStatus>();
  private readonly history: Array<{ timestamp: string; type: string; detail: unknown }> = [];
  private cueEngineEnabled = true;
  private readonly firedItems = new Set<string>();

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
    this.firedItems.clear();

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

    await this.actionDispatcher.pushRundownToGateway(doc);
    this.emitState();
  }

  reset(): void {
    if (!this.rundown) return;
    this.firedItems.clear();
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

  isCueEngineEnabled(): boolean {
    return this.cueEngineEnabled;
  }

  setCueEngineEnabled(enabled: boolean): boolean {
    if (this.cueEngineEnabled !== enabled) {
      this.cueEngineEnabled = enabled;
      this.logHistory("cue_engine_toggled", { enabled });
      this.eventBroker.emit("cue_engine_toggled", { enabled });
      this.emitState();
    }
    return this.cueEngineEnabled;
  }

  onGatewayRundownState(snapshot: {
    currentIndex?: number;
    items?: Array<{ id: string; status: ItemStatus }>;
    variables?: Record<string, string>;
  }): void {
    if (typeof snapshot.currentIndex === "number") {
      this.currentIndex = snapshot.currentIndex;
    }
    if (Array.isArray(snapshot.items)) {
      for (const it of snapshot.items) {
        this.itemStates.set(it.id, it.status);
        if (it.status === "completed" || it.status === "active") {
          this.firedItems.add(it.id);
        }
      }
    }
    if (snapshot.variables) {
      for (const [k, v] of Object.entries(snapshot.variables)) {
        this.variableStore.set(k, v, "gateway");
      }
    }
    this.emitState();
  }

  toggleCueEngine(): boolean {
    return this.setCueEngineEnabled(!this.cueEngineEnabled);
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

  async fire(target?: number | string | { line?: number; id?: string }): Promise<{ ok: boolean; executed: ExecutionResult[] }> {
    if (!this.rundown || this.rundown.rundown.length === 0) return { ok: false, executed: [] };

    let targetIdx = -1;
    if (typeof target === "number") {
      targetIdx = target - 1;
    } else if (typeof target === "string") {
      const trimmed = target.trim();
      if (/^\d+$/.test(trimmed)) {
        targetIdx = parseInt(trimmed, 10) - 1;
      } else {
        targetIdx = this.rundown.rundown.findIndex((it) => it.id === trimmed);
      }
    } else if (typeof target === "object" && target !== null) {
      if (typeof target.line === "number") {
        targetIdx = target.line - 1;
      } else if (typeof target.id === "string") {
        const trimmed = target.id.trim();
        if (/^\d+$/.test(trimmed)) {
          targetIdx = parseInt(trimmed, 10) - 1;
        } else {
          targetIdx = this.rundown.rundown.findIndex((it) => it.id === trimmed);
        }
      }
    } else {
      targetIdx = this.currentIndex >= 0 ? this.currentIndex : 0;
    }

    if (targetIdx < 0 || targetIdx >= this.rundown.rundown.length) {
      return { ok: false, executed: [] };
    }

    return await this.fireItemAt(targetIdx, "manual");
  }

  async onTranscript(text: string): Promise<boolean> {
    if (!this.cueEngineEnabled) return false;
    if (!this.rundown || this.currentIndex < 0 || this.currentIndex >= this.rundown.rundown.length) {
      return false;
    }

    const vars = this.variableStore.getAll();

    // 1. Check current item's cue
    const current = this.getCurrentItem();
    if (current && current.cue) {
      const match = this.cueMatcher.evaluate(
        current.cue,
        { text, variables: vars },
        current.id
      );
      if (match.matched) {
        await this.fireItemAt(this.currentIndex, match.reason);
        return true;
      }
    }

    // 2. Check next item (currentIndex + 1)
    const nextIdx = this.currentIndex + 1;
    if (nextIdx < this.rundown.rundown.length) {
      const nextItem = this.rundown.rundown[nextIdx]!;
      if (nextItem.cue) {
        const match = this.cueMatcher.evaluate(
          nextItem.cue,
          { text, variables: vars },
          nextItem.id
        );
        if (match.matched) {
          await this.fireItemAt(nextIdx, match.reason);
          return true;
        }
      }
    }

    // 3. Check future items that allow 'skip' or 'any' mode
    for (let idx = this.currentIndex + 2; idx < this.rundown.rundown.length; idx++) {
      const futureItem = this.rundown.rundown[idx]!;
      if (futureItem.cue && (futureItem.cue.mode === "skip" || futureItem.cue.mode === "any")) {
        const match = this.cueMatcher.evaluate(
          futureItem.cue,
          { text, variables: vars },
          futureItem.id
        );
        if (match.matched) {
          await this.fireItemAt(idx, match.reason);
          return true;
        }
      }
    }

    return false;
  }

  async onSoundEvent(
    event: "music_start" | "music_stop" | "speech_start" | "speech_stop" | "silence"
  ): Promise<boolean> {
    if (!this.cueEngineEnabled) return false;
    if (!this.rundown || this.currentIndex < 0 || this.currentIndex >= this.rundown.rundown.length) {
      return false;
    }

    // 1. Check current item's cue
    const current = this.getCurrentItem();
    if (current && current.cue) {
      const match = this.cueMatcher.evaluate(
        current.cue,
        { soundEvent: event },
        current.id
      );
      if (match.matched) {
        await this.fireItemAt(this.currentIndex, match.reason);
        return true;
      }
    }

    // 2. Check next item (currentIndex + 1)
    const nextIdx = this.currentIndex + 1;
    if (nextIdx < this.rundown.rundown.length) {
      const nextItem = this.rundown.rundown[nextIdx]!;
      if (nextItem.cue) {
        const match = this.cueMatcher.evaluate(
          nextItem.cue,
          { soundEvent: event },
          nextItem.id
        );
        if (match.matched) {
          await this.fireItemAt(nextIdx, match.reason);
          return true;
        }
      }
    }

    // 3. Check future items that allow 'skip' or 'any' mode
    for (let idx = this.currentIndex + 2; idx < this.rundown.rundown.length; idx++) {
      const futureItem = this.rundown.rundown[idx]!;
      if (futureItem.cue && (futureItem.cue.mode === "skip" || futureItem.cue.mode === "any")) {
        const match = this.cueMatcher.evaluate(
          futureItem.cue,
          { soundEvent: event },
          futureItem.id
        );
        if (match.matched) {
          await this.fireItemAt(idx, match.reason);
          return true;
        }
      }
    }

    return false;
  }

  private async fireItemAt(targetIndex: number, reason?: string): Promise<{ ok: boolean; executed: ExecutionResult[] }> {
    if (!this.rundown || targetIndex < 0 || targetIndex >= this.rundown.rundown.length) {
      return { ok: false, executed: [] };
    }

    const item = this.rundown.rundown[targetIndex]!;
    const line = targetIndex + 1;

    // Transition states:
    // Prior items 0 .. targetIndex - 1: pending/active become completed
    // Target item: active
    // Following items: if active, become pending
    this.rundown.rundown.forEach((it, idx) => {
      if (idx < targetIndex) {
        const s = this.itemStates.get(it.id);
        if (s === "pending" || s === "active") {
          this.itemStates.set(it.id, "completed");
        }
      } else if (idx === targetIndex) {
        this.itemStates.set(it.id, "active");
      } else {
        if (this.itemStates.get(it.id) === "active") {
          this.itemStates.set(it.id, "pending");
        }
      }
    });

    this.currentIndex = targetIndex;
    this.firedItems.add(item.id);

    this.eventBroker.emit("cue_fired", {
      itemId: item.id,
      title: item.title,
      line,
      index: targetIndex,
      reason,
      timestamp: new Date().toISOString(),
    });
    this.logHistory("cue_fired", { id: item.id, line, index: targetIndex, title: item.title, reason });

    // Inform gateway: line <line> fires!
    await this.actionDispatcher.fireLine(line, item.id);

    const executed = await this.executeItemActions(item);
    this.emitState();

    return { ok: true, executed };
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
        currentLine: null,
        totalItems: 0,
        currentItem: null,
        items: [],
        variables: this.variableStore.getAll(),
        cueEngineEnabled: this.cueEngineEnabled,
        history: [...this.history],
      };
    }

    const items: ItemStateSnapshot[] = this.rundown.rundown.map((it, idx) => ({
      id: it.id,
      line: idx + 1,
      index: idx,
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

    const currentLine =
      this.currentIndex >= 0 && this.currentIndex < items.length
        ? this.currentIndex + 1
        : null;

    return {
      loaded: true,
      title: this.rundown.title,
      service: this.rundown.service,
      church: this.rundown.church,
      date: this.rundown.date,
      currentIndex: this.currentIndex,
      currentLine,
      totalItems: items.length,
      currentItem,
      items,
      variables: this.variableStore.getAll(),
      cueEngineEnabled: this.cueEngineEnabled,
      history: [...this.history],
    };
  }
}
