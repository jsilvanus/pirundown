import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RundownEngine } from "./engine/rundown-engine.js";
import type { VariableStore } from "./variables/variable-store.js";
import type { VarfetchEngine } from "./variables/varfetch-engine.js";
import type { RundownEventBroker } from "./events.js";
import type { RundownStorage } from "./storage/rundown-storage.js";
import type { ActionDispatcher } from "./actions/action-dispatcher.js";
import { ActionItemSchema } from "./schema/rundown-v2.js";
import { parseRundownYaml, loadRundownFile } from "./parser/yaml-parser.js";

export interface RegisterRoutesOptions {
  engine: RundownEngine;
  variableStore: VariableStore;
  varfetchEngine: VarfetchEngine;
  eventBroker: RundownEventBroker;
  storage: RundownStorage;
  actionDispatcher?: ActionDispatcher;
  apiKey?: string | undefined;
}

export function registerRoutes(app: FastifyInstance, options: RegisterRoutesOptions): void {
  const { engine, variableStore, varfetchEngine, eventBroker, storage, actionDispatcher, apiKey } = options;

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

  app.post<{ Body?: { target?: string | number; line?: number; id?: string } }>("/api/v1/rundown/fire", { preHandler: requireAuth }, async (req, reply) => {
    const target = req.body?.line !== undefined ? req.body.line : req.body?.id ?? req.body?.target;
    const result = await engine.fire(target);
    if (!result.ok) {
      return reply.status(404).send({ error: "Rundown item not found or out of bounds." });
    }
    return { ok: true, executed: result.executed, rundown: engine.getStatus() };
  });

  app.post<{ Params: { id: string } }>("/api/v1/rundown/fire/:id", { preHandler: requireAuth }, async (req, reply) => {
    const result = await engine.fire(req.params.id);
    if (!result.ok) {
      return reply.status(404).send({ error: `Rundown item '${req.params.id}' not found.` });
    }
    return { ok: true, executed: result.executed, rundown: engine.getStatus() };
  });

  // Action Dispatch endpoint (execute or dry-run a single action or shorthand)
  app.post<{ Body: { action: unknown; dryRun?: boolean } }>(
    "/api/v1/actions/dispatch",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { action, dryRun } = req.body ?? {};
      if (action === undefined || action === null) {
        return reply.status(400).send({ error: "Missing 'action' in request body." });
      }

      const parseResult = ActionItemSchema.safeParse(action);
      if (!parseResult.success) {
        return reply.status(422).send({ error: "Invalid action schema", details: parseResult.error.format() });
      }

      if (dryRun) {
        return { ok: true, dryRun: true, action: parseResult.data };
      }

      if (actionDispatcher) {
        const result = await actionDispatcher.dispatch(parseResult.data);
        return { ok: result.ok, result };
      }

      return reply.status(501).send({ error: "ActionDispatcher not configured on this server." });
    }
  );

  // Cue Engine control: toggle, enable, disable, status
  app.get("/api/v1/cues", async () => ({
    enabled: engine.isCueEngineEnabled(),
  }));

  app.get("/api/v1/rundown/cues", async () => ({
    enabled: engine.isCueEngineEnabled(),
  }));

  app.post<{ Body?: { enabled?: boolean } }>(
    "/api/v1/cues/toggle",
    { preHandler: requireAuth },
    async (req) => {
      const targetEnabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined;
      const enabled = targetEnabled !== undefined
        ? engine.setCueEngineEnabled(targetEnabled)
        : engine.toggleCueEngine();
      return { ok: true, cueEngineEnabled: enabled, rundown: engine.getStatus() };
    }
  );

  app.post<{ Body?: { enabled?: boolean } }>(
    "/api/v1/rundown/cues/toggle",
    { preHandler: requireAuth },
    async (req) => {
      const targetEnabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined;
      const enabled = targetEnabled !== undefined
        ? engine.setCueEngineEnabled(targetEnabled)
        : engine.toggleCueEngine();
      return { ok: true, cueEngineEnabled: enabled, rundown: engine.getStatus() };
    }
  );

  app.post("/api/v1/cues/enable", { preHandler: requireAuth }, async () => {
    const enabled = engine.setCueEngineEnabled(true);
    return { ok: true, cueEngineEnabled: enabled, rundown: engine.getStatus() };
  });

  app.post("/api/v1/cues/disable", { preHandler: requireAuth }, async () => {
    const enabled = engine.setCueEngineEnabled(false);
    return { ok: true, cueEngineEnabled: enabled, rundown: engine.getStatus() };
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

  // 6. Rundown Storage Endpoints (for pirundown-designer and operator archiving)
  const listStorageHandler = async () => {
    const items = storage.list();
    const currentStatus = engine.getStatus();
    const currentTitle = currentStatus.title;

    const enriched = items.map((item) => ({
      ...item,
      active: Boolean(currentStatus.loaded && item.title === currentTitle),
    }));

    return {
      ok: true,
      count: enriched.length,
      storageDirectory: storage.getStorageDirectory(),
      rundowns: enriched,
    };
  };

  app.get("/api/v1/storage", listStorageHandler);
  app.get("/api/v1/storage/rundowns", listStorageHandler);

  app.get<{ Params: { id: string } }>("/api/v1/storage/:id", async (req, reply) => {
    const detail = storage.get(req.params.id);
    if (!detail) {
      return reply.status(404).send({ error: `Rundownia '${req.params.id}' ei löydy tallennustilasta.` });
    }

    const acceptHeader = req.headers.accept;
    if (acceptHeader?.includes("text/yaml") || acceptHeader?.includes("application/yaml")) {
      reply.type("text/yaml; charset=utf-8").send(detail.yaml);
      return;
    }

    const currentStatus = engine.getStatus();
    return {
      ok: true,
      rundown: {
        ...detail,
        active: Boolean(currentStatus.loaded && detail.title === currentStatus.title),
      },
    };
  });

  app.post<{ Body: { id?: string; name?: string; yaml: string; load?: boolean } }>(
    "/api/v1/storage",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, name, yaml, load } = req.body ?? {};
      if (!yaml) {
        return reply.status(400).send({ error: "Kenttä 'yaml' on pakollinen." });
      }

      const saveId = id || name;
      const res = storage.save(saveId, yaml);
      if (!res.ok || !res.item) {
        return reply.status(422).send({ error: res.error || "Tallennus epäonnistui." });
      }

      let loaded = false;
      if (load && res.item.data) {
        await engine.load(res.item.data);
        loaded = true;
      }

      return {
        ok: true,
        item: res.item,
        loaded,
        currentRundown: loaded ? engine.getStatus() : undefined,
      };
    }
  );

  app.put<{ Params: { id: string }; Body: { yaml: string; load?: boolean } }>(
    "/api/v1/storage/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { yaml, load } = req.body ?? {};
      if (!yaml) {
        return reply.status(400).send({ error: "Kenttä 'yaml' on pakollinen." });
      }

      const res = storage.save(req.params.id, yaml);
      if (!res.ok || !res.item) {
        return reply.status(422).send({ error: res.error || "Tallennus epäonnistui." });
      }

      let loaded = false;
      if (load && res.item.data) {
        await engine.load(res.item.data);
        loaded = true;
      }

      return {
        ok: true,
        item: res.item,
        loaded,
        currentRundown: loaded ? engine.getStatus() : undefined,
      };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/storage/:id/load",
    { preHandler: requireAuth },
    async (req, reply) => {
      const detail = storage.get(req.params.id);
      if (!detail) {
        return reply.status(404).send({ error: `Rundownia '${req.params.id}' ei löydy tallennustilasta.` });
      }

      if (!detail.data) {
        return reply.status(422).send({ error: "Tallennetun rundownin tiedosto ei sisällä kelvollista dataa." });
      }

      await engine.load(detail.data);
      return {
        ok: true,
        loadedId: detail.id,
        rundown: engine.getStatus(),
      };
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/storage/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const deleted = storage.delete(req.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: `Rundownia '${req.params.id}' ei löydy poistettavaksi.` });
      }
      return { ok: true, deleted: true, id: req.params.id };
    }
  );
}
