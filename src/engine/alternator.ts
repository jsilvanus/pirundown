import type { ActionItem } from "../schema/rundown-v2.js";

export type SoundCondition = "any" | "speech" | "music" | "silence";

export interface AlternatorConfig {
  itemId: string;
  intervalMs: number;
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
}

export function normalizeAlternatorConfig(
  itemId: string,
  altDef: unknown
): AlternatorConfig | null {
  if (!altDef || typeof altDef !== "object") return null;
  const def = altDef as any;

  const intervalMs =
    typeof def.interval_ms === "number"
      ? def.interval_ms
      : typeof def.interval_sec === "number"
        ? def.interval_sec * 1000
        : typeof def.interval === "number"
          ? def.interval * 1000
          : 10000;

  const during: SoundCondition =
    def.during === "speech" || def.during === "music" || def.during === "silence"
      ? def.during
      : "any";

  const steps: Array<Array<ActionItem>> = [];

  if (Array.isArray(def.cut) && def.cut.length > 0) {
    for (const input of def.cut) {
      steps.push([{ atem: { cut: Number(input) } } as ActionItem]);
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
    intervalMs,
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

    this.timer = setInterval(async () => {
      if (!this.isRunning) return;

      // Evaluate sound gate
      if (!this.checkCondition(this.config.during)) {
        return;
      }

      const nextStepIndex = (this.currentStepIndex + 1) % this.config.steps.length;
      this.currentStepIndex = nextStepIndex;
      const stepActions = this.config.steps[nextStepIndex] ?? [];
      await this.dispatchStep(stepActions, nextStepIndex);
    }, this.config.intervalMs);

    // Ensure timer doesn't hold the Node process open on exit
    this.timer.unref?.();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
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
      intervalMs: this.config.intervalMs,
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
