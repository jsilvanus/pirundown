import type { RundownV2, RundownItem } from "../schema/rundown-v2.js";
import type { VariableStore } from "../variables/variable-store.js";
import type { VarfetchEngine } from "../variables/varfetch-engine.js";
import type { CueMatcher } from "../cues/cue-matcher.js";
import type { ActionDispatcher, ExecutionResult } from "../actions/action-dispatcher.js";
import type { RundownEventBroker } from "../events.js";
import {
  buildRundownDisplay,
  type RundownDisplay,
  type DisplayLine,
  type ExecutableItem,
  type ItemStatus,
} from "../display/rundown-display.js";
import {
  Alternator,
  normalizeAlternatorConfig,
  type AlternatorStatus,
  type SoundCondition,
} from "./alternator.js";

export { ItemStatus };

export interface ItemStateSnapshot {
  id: string;
  line: number;
  index: number;
  title: string;
  section?: string | undefined;
  status: ItemStatus;
  hasCue: boolean;
  actionCount: number;
  notes?: string | undefined;
}

export interface RundownStatusSnapshot {
  loaded: boolean;
  title?: string | undefined;
  service?: string | undefined;
  church?: string | undefined;
  date?: string | undefined;
  currentIndex: number;
  currentLine: number | null;
  totalItems: number;
  totalLines: number;
  currentItem: ItemStateSnapshot | null;
  items: ItemStateSnapshot[];
  display: RundownDisplay;
  alternation?: AlternatorStatus | null;
  soundState?: string;
  variables: Record<string, string>;
  cueEngineEnabled: boolean;
  history: Array<{ timestamp: string; type: string; detail: unknown }>;
}

export class RundownEngine {
  private rundown: RundownV2 | null = null;
  private currentExecutableId: string | null = null;
  private readonly itemStates = new Map<string, ItemStatus>();
  private readonly history: Array<{ timestamp: string; type: string; detail: unknown }> = [];
  private cueEngineEnabled = true;
  private readonly firedItems = new Set<string>();
  private activeAlternator: Alternator | null = null;
  private currentSoundState: "speech" | "music" | "silence" | "unknown" = "unknown";

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

