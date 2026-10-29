import { fireRequest, type Connector, type RequestDef } from "varfetch";
import type { VariableStore } from "./variable-store.js";
import type { ConnectorDefSchema } from "../schema/rundown-v2.js";
import { z } from "zod";

type ConnectorConfig = z.infer<typeof ConnectorDefSchema>;

export class VarfetchEngine {
  private readonly connectors = new Map<string, ConnectorConfig>();
  private readonly store: VariableStore;

  constructor(store: VariableStore) {
    this.store = store;
  }

  registerConnectors(defs: Record<string, ConnectorConfig>): void {
    for (const [name, def] of Object.entries(defs)) {
      this.connectors.set(name, def);
    }
  }

  getConnector(name: string): ConnectorConfig | undefined {
    return this.connectors.get(name);
  }

  async fetch(
    connectorName: string,
    requestName: string
  ): Promise<{ ok: boolean; values: Record<string, string | null>; error?: string }> {
    const connDef = this.connectors.get(connectorName);
    if (!connDef) {
      return { ok: false, values: {}, error: `Connector '${connectorName}' not found.` };
    }

    const reqDef = connDef.requests?.[requestName];
    if (!reqDef) {
      return {
        ok: false,
        values: {},
        error: `Request '${requestName}' not found on connector '${connectorName}'.`,
      };
    }

    const connector: Connector = {
      baseUrl: connDef.baseUrl,
      auth: connDef.auth,
      headers: connDef.headers,
    };

    const request: RequestDef = {
      method: reqDef.method,
      path: reqDef.path,
      query: reqDef.query,
      bodyType: reqDef.bodyType,
      body: reqDef.body,
      responseType: reqDef.responseType,
      mappings: reqDef.mappings,
      timeoutMs: reqDef.timeoutMs ?? 10_000,
    };

    const variables = this.store.getAll();

    const result = await fireRequest({
      connector,
      request,
      variables,
    });

    if (result.ok && result.values) {
      for (const [key, val] of Object.entries(result.values)) {
        if (val !== null && val !== undefined) {
          this.store.set(key, String(val), `varfetch:${connectorName}.${requestName}`);
        }
      }
    }

    return {
      ok: result.ok,
      values: result.values,
      error: result.error,
    };
  }
}
