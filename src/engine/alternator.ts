import type { ActionItem } from "../schema/rundown-v2.js";

export type SoundCondition = "any" | "speech" | "music" | "silence";

export interface AlternatorConfig {
  itemId: string;
  minIntervalMs: number;
  maxIntervalMs: number;
  during: SoundCondition;
  steps: Array<Array<ActionItem>>;
}

export interface AlternatorStatus {
  active: boolean;
  itemId: string;
  currentStep: number;
  totalSteps: number;
  during: SoundCondition;
  intervalMs: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
}

function parseInterval(
  val: unknown,
  toMsMultiplier: number
): { minMs: number; maxMs: number } | null {
  if (typeof val === "number" && !isNaN(val) && val > 0) {
    const ms = Math.round(val * toMsMultiplier);
    return { minMs: ms, maxMs: ms };
  }
  if (Array.isArray(val) && val.length >= 2) {
    const num0 = Number(val[0]);
    const num1 = Number(val[1]);
    if (!isNaN(num0) && !isNaN(num1) && num0 > 0 && num1 > 0) {
      const min = Math.min(num0, num1);
      const max = Math.max(num0, num1);
      return {
        minMs: Math.round(min * toMsMultiplier),
        maxMs: Math.round(max * toMsMultiplier),
      };
    }
  }
  return null;
}

export function normalizeAlternatorConfig(
  itemId: string,
  altDef: unknown
): AlternatorConfig | null {
  if (!altDef || typeof altDef !== "object") return null;
  const def = altDef as any;

  const intervalRange =
    parseInterval(def.interval_ms, 1) ??
    parseInterval(def.interval_sec, 1000) ??
    parseInterval(def.interval, 1000) ??
    { minMs: 10000, maxMs: 10000 };

  const during: SoundCondition =
    def.during === "speech" || def.during === "music" || def.during === "silence"
      ? def.during
      : "any";

  const steps: Array<Array<ActionItem>> = [];

  if (Array.isArray(def.cut) && def.cut.length > 0) {
    for (const input of def.cut) {
      steps.push([{ switch: { cut: Number(input) } } as ActionItem]);
    }
  } else if (Array.isArray(def.steps) && def.steps.length > 0) {
    for (const step of def.steps) {
      if (Array.isArray(step)) {
        steps.push(step as ActionItem[]);
      } else if (step && typeof step === "object" && "actions" in step && Array.isArray(step.actions)) {
        steps.push(step.actions as ActionItem[]);
      } else if (step) {
        steps.push([step as ActionItem]);
      }
    }
  }

  if (steps.length === 0) return null;

  return {
    itemId,
    minIntervalMs: intervalRange.minMs,
    maxIntervalMs: intervalRange.maxMs,
    during,
    steps,
  };
}

export class Alternator {
  private timer: NodeJS.Timeout | null = null;
  private currentStepIndex = 0;
  private isRunning = false;

  constructor(
    private readonly config: AlternatorConfig,
    private readonly dispatchStep: (actions: ActionItem[], stepIndex: number) => Promise<void>,
    private readonly checkCondition: (during: SoundCondition) => boolean
  ) {}

  start(): void {
    if (this.isRunning || this.config.steps.length === 0) return;
    this.isRunning = true;
    this.currentStepIndex = 0;
    this.scheduleNext();
  }

  private scheduleNext(customDelayMs?: number): void {
    if (!this.isRunning) return;

    const delayMs = customDelayMs ?? this.getRandomDelayMs();
    this.timer = setTimeout(async () => {
      if (!this.isRunning) return;

      // Evaluate sound gate
      if (!this.checkCondition(this.config.during)) {
        // Condition not currently met: retry shortly (e.g. 1000ms or min interval)
        this.scheduleNext(Math.min(1000, this.config.minIntervalMs));
        return;
      }

      const nextStepIndex = (this.currentStepIndex + 1) % this.config.steps.length;
      this.currentStepIndex = nextStepIndex;
      const stepActions = this.config.steps[nextStepIndex] ?? [];
      await this.dispatchStep(stepActions, nextStepIndex);

      this.scheduleNext();
    }, delayMs);

    // Ensure timer doesn't hold the Node process open on exit
    this.timer.unref?.();
  }

  private getRandomDelayMs(): number {
    const { minIntervalMs, maxIntervalMs } = this.config;
    if (minIntervalMs >= maxIntervalMs) return minIntervalMs;
    return Math.floor(minIntervalMs + Math.random() * (maxIntervalMs - minIntervalMs + 1));
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getStatus(): AlternatorStatus {
    return {
      active: this.isRunning,
      itemId: this.config.itemId,
      currentStep: this.currentStepIndex,
      totalSteps: this.config.steps.length,
      during: this.config.during,
      intervalMs: this.config.minIntervalMs,
      minIntervalMs: this.config.minIntervalMs,
      maxIntervalMs: this.config.maxIntervalMs,
    };
  }

  /**
   * For testing or manual step triggering: steps forward immediately if condition met.
   */
  async step(): Promise<boolean> {
    if (!this.checkCondition(this.config.during)) return false;
    const nextStepIndex = (this.currentStepIndex + 1) % this.config.steps.length;
    this.currentStepIndex = nextStepIndex;
    const stepActions = this.config.steps[nextStepIndex] ?? [];
    await this.dispatchStep(stepActions, nextStepIndex);
    return true;
  }
}