    this.variableStore.subscribe((variable) => {
      this.eventBroker.emit("variable_updated", variable);
    });
  }

  async load(doc: RundownV2): Promise<void> {
    this.rundown = doc;
    this.itemStates.clear();
    this.history.length = 0;
    this.firedItems.clear();
    this.stopAlternator();
    this.stopAlternator();

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

    // 3. Initialize all executable items as pending
    const { executableItems } = buildRundownDisplay(doc.rundown, this.itemStates);
    for (const item of executableItems) {
      this.itemStates.set(item.id, "pending");
    }

    // 4. Fire preflight fetches if configured
    if (doc.preflight?.fetch && doc.preflight.fetch.length > 0) {
      for (const f of doc.preflight.fetch) {
        await this.varfetchEngine.fetch(f.connector, f.request);
      }
    }

    // 4b. Preflight semantic cues to piembed
    this.cueMatcher.clearContext();
    const semanticCues = this.extractSemanticCues(executableItems, this.variableStore.getAll());
    if (semanticCues.length > 0) {
      await this.cueMatcher.preflightCues(doc.title ?? "default", semanticCues);
    }

    // 5. Activate first executable item
    if (executableItems.length > 0 && executableItems[0]) {
      this.currentExecutableId = executableItems[0].id;
      this.itemStates.set(executableItems[0].id, "active");
    } else {
      this.currentExecutableId = null;
    }

    await this.actionDispatcher.pushRundownToGateway(doc);
    this.emitState();
  }

  reset(): void {
    if (!this.rundown) return;
    this.firedItems.clear();

    const { executableItems } = buildRundownDisplay(this.rundown.rundown, this.itemStates);
    for (const item of executableItems) {
      this.itemStates.set(item.id, "pending");
    }

    if (executableItems.length > 0 && executableItems[0]) {
      this.currentExecutableId = executableItems[0].id;
      this.itemStates.set(executableItems[0].id, "active");
    } else {
      this.currentExecutableId = null;
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

  toggleCueEngine(): boolean {
    return this.setCueEngineEnabled(!this.cueEngineEnabled);
  }

  onGatewayRundownState(snapshot: {
    currentIndex?: number;
    currentLine?: number | null;
    items?: Array<{ id: string; status: ItemStatus }>;
    variables?: Record<string, string>;
  }): void {
    if (Array.isArray(snapshot.items)) {
      for (const it of snapshot.items) {
        this.itemStates.set(it.id, it.status);
        if (it.status === "completed" || it.status === "active") {
          this.firedItems.add(it.id);
        }
      }
    }

    const { executableItems } = buildRundownDisplay(this.rundown?.rundown ?? [], this.itemStates);
    if (typeof snapshot.currentIndex === "number" && snapshot.currentIndex >= 0 && snapshot.currentIndex < executableItems.length) {
      this.currentExecutableId = executableItems[snapshot.currentIndex]?.id ?? null;
    }

    if (snapshot.variables) {
      for (const [k, v] of Object.entries(snapshot.variables)) {
        this.variableStore.set(k, v, "gateway");
      }
    }

    this.emitState();
  }

  getCurrentExecutableItem(): ExecutableItem | null {
    if (!this.rundown || !this.currentExecutableId) return null;
    const { executableItems } = buildRundownDisplay(this.rundown.rundown, this.itemStates, this.currentExecutableId);
    return executableItems.find((it) => it.id === this.currentExecutableId) ?? null;
  }

  getCurrentItem(): ExecutableItem | null {
    return this.getCurrentExecutableItem();
  }

  async next(): Promise<boolean> {
    this.stopAlternator();
    if (!this.rundown) return false;
    const { executableItems } = buildRundownDisplay(this.rundown.rundown, this.itemStates, this.currentExecutableId);
    if (executableItems.length === 0) return false;

    const currentIdx = this.currentExecutableId
      ? executableItems.findIndex((it) => it.id === this.currentExecutableId)
      : -1;

    if (currentIdx >= 0 && executableItems[currentIdx]) {
      this.itemStates.set(executableItems[currentIdx]!.id, "completed");
    }

    const nextIdx = currentIdx + 1;
    if (nextIdx < executableItems.length && executableItems[nextIdx]) {
      this.currentExecutableId = executableItems[nextIdx]!.id;
      this.itemStates.set(executableItems[nextIdx]!.id, "active");
      this.emitState();
      return true;
    } else {
      this.currentExecutableId = null;
      this.emitState();
      return false;
    }
  }

  previous(): boolean {
    this.stopAlternator();
    if (!this.rundown) return false;
    const { executableItems } = buildRundownDisplay(this.rundown.rundown, this.itemStates, this.currentExecutableId);
    if (executableItems.length === 0) return false;

    const currentIdx = this.currentExecutableId
      ? executableItems.findIndex((it) => it.id === this.currentExecutableId)
      : -1;

    if (currentIdx <= 0) return false;

    if (currentIdx < executableItems.length && executableItems[currentIdx]) {
      this.itemStates.set(executableItems[currentIdx]!.id, "pending");
    }

    const prevIdx = currentIdx - 1;
    if (prevIdx >= 0 && executableItems[prevIdx]) {
      this.currentExecutableId = executableItems[prevIdx]!.id;
      this.itemStates.set(executableItems[prevIdx]!.id, "active");
      this.emitState();
      return true;
    }

    return false;
  }

  goto(id: string): boolean {
    this.stopAlternator();
    if (!this.rundown) return false;
    const { executableItems, display } = buildRundownDisplay(this.rundown.rundown, this.itemStates, this.currentExecutableId);

    // Can be an executable item id or a line id
    let targetExec = executableItems.find((it) => it.id === id);
    if (!targetExec) {
      const line = display.lines.find((l) => l.id === id);
      if (line?.targetId) {
        targetExec = executableItems.find((it) => it.id === line.targetId);
      }
    }

    if (!targetExec) return false;

    const targetIdx = executableItems.findIndex((it) => it.id === targetExec!.id);
    executableItems.forEach((it, idx) => {
      if (idx < targetIdx) {
        if (this.itemStates.get(it.id) === "pending") this.itemStates.set(it.id, "completed");
      } else if (idx === targetIdx) {
        this.itemStates.set(it.id, "active");
      } else {
        this.itemStates.set(it.id, "pending");
      }
    });

    this.currentExecutableId = targetExec.id;
    this.emitState();
    return true;
  }

  skip(id?: string): boolean {
    this.stopAlternator();
    if (!this.rundown) return false;
    const { executableItems } = buildRundownDisplay(this.rundown.rundown, this.itemStates, this.currentExecutableId);

    const targetItem = id
      ? executableItems.find((it) => it.id === id)
      : this.getCurrentExecutableItem();

    if (!targetItem) return false;

    this.itemStates.set(targetItem.id, "skipped");
    this.logHistory("item_skipped", { id: targetItem.id, title: targetItem.title });

    if (this.currentExecutableId === targetItem.id) {
      const idx = executableItems.findIndex((it) => it.id === targetItem.id);
      if (idx + 1 < executableItems.length && executableItems[idx + 1]) {
        this.currentExecutableId = executableItems[idx + 1]!.id;
        this.itemStates.set(executableItems[idx + 1]!.id, "active");
      } else {
        this.currentExecutableId = null;
      }
    }

    this.emitState();
    return true;
  }

  async fire(target?: number | string | { line?: number; id?: string }): Promise<{ ok: boolean; executed: ExecutionResult[] }> {
    if (!this.rundown) return { ok: false, executed: [] };

    const { display, executableItems } = buildRundownDisplay(
      this.rundown.rundown,
      this.itemStates,
      this.currentExecutableId
    );

    if (executableItems.length === 0) return { ok: false, executed: [] };

    let targetExecItem: ExecutableItem | undefined;

    if (typeof target === "number") {
      // Find display line by 1-based display line number
      const line = display.lines.find((l) => l.line === target);
      if (line) {
        targetExecItem = executableItems.find((it) => it.id === line.targetId);
      }
    } else if (typeof target === "string") {
      const trimmed = target.trim();
      if (/^\d+$/.test(trimmed)) {
        const lineNum = parseInt(trimmed, 10);
        const line = display.lines.find((l) => l.line === lineNum);
        if (line) {
          targetExecItem = executableItems.find((it) => it.id === line.targetId);
        }
      } else {
        // Look up by item id or line id
        const line = display.lines.find((l) => l.id === trimmed);
        const targetId = line?.targetId ?? trimmed;
        targetExecItem = executableItems.find((it) => it.id === targetId);
      }
    } else if (typeof target === "object" && target !== null) {
      if (typeof target.line === "number") {
        const line = display.lines.find((l) => l.line === target.line);
        if (line) {
          targetExecItem = executableItems.find((it) => it.id === line.targetId);
        }
      } else if (typeof target.id === "string") {
        const line = display.lines.find((l) => l.id === target.id);
        const targetId = line?.targetId ?? target.id;
        targetExecItem = executableItems.find((it) => it.id === targetId);
      }
    } else {
      targetExecItem = this.getCurrentExecutableItem() ?? executableItems[0];
    }

    if (!targetExecItem) return { ok: false, executed: [] };

    return await this.fireExecutableItem(targetExecItem, "manual");
  }

  private extractSemanticCues(
    executableItems: ExecutableItem[],
    vars: Record<string, string>
  ): Array<{ id: string; phrase: string }> {
    const out: Array<{ id: string; phrase: string }> = [];
    const interpolate = (text: string) =>
      text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, k) => vars[k] ?? "");

    for (const item of executableItems) {
      const cue = item.cue as any;
      if (!cue || typeof cue !== "object") continue;
      if (cue.type === "semantic" && typeof cue.phrase === "string") {
        out.push({ id: item.id, phrase: interpolate(cue.phrase) });
      } else if ((cue.type === "all" || cue.type === "any") && Array.isArray(cue.conditions)) {
        cue.conditions.forEach((cond: any, idx: number) => {
          if (cond && cond.type === "semantic" && typeof cond.phrase === "string") {
            out.push({ id: `${item.id}:${idx}`, phrase: interpolate(cond.phrase) });
          }
        });
      }
    }
    return out;
  }

  async onTranscript(text: string): Promise<boolean> {
    if (!this.cueEngineEnabled) return false;
    if (!this.rundown) return false;

    this.cueMatcher.pushContextLine(text);

    const { executableItems } = buildRundownDisplay(
      this.rundown.rundown,
      this.itemStates,
      this.currentExecutableId
    );

    if (executableItems.length === 0) return false;

    const currentIdx = this.currentExecutableId
      ? executableItems.findIndex((it) => it.id === this.currentExecutableId)
      : 0;

    const vars = this.variableStore.getAll();

    // 1. Check current item's cue
    if (currentIdx >= 0 && currentIdx < executableItems.length) {
      const current = executableItems[currentIdx]!;
      if (current.cue) {
        const match = await this.cueMatcher.evaluateAsync(
          current.cue as any,
          { text, variables: vars },
          current.id
        );
        if (match.matched) {
          await this.fireExecutableItem(current, match.reason);
          return true;
        }
      }
    }

    // 2. Check next item (currentIdx + 1)
    const nextIdx = currentIdx + 1;
    if (nextIdx < executableItems.length) {
      const nextItem = executableItems[nextIdx]!;
      if (nextItem.cue) {
        const match = await this.cueMatcher.evaluateAsync(
          nextItem.cue as any,
          { text, variables: vars },
          nextItem.id
        );
        if (match.matched) {
          await this.fireExecutableItem(nextItem, match.reason);
          return true;
        }
      }
    }

    // 3. Check future items that allow 'skip' or 'any' mode
    for (let idx = currentIdx + 2; idx < executableItems.length; idx++) {
      const futureItem = executableItems[idx]!;
      if (futureItem.cue && ((futureItem.cue as any).mode === "skip" || (futureItem.cue as any).mode === "any")) {
        const match = await this.cueMatcher.evaluateAsync(
          futureItem.cue as any,
          { text, variables: vars },
          futureItem.id
        );
        if (match.matched) {
          await this.fireExecutableItem(futureItem, match.reason);
          return true;
        }
      }
    }

    return false;
  }

  async onSoundEvent(
    event: "music_start" | "music_stop" | "speech_start" | "speech_stop" | "silence"
  ): Promise<boolean> {
    if (event === "music_start") this.currentSoundState = "music";
    else if (event === "music_stop") this.currentSoundState = "silence";
    else if (event === "speech_start") this.currentSoundState = "speech";
    else if (event === "speech_stop") this.currentSoundState = "silence";
    else if (event === "silence") this.currentSoundState = "silence";
    if (!this.cueEngineEnabled) return false;
    if (!this.rundown) return false;

    const { executableItems } = buildRundownDisplay(
      this.rundown.rundown,
      this.itemStates,
      this.currentExecutableId
    );

    if (executableItems.length === 0) return false;

    const currentIdx = this.currentExecutableId
      ? executableItems.findIndex((it) => it.id === this.currentExecutableId)
      : 0;

    // 1. Check current item's cue
    if (currentIdx >= 0 && currentIdx < executableItems.length) {
      const current = executableItems[currentIdx]!;
      if (current.cue) {
        const match = this.cueMatcher.evaluate(
          current.cue as any,
          { soundEvent: event },
          current.id
        );
        if (match.matched) {
          await this.fireExecutableItem(current, match.reason);
          return true;
        }
      }
    }

    // 2. Check next item (currentIdx + 1)
    const nextIdx = currentIdx + 1;
    if (nextIdx < executableItems.length) {
      const nextItem = executableItems[nextIdx]!;
      if (nextItem.cue) {
        const match = this.cueMatcher.evaluate(
          nextItem.cue as any,
          { soundEvent: event },
          nextItem.id
        );
        if (match.matched) {
          await this.fireExecutableItem(nextItem, match.reason);
          return true;
        }
      }
    }

    // 3. Check future items that allow 'skip' or 'any' mode
    for (let idx = currentIdx + 2; idx < executableItems.length; idx++) {
      const futureItem = executableItems[idx]!;
      if (futureItem.cue && ((futureItem.cue as any).mode === "skip" || (futureItem.cue as any).mode === "any")) {
        const match = this.cueMatcher.evaluate(
          futureItem.cue as any,
          { soundEvent: event },
          futureItem.id
        );
        if (match.matched) {
          await this.fireExecutableItem(futureItem, match.reason);
          return true;
        }
      }
    }

    return false;
  }

  private async fireExecutableItem(
    item: ExecutableItem,
    reason?: string
  ): Promise<{ ok: boolean; executed: ExecutionResult[] }> {
    this.stopAlternator();
    const { executableItems, display } = buildRundownDisplay(
      this.rundown?.rundown ?? [],
      this.itemStates,
      this.currentExecutableId
    );

    const targetIdx = executableItems.findIndex((it) => it.id === item.id);

    // Update item states:
    // Items before target become completed
    // Target becomes active
    // Items after target revert from active to pending
    executableItems.forEach((it, idx) => {
      if (idx < targetIdx) {
        const s = this.itemStates.get(it.id);
        if (s === "pending" || s === "active") {
          this.itemStates.set(it.id, "completed");
        }
      } else if (idx === targetIdx) {
        this.itemStates.set(it.id, "active");
      } else {
        if (this.itemStates.get(it.id) === "active") {
          this.itemStates.set(it.id, "pending");
        }
      }
    });

    this.currentExecutableId = item.id;
    this.firedItems.add(item.id);

    // Find display line number for this item
    const displayLine = display.lines.find((l) => l.id === item.id) ?? display.lines.find((l) => l.targetId === item.id);
    const lineNum = displayLine?.line ?? item.line;

    this.eventBroker.emit("cue_fired", {
      itemId: item.id,
      title: item.title,
      line: lineNum,
      index: targetIdx,
      reason,
      timestamp: new Date().toISOString(),
    });

    this.logHistory("cue_fired", { id: item.id, line: lineNum, index: targetIdx, title: item.title, reason });

    // Inform gateway of fired line
    await this.actionDispatcher.fireLine(lineNum, item.id);

    // Execute actions
    const executed = await this.executeItemActions(item);
    this.emitState();

    return { ok: true, executed };
  }

  private async executeItemActions(item: ExecutableItem): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    for (const action of item.actions) {
      if (typeof action === "object" && action !== null && "alternate" in action) {
        const altConfig = normalizeAlternatorConfig(item.id, (action as any).alternate);
        if (altConfig) {
          this.activeAlternator = new Alternator(
            altConfig,
            async (stepActions, stepIndex) => {
              for (const act of stepActions) {
                await this.actionDispatcher.dispatch(act);
              }
              this.eventBroker.emit("alternation_step", {
                itemId: item.id,
                stepIndex,
                actions: stepActions,
                timestamp: new Date().toISOString(),
              });
              this.logHistory("alternation_step", { itemId: item.id, stepIndex, actions: stepActions });
            },
            (during) => this.checkSoundCondition(during)
          );
          this.activeAlternator.start();
        }
        results.push({ action: action as any, ok: true, target: "alternate" });
        continue;
      }

      const res = await this.actionDispatcher.dispatch(action as any);
      results.push(res);
      this.eventBroker.emit("action_executed", {
        itemId: item.id,
        action: action as any,
        ok: res.ok,
        target: res.target,
        error: res.error,
      });
      this.logHistory("action_executed", { id: item.id, action, ok: res.ok, error: res.error });
    }
    return results;
  }

  getActiveAlternator(): Alternator | null {
    return this.activeAlternator;
  }

  getSoundState(): string {
    return this.currentSoundState;
  }

  setSoundState(state: "speech" | "music" | "silence" | "unknown"): void {
    this.currentSoundState = state;
  }

  checkSoundCondition(during: SoundCondition): boolean {
    if (during === "any") return true;
    if (during === "music") return this.currentSoundState === "music";
    if (during === "speech") return this.currentSoundState === "speech";
    if (during === "silence") return this.currentSoundState === "silence";
    return true;
  }

  private stopAlternator(): void {
    if (this.activeAlternator) {
      this.activeAlternator.stop();
      this.activeAlternator = null;
    }
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
        totalLines: 0,
        currentItem: null,
        items: [],
        display: { lines: [], totalLines: 0, currentLine: null },
        variables: this.variableStore.getAll(),
        cueEngineEnabled: this.cueEngineEnabled,
        history: [...this.history],
      };
    }

    const { display, executableItems } = buildRundownDisplay(
      this.rundown.rundown,
      this.itemStates,
      this.currentExecutableId
    );

    const execIndex = this.currentExecutableId
      ? executableItems.findIndex((it) => it.id === this.currentExecutableId)
      : -1;

    const currentExec = execIndex >= 0 ? executableItems[execIndex] ?? null : null;

    const currentItem: ItemStateSnapshot | null = currentExec
      ? {
          id: currentExec.id,
          line: currentExec.line,
          index: execIndex,
          title: currentExec.title,
          section: currentExec.section,
          status: this.itemStates.get(currentExec.id) ?? "pending",
          hasCue: Boolean(currentExec.cue),
          actionCount: currentExec.actions.length,
          notes: currentExec.notes,
        }
      : null;

    const items: ItemStateSnapshot[] = executableItems.map((it, idx) => ({
      id: it.id,
      line: it.line,
      index: idx,
      title: it.title,
      section: it.section,
      status: this.itemStates.get(it.id) ?? "pending",
      hasCue: Boolean(it.cue),
      actionCount: it.actions.length,
      notes: it.notes,
    }));

    return {
      loaded: true,
      title: this.rundown.title,
      service: this.rundown.service,
      church: this.rundown.church,
      date: this.rundown.date,
      currentIndex: execIndex,
      currentLine: display.currentLine,
      totalItems: executableItems.length,
      totalLines: display.totalLines,
      currentItem,
      items,
      display,
      alternation: this.activeAlternator?.getStatus() ?? null,
      soundState: this.currentSoundState,
      variables: this.variableStore.getAll(),
      cueEngineEnabled: this.cueEngineEnabled,
      history: [...this.history],
    };
  }
}
