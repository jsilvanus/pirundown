import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RundownEngine } from "./engine/rundown-engine.js";
import type { VariableStore } from "./variables/variable-store.js";
import type { VarfetchEngine } from "./variables/varfetch-engine.js";
import type { RundownEventBroker } from "./events.js";
import { parseRundownYaml, loadRundownFile } from "./parser/yaml-parser.js";

export interface RegisterRoutesOptions {
  engine: RundownEngine;
  variableStore: VariableStore;
  varfetchEngine: VarfetchEngine;
  eventBroker: RundownEventBroker;
  apiKey?: string | undefined;
}

export function registerRoutes(app: FastifyInstance, options: RegisterRoutesOptions): void {
  const { engine, variableStore, varfetchEngine, eventBroker, apiKey } = options;

  // Simple auth check for mutating calls if apiKey configured
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!apiKey) return;
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.headers["x-api-key"];
    if (token !== apiKey) {
      reply.status(401).send({ error: "Unauthorized" });
    }
  };

  // 1. Health & Status
  app.get("/health", async () => ({ status: "ok", service: "pirundown" }));

  app.get("/api/v1/status", async () => {
    const status = engine.getStatus();
    return {
      service: "pirundown",
      status: "ok",
      rundown: status,
    };
  });

  // 2. Server-Sent Events (SSE)
  app.get("/api/v1/events", (req, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders?.();

    // Initial state event
    const initial = JSON.stringify({ type: "rundown_state", data: engine.getStatus() });
    reply.raw.write(`event: rundown_state\ndata: ${initial}\n\n`);

    const unsubscribe = eventBroker.subscribe((event) => {
      const payload = JSON.stringify(event);
      reply.raw.write(`event: ${event.type}\ndata: ${payload}\n\n`);
    });

    req.raw.on("close", () => {
      unsubscribe();
    });
  });

  // 3. Rundown Operations
  app.get("/api/v1/rundown", async () => engine.getStatus());

  app.post("/api/v1/rundown/load", { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { yaml?: string; path?: string };
    let parseResult;

    if (body.yaml) {
      parseResult = parseRundownYaml(body.yaml);
    } else if (body.path) {
      parseResult = loadRundownFile(body.path);
    } else {
      return reply.status(400).send({ error: "Must provide 'yaml' string or 'path' string in body." });
    }

    if (!parseResult.ok || !parseResult.data) {
      return reply.status(422).send({ error: "Invalid Rundown v2 document", details: parseResult.errors });
    }

    await engine.load(parseResult.data);
    return { ok: true, rundown: engine.getStatus() };
  });

  app.post("/api/v1/rundown/reset", { preHandler: requireAuth }, async () => {
    engine.reset();
    return { ok: true, rundown: engine.getStatus() };
  });

  app.post("/api/v1/rundown/next", { preHandler: requireAuth }, async () => {
    const advanced = await engine.next();
    return { ok: true, advanced, rundown: engine.getStatus() };
  });

  app.post("/api/v1/rundown/previous", { preHandler: requireAuth }, async () => {
    const moved = engine.previous();
    return { ok: true, moved, rundown: engine.getStatus() };
  });

  app.post<{ Params: { id: string } }>("/api/v1/rundown/goto/:id", { preHandler: requireAuth }, async (req, reply) => {
    const moved = engine.goto(req.params.id);
    if (!moved) {
      return reply.status(404).send({ error: `Rundown item '${req.params.id}' not found.` });
    }
    return { ok: true, rundown: engine.getStatus() };
  });

  app.post<{ Body?: { id?: string } }>("/api/v1/rundown/skip", { preHandler: requireAuth }, async (req) => {
    const skipped = engine.skip(req.body?.id);
    return { ok: skipped, rundown: engine.getStatus() };
  });

  app.post<{ Params: { id: string } }>("/api/v1/rundown/fire/:id", { preHandler: requireAuth }, async (req, reply) => {
    const result = await engine.fire(req.params.id);
    if (!result.ok) {
      return reply.status(404).send({ error: `Rundown item '${req.params.id}' not found.` });
    }
    return { ok: true, executed: result.executed, rundown: engine.getStatus() };
  });

  // 4. Variables & Varfetch
  app.get("/api/v1/variables", async () => ({
    variables: variableStore.getAll(),
  }));

  app.post<{ Body: { name: string; value: string; ttlMs?: number } }>(
    "/api/v1/variables/set",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { name, value, ttlMs } = req.body ?? {};
      if (!name) return reply.status(400).send({ error: "Missing variable name" });
      const item = variableStore.set(name, String(value ?? ""), "api", ttlMs);
      return { ok: true, variable: item };
    }
  );

  app.post<{ Body: { connector: string; request: string } }>(
    "/api/v1/variables/fetch",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { connector, request } = req.body ?? {};
      if (!connector || !request) {
        return reply.status(400).send({ error: "Must specify 'connector' and 'request'." });
      }
      const res = await varfetchEngine.fetch(connector, request);
      if (!res.ok) {
        return reply.status(502).send({ error: res.error, values: res.values });
      }
      return { ok: true, values: res.values };
    }
  );

  // 5. Test/Simulation Hooks
  app.post<{ Body: { text: string } }>("/api/v1/test/transcript", async (req, reply) => {
    const text = req.body?.text;
    if (!text) return reply.status(400).send({ error: "Missing transcript text" });
    const matched = await engine.onTranscript(text);
    return { ok: true, matched, rundown: engine.getStatus() };
  });

  app.post<{ Body: { event: "music_start" | "music_stop" | "speech_start" | "speech_stop" | "silence" } }>(
    "/api/v1/test/sound",
    async (req, reply) => {
      const event = req.body?.event;
      if (!event) return reply.status(400).send({ error: "Missing sound event" });
      const matched = await engine.onSoundEvent(event);
      return { ok: true, matched, rundown: engine.getStatus() };
    }
  );
}
