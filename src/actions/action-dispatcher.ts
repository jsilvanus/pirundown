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
      if (typeof action === "string") {
        return await this.dispatchStringAction(action);
      }

      if ("atem" in action) {
        return await this.dispatchAtem(action.atem);
      }

      if ("cam" in action) {
        return await this.dispatchCam(action.cam);
      }

      if ("tally" in action) {
        return await this.dispatchTally(action.tally);
      }

      if ("pipgm" in action) {
        return await this.dispatchPipgm(action.pipgm);
      }

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

      return { action, ok: false, error: "Unrecognized action shape" };
    } catch (err) {
      return {
        action,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async dispatchAtem(atem: {
    cut?: number;
    auto?: boolean;
    dsk?: number;
    state?: "on" | "off" | "toggle";
    ftb?: boolean;
  }): Promise<ExecutionResult> {
    const base = this.config.pigatewayUrl;
    let url = "";
    let body: unknown = undefined;

    if (atem.cut !== undefined) {
      url = `${base}/api/v1/atem/cut`;
      body = { input: atem.cut };
    } else if (atem.auto) {
      url = `${base}/api/v1/atem/auto`;
      body = {};
    } else if (atem.ftb) {
      url = `${base}/api/v1/atem/ftb`;
      body = {};
    } else if (atem.dsk !== undefined) {
      url = `${base}/api/v1/atem/dsk`;
      body = { dskIndex: atem.dsk, state: atem.state ?? "toggle" };
    } else {
      return { action: { atem }, ok: false, error: "Empty ATEM action" };
    }

    const res = await this.postJson(url, body);
    return { action: { atem }, ok: res.ok, target: "atem", response: res.data, error: res.error };
  }

  private async dispatchCam(cam: {
    id: number | string;
    preset?: string | number;
    move?: "up" | "down" | "left" | "right" | "stop";
    speed?: number;
    zoom?: "in" | "out" | "stop";
  }): Promise<ExecutionResult> {
    const base = this.config.picamUrl || this.config.pigatewayUrl;
    const camId = encodeURIComponent(String(cam.id));

    if (cam.preset !== undefined) {
      const preset = encodeURIComponent(
        this.variableStore.interpolate(String(cam.preset))
      );
      const url = `${base}/api/v1/cameras/${camId}/preset/${preset}`;
      const res = await this.postJson(url, {});
      return { action: { cam }, ok: res.ok, target: "cam:preset", response: res.data, error: res.error };
    }

    if (cam.move) {
      const url = `${base}/api/v1/cameras/${camId}/move/${cam.move}`;
      const res = await this.postJson(url, { speed: cam.speed });
      return { action: { cam }, ok: res.ok, target: "cam:move", response: res.data, error: res.error };
    }

    if (cam.zoom) {
      const url = `${base}/api/v1/cameras/${camId}/zoom/${cam.zoom}`;
      const res = await this.postJson(url, { speed: cam.speed });
      return { action: { cam }, ok: res.ok, target: "cam:zoom", response: res.data, error: res.error };
    }

    return { action: { cam }, ok: false, error: "Empty camera action" };
  }

  private async dispatchTally(tally: {
    unit: number | string;
    cue?: string;
    state?: "pgm" | "prv" | "off";
  }): Promise<ExecutionResult> {
    const base = this.config.pilightUrl;
    const unit = encodeURIComponent(String(tally.unit));

    if (tally.cue) {
      const cue = encodeURIComponent(this.variableStore.interpolate(tally.cue));
      const url = `${base}/api/v1/tally/cue/${unit}/${cue}`;
      const res = await this.postJson(url, {});
      return { action: { tally }, ok: res.ok, target: "tally:cue", response: res.data, error: res.error };
    }

    if (tally.state) {
      const url = `${base}/api/v1/tally/${unit}/state`;
      const res = await this.postJson(url, { state: tally.state });
      return { action: { tally }, ok: res.ok, target: "tally:state", response: res.data, error: res.error };
    }

    return { action: { tally }, ok: false, error: "Empty tally action" };
  }

  private async dispatchPipgm(pipgm: {
    hymn?: string | number;
    slide?: string | number;
    ftb?: boolean;
  }): Promise<ExecutionResult> {
    const base = this.config.piprogramUrl;

    if (pipgm.hymn !== undefined) {
      const hymn = encodeURIComponent(
        this.variableStore.interpolate(String(pipgm.hymn))
      );
      const url = `${base}/api/v1/pipgm/hymn/${hymn}`;
      const res = await this.postJson(url, {});
      return { action: { pipgm }, ok: res.ok, target: "pipgm:hymn", response: res.data, error: res.error };
    }

    if (pipgm.slide !== undefined) {
      const slide = encodeURIComponent(
        this.variableStore.interpolate(String(pipgm.slide))
      );
      const url = `${base}/api/v1/pipgm/slide/${slide}`;
      const res = await this.postJson(url, {});
      return { action: { pipgm }, ok: res.ok, target: "pipgm:slide", response: res.data, error: res.error };
    }

    if (pipgm.ftb !== undefined) {
      const url = `${base}/api/v1/pipgm/ftb`;
      const res = await this.postJson(url, { enabled: pipgm.ftb });
      return { action: { pipgm }, ok: res.ok, target: "pipgm:ftb", response: res.data, error: res.error };
    }

    return { action: { pipgm }, ok: false, error: "Empty PiPGM action" };
  }

  private dispatchVar(varMap: Record<string, string | number | boolean>): ExecutionResult {
    for (const [key, val] of Object.entries(varMap)) {
      const strVal = this.variableStore.interpolate(String(val));
      this.variableStore.set(key, strVal, "action");
    }
    return { action: { var: varMap }, ok: true, target: "var" };
  }

  private async dispatchFetch(fetchDef: {
    connector: string;
    request: string;
  }): Promise<ExecutionResult> {
    const res = await this.varfetchEngine.fetch(fetchDef.connector, fetchDef.request);
    return {
      action: { fetch: fetchDef },
      ok: res.ok,
      target: `fetch:${fetchDef.connector}.${fetchDef.request}`,
      response: res.values,
      error: res.error,
    };
  }

  private async dispatchStringAction(shorthand: string): Promise<ExecutionResult> {
    const parts = shorthand.trim().split(":");
    const domain = parts[0]?.toLowerCase();

    if (domain === "atem" && parts[1] === "cut") {
      return this.dispatchAtem({ cut: parseInt(parts[2] ?? "1", 10) });
    }
    if (domain === "atem" && parts[1] === "auto") {
      return this.dispatchAtem({ auto: true });
    }
    if (domain === "cam" && parts[2] === "preset") {
      return this.dispatchCam({ id: parts[1] ?? "1", preset: parts[3] });
    }
    if (domain === "tally" && parts[1] === "cue") {
      return this.dispatchTally({ unit: parts[2] ?? "1", cue: parts[3] });
    }
    if (domain === "pgm" && parts[1] === "hymn") {
      return this.dispatchPipgm({ hymn: parts[2] });
    }
    if (domain === "var") {
      const eqIdx = shorthand.indexOf("=");
      if (eqIdx > 0) {
        const key = shorthand.slice(4, eqIdx).trim();
        const value = shorthand.slice(eqIdx + 1).trim();
        return this.dispatchVar({ [key]: value });
      }
    }
    if (domain === "fetch" && parts[1] && parts[2]) {
      return this.dispatchFetch({ connector: parts[1], request: parts[2] });
    }

    return { action: shorthand, ok: false, error: `Unknown string action shorthand: '${shorthand}'` };
  }

  private async postJson(url: string, body: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }
      const res = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        data = undefined;
      }
      return { ok: res.ok, data, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
