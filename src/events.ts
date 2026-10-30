import { EventEmitter } from "node:events";

export type RundownEventType =
  | "rundown_state"
  | "cue_fired"
  | "global_cue_fired"
  | "global_cues_updated"
  | "cue_engine_toggled"
  | "action_executed"
  | "variable_updated"
  | "alternation_step";

export interface RundownEvent {
  type: RundownEventType;
  data: unknown;
  timestamp: string;
}

export class RundownEventBroker {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(type: RundownEventType, data: unknown): void {
    const event: RundownEvent = {
      type,
      data,
      timestamp: new Date().toISOString(),
    };
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: RundownEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount("event");
  }
}
