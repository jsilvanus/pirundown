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

test("Global Cues - natural language compilation ('when communion starts, do privacy blur on camera 1') and automatic section execution", async () => {
  const gatewayCalls: Array<Record<string, any>> = [];
  const config: AppConfig = {
    port: 3400,
    host: "0.0.0.0",
    pigatewayUrl: "http://gateway.test",
    picamUrl: "http://cam.test",
    pilightUrl: "http://light.test",
    piprogramUrl: "http://pgm.test",
    autoConnectGateway: false,
  };

  const { app } = await buildApp(config, {
    fetchFn: async (url, init) => {
      if (String(url).includes("/api/v1/actions/execute") && init?.body) {
        gatewayCalls.push(JSON.parse(String(init.body)));
      }
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  await app.ready();

  // 1. Load a rundown with Intro and Communion (Ehtoollinen) sections
  const loadRes = await app.inject({
    method: "POST",
    url: "/api/v1/rundown/load",
    payload: {
      yaml: `
version: 2
title: Messu
rundown:
  - id: alkusoitto
    title: Alkusoitto
    section: Johdanto
    actions: []
  - id: ehtoollisrukous
    title: Ehtoollisrukous
    section: Ehtoollinen
    actions: []
`,
    },
  });
  assert.equal(loadRes.statusCode, 200);

  // 2. Register a Global Cue from natural language: "when communion starts, do privacy blur on camera 1"
  const createCueRes = await app.inject({
    method: "POST",
    url: "/api/v1/cues/global",
    payload: {
      prompt: "when communion starts, do privacy blur on camera 1",
    },
  });
  assert.equal(createCueRes.statusCode, 200);
  const createdCue = JSON.parse(createCueRes.payload).cue;
  assert.equal(createdCue.trigger.event, "section_start");
  assert.equal(createdCue.trigger.section, "communion");
  assert.deepEqual(createdCue.actions[0], {
    cam: { id: 1, privacyBlur: true },
  });

  // 3. Advance rundown from Johdanto -> Ehtoollinen (communion)
  const nextRes = await app.inject({
    method: "POST",
    url: "/api/v1/rundown/next",
  });
  assert.equal(nextRes.statusCode, 200);

  // Allow microtask for async global cue dispatch
  await new Promise((r) => setTimeout(r, 20));

  const blurCall = gatewayCalls.find((c) => c.action === "cam:privacy_blur");
  assert.ok(blurCall, "Expected cam:privacy_blur action to be dispatched when communion starts");
  assert.deepEqual(blurCall.params, { id: 1, enabled: true });

  await app.close();
});
