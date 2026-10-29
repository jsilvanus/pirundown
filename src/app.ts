import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { VariableStore } from "./variables/variable-store.js";
import { VarfetchEngine } from "./variables/varfetch-engine.js";
import { CueMatcher } from "./cues/cue-matcher.js";
import { ActionDispatcher } from "./actions/action-dispatcher.js";
import { RundownEventBroker } from "./events.js";
import { RundownEngine } from "./engine/rundown-engine.js";
import { GatewaySseClient } from "./engine/gateway-sse-client.js";
import { registerRoutes } from "./routes.js";
import { loadRundownFile } from "./parser/yaml-parser.js";

export interface BuildAppResult {
  app: FastifyInstance;
  engine: RundownEngine;
  variableStore: VariableStore;
  varfetchEngine: VarfetchEngine;
  eventBroker: RundownEventBroker;
  gatewayClient: GatewaySseClient;
}

export async function buildApp(config: AppConfig, options?: { fetchFn?: typeof fetch }): Promise<BuildAppResult> {
  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : true,
  });

  const variableStore = new VariableStore();
  const varfetchEngine = new VarfetchEngine(variableStore);
  const cueMatcher = new CueMatcher();
  const actionDispatcher = new ActionDispatcher(config, variableStore, varfetchEngine, options?.fetchFn);
  const eventBroker = new RundownEventBroker();

  const engine = new RundownEngine(
    variableStore,
    varfetchEngine,
    cueMatcher,
    actionDispatcher,
    eventBroker
  );

  const gatewayClient = new GatewaySseClient({
    gatewayUrl: config.pigatewayUrl,
    engine,
    fetchFn: options?.fetchFn,
    logger: app.log,
  });

  registerRoutes(app, {
    engine,
    variableStore,
    varfetchEngine,
    eventBroker,
    apiKey: config.apiKey,
  });

  // If default rundown path configured, auto-load on start
  if (config.defaultRundownPath) {
    const res = loadRundownFile(config.defaultRundownPath);
    if (res.ok && res.data) {
      await engine.load(res.data);
      app.log.info(`Auto-loaded default rundown: ${config.defaultRundownPath}`);
    } else {
      app.log.warn(`Failed to auto-load default rundown: ${res.errors?.join("; ")}`);
    }
  }

  app.addHook("onClose", async () => {
    gatewayClient.stop();
    variableStore.clear();
  });

  return {
    app,
    engine,
    variableStore,
    varfetchEngine,
    eventBroker,
    gatewayClient,
  };
}
