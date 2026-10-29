import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { resolve } from "node:path";

test("API Routes - cue engine toggle and control endpoints", async () => {
  const config: AppConfig = {
    port: 3400,
    host: "0.0.0.0",
    pigatewayUrl: "http://gateway.test",
    picamUrl: "http://cam.test",
    pilightUrl: "http://light.test",
    piprogramUrl: "http://pgm.test",
    autoConnectGateway: false,
    defaultRundownPath: resolve("d:/pirundown/examples/sunday-mass.yaml"),
  };

  const { app } = await buildApp(config, {
    fetchFn: async () => new Response(JSON.stringify({ ok: true })),
  });
  await app.ready();

  // 1. Initial status has cueEngineEnabled: true
  const initialRes = await app.inject({
    method: "GET",
    url: "/api/v1/cues",
  });
  assert.equal(initialRes.statusCode, 200);
  assert.equal(JSON.parse(initialRes.payload).enabled, true);

  // 2. Toggle cue engine off
  const toggleOffRes = await app.inject({
    method: "POST",
    url: "/api/v1/cues/toggle",
  });
  assert.equal(toggleOffRes.statusCode, 200);
  const toggleOffJson = JSON.parse(toggleOffRes.payload);
  assert.equal(toggleOffJson.ok, true);
  assert.equal(toggleOffJson.cueEngineEnabled, false);
  assert.equal(toggleOffJson.rundown.cueEngineEnabled, false);

  // 3. Status confirms cueEngineEnabled is false
  const statusRes = await app.inject({
    method: "GET",
    url: "/api/v1/status",
  });
  assert.equal(statusRes.statusCode, 200);
  assert.equal(JSON.parse(statusRes.payload).rundown.cueEngineEnabled, false);

  // 4. Explicit enable
  const enableRes = await app.inject({
    method: "POST",
    url: "/api/v1/cues/enable",
  });
  assert.equal(enableRes.statusCode, 200);
  assert.equal(JSON.parse(enableRes.payload).cueEngineEnabled, true);

  // 5. Explicit disable
  const disableRes = await app.inject({
    method: "POST",
    url: "/api/v1/cues/disable",
  });
  assert.equal(disableRes.statusCode, 200);
  assert.equal(JSON.parse(disableRes.payload).cueEngineEnabled, false);

  // 6. Rundown alias endpoint: /api/v1/rundown/cues/toggle with target enabled
  const targetRes = await app.inject({
    method: "POST",
    url: "/api/v1/rundown/cues/toggle",
    payload: { enabled: true },
  });
  assert.equal(targetRes.statusCode, 200);
  assert.equal(JSON.parse(targetRes.payload).cueEngineEnabled, true);

  await app.close();
});
