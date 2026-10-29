import type { ActionItem } from "../schema/rundown-v2.js";
import type { VariableStore } from "../variables/variable-store.js";
import type { VarfetchEngine } from "../variables/varfetch-engine.js";
import type { AppConfig } from "../config.js";
import { setTimeout as sleep } from "node:timers/promises";

export interface ExecutionResult {
  action: ActionItem;
  ok: boolean;
  target?: string;
  response?: unknown;
  error?: string;
}

export class ActionDispatcher {
  private readonly config: AppConfig;
  private readonly variableStore: VariableStore;
  private readonly varfetchEngine: VarfetchEngine;
  private readonly fetchFn: typeof fetch;

  constructor(
    config: AppConfig,
    variableStore: VariableStore,
    varfetchEngine: VarfetchEngine,
    fetchFn: typeof fetch = fetch
  ) {
    this.config = config;
    this.variableStore = variableStore;
    this.varfetchEngine = varfetchEngine;
    this.fetchFn = fetchFn;
  }

  async dispatch(action: ActionItem): Promise<ExecutionResult> {
    try {
      // 1. Local-only actions: var, fetch, delay
      if (typeof action === "object" && action !== null) {
        if ("var" in action) {
          return this.dispatchVar(action.var);
        }

        if ("fetch" in action) {
          return await this.dispatchFetch(action.fetch);
        }

        if ("delay" in action) {
          await sleep(action.delay.ms);
          return { action, ok: true, target: "delay" };
        }
      }

      if (typeof action === "string") {
        const resolved = this.variableStore.interpolate(action);
        if (resolved.startsWith("var:")) {
          const eqIdx = resolved.indexOf("=");
          if (eqIdx > 0) {
            const key = resolved.slice(4, eqIdx).trim();
            const value = resolved.slice(eqIdx + 1).trim();
            return this.dispatchVar({ [key]: value });
          }
        }
        if (resolved.startsWith("fetch:")) {
          const parts = resolved.split(":");
          if (parts[1] && parts[2]) {
            return await this.dispatchFetch({ connector: parts[1], request: parts[2] });
          }
        }
        // Forward all other string shorthands to pigateway
        return await this.callGatewayAction({ action: resolved });
      }

      // 2. Gateway Device Actions (ATEM, Camera, Tally, PiPGM)
      if ("atem" in action) {
        const { cut, auto, ftb, dsk, state } = action.atem;
        if (cut !== undefined) {
          return await this.callGatewayAction({ action: "atem:cut", params: { input: cut } });
        }
        if (auto) {
          return await this.callGatewayAction({ action: "atem:auto" });
        }
        if (ftb) {
          return await this.callGatewayAction({ action: "atem:ftb" });
        }
        if (dsk !== undefined) {
          return await this.callGatewayAction({ action: "atem:dsk", params: { dskIndex: dsk, state } });
        }
      }

      if ("cam" in action) {
        const cam = action.cam;
        if (cam.preset !== undefined) {
          const preset = this.interpolateValue(cam.preset);
          return await this.callGatewayAction({
            action: "cam:preset",
            params: { id: cam.id, preset },
          });
        }
        if (cam.move) {
          return await this.callGatewayAction({
            action: "cam:move",
            params: { id: cam.id, direction: cam.move, speed: cam.speed },
          });
        }
        if (cam.zoom) {
          return await this.callGatewayAction({
            action: "cam:zoom",
            params: { id: cam.id, action: cam.zoom, speed: cam.speed },
          });
        }
      }

      if ("tally" in action) {
        const tally = action.tally;
        if (tally.cue) {
          const cue = this.interpolateValue(tally.cue);
          return await this.callGatewayAction({
            action: "tally:cue",
            params: { unit: tally.unit, cue },
          });
        }
        if (tally.state) {
          return await this.callGatewayAction({
            action: "tally:state",
            params: { unit: tally.unit, state: tally.state },
          });
        }
      }

      if ("pipgm" in action) {
        const pipgm = action.pipgm;
        if (pipgm.hymn !== undefined) {
          const hymn = this.interpolateValue(pipgm.hymn);
          return await this.callGatewayAction({
            action: "pipgm:hymn",
            params: { hymn },
          });
        }
        if (pipgm.slide !== undefined) {
          const slide = this.interpolateValue(pipgm.slide);
          return await this.callGatewayAction({
            action: "pipgm:slide",
            params: { slide },
          });
        }
      }

      return { action, ok: false, error: "Unrecognized action shape" };
    } catch (err) {
      return {
        action,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private dispatchVar(varMap: Record<string, string | number | boolean>): ExecutionResult {
    for (const [key, val] of Object.entries(varMap)) {
      const strVal = this.variableStore.interpolate(String(val));
      this.variableStore.set(key, strVal, "action");
    }
    return { action: { var: varMap }, ok: true, target: "var" };
  }

  private async dispatchFetch(fetchDef: { connector: string; request: string }): Promise<ExecutionResult> {
    const res = await this.varfetchEngine.fetch(fetchDef.connector, fetchDef.request);
    return {
      action: { fetch: fetchDef },
      ok: res.ok,
      target: `fetch:${fetchDef.connector}.${fetchDef.request}`,
      response: res.values,
      error: res.error,
    };
  }

  private async callGatewayAction(payload: {
    action: string;
    params?: Record<string, unknown>;
    actor?: string;
  }): Promise<ExecutionResult> {
    const url = `${this.config.pigatewayUrl}/api/v1/actions/execute`;
    try {
      const actor = payload.actor ?? "rundown";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Actor": actor,
      };
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }
      const fullPayload = {
        actor,
        action: payload.action,
        ...(payload.params !== undefined ? { params: payload.params } : {}),
      };
      const res = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(fullPayload),
        signal: AbortSignal.timeout(3000),
      });

      let data: any;
      try {
        data = await res.json();
      } catch {
        data = undefined;
      }

      return {
        action: payload as any,
        ok: res.ok && data?.ok !== false,
        target: data?.target ?? payload.action,
        response: data?.result ?? data,
        error: res.ok ? undefined : data?.error ?? `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        action: payload as any,
        ok: false,
        target: payload.action,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private interpolateValue(val: string | number): string {
    return this.variableStore.interpolate(String(val));
  }
}
