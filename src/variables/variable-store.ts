import { interpolate } from "varfetch";

export interface StoredVariable {
  name: string;
  value: string;
  source: string;
  updatedAt: number;
  expiresAt?: number;
  revertValue?: string;
}

export type VariableChangeListener = (variable: StoredVariable) => void;

export class VariableStore {
  private readonly variables = new Map<string, StoredVariable>();
  private readonly listeners = new Set<VariableChangeListener>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, val] of Object.entries(initial)) {
      this.set(key, String(val ?? ""), "init");
    }
  }

  get(name: string): string | undefined {
    const item = this.variables.get(name);
    return item?.value;
  }

  getAll(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, item] of this.variables.entries()) {
      result[key] = item.value;
    }
    return result;
  }

  set(name: string, value: string, source = "manual", ttlMs?: number, revertValue?: string): StoredVariable {
    // Clear existing timer if any
    const existingTimer = this.timers.get(name);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.timers.delete(name);
    }

    const previousValue = this.variables.get(name)?.value;
    const now = Date.now();
    const item: StoredVariable = {
      name,
      value,
      source,
      updatedAt: now,
      expiresAt: ttlMs ? now + ttlMs : undefined,
      revertValue: revertValue ?? previousValue,
    };

    this.variables.set(name, item);

    if (ttlMs && ttlMs > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(name);
        const current = this.variables.get(name);
        if (current && current.expiresAt && Date.now() >= current.expiresAt) {
          const reverted = current.revertValue ?? "";
          this.set(name, reverted, "ttl_revert");
        }
      }, ttlMs);
      timer.unref?.();
      this.timers.set(name, timer);
    }

    this.notify(item);
    return item;
  }

  interpolate(text: string): string {
    const snapshot = this.getAll();
    return interpolate(text, snapshot);
  }

  subscribe(listener: VariableChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(item: StoredVariable): void {
    for (const listener of this.listeners) {
      try {
        listener(item);
      } catch (err) {
        console.error(`Error in variable listener for '${item.name}':`, err);
      }
    }
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.variables.clear();
  }
}
