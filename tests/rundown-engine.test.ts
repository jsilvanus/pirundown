import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRundownFile } from "../src/parser/yaml-parser.js";
import { VariableStore } from "../src/variables/variable-store.js";
import { VarfetchEngine } from "../src/variables/varfetch-engine.js";
import { CueMatcher } from "../src/cues/cue-matcher.js";
import { ActionDispatcher } from "../src/actions/action-dispatcher.js";
import { RundownEventBroker, type RundownEvent } from "../src/events.js";
import { RundownEngine } from "../src/engine/rundown-engine.js";
import type { AppConfig } from "../src/config.js";
import { resolve } from "node:path";

test("RundownEngine - end-to-end service execution with sunday-mass.yaml", async () => {
  const executedCalls: Array<{ url: string; body?: unknown }> = [];
  const mockFetch: typeof fetch = async (url, init) => {
    executedCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const config: AppConfig = {
    port: 3400,
    host: "0.0.0.0",
    pigatewayUrl: "http://gateway.test",
    picamUrl: "http://cam.test",
    pilightUrl: "http://light.test",
    piprogramUrl: "http://pgm.test",
    autoConnectGateway: false,
  };

  const variableStore = new VariableStore();
  const varfetchEngine = new VarfetchEngine(variableStore);
  const cueMatcher = new CueMatcher();
  const actionDispatcher = new ActionDispatcher(config, variableStore, varfetchEngine, mockFetch);
  const eventBroker = new RundownEventBroker();

  const events: RundownEvent[] = [];
  eventBroker.subscribe((e) => events.push(e));

  const engine = new RundownEngine(
    variableStore,
    varfetchEngine,
    cueMatcher,
    actionDispatcher,
    eventBroker
  );

  // 1. Load YAML rundown
  const yamlPath = resolve("d:/pirundown/examples/sunday-mass.yaml");
  const parseResult = loadRundownFile(yamlPath);
  assert.equal(parseResult.ok, true, `YAML parse errors: ${parseResult.errors?.join("; ")}`);
  assert.ok(parseResult.data);

  await engine.load(parseResult.data);

  // Verify preflight variables loaded
  assert.equal(variableStore.get("preacher"), "Pastori Matti");
  assert.equal(variableStore.get("hymn_1"), "332");

  // Verify initial status
  let status = engine.getStatus();
  assert.equal(status.loaded, true);
  assert.equal(status.currentIndex, 0);
  assert.equal(status.currentItem?.id, "alkusoitto");
  assert.equal(status.currentItem?.status, "active");

  // 2. Sound event: music stops (Prelude ends)
  const soundMatched = await engine.onSoundEvent("music_stop");
  assert.equal(soundMatched, true);

  // Actions for alkusoitto should have executed (cam 1 altar, atem cut 1)
  assert.ok(executedCalls.some((c) => c.url.includes("/cameras/1/preset/altar")));
  assert.ok(executedCalls.some((c) => c.url.includes("/atem/cut")));

  // Pointer should have advanced to alkusiunaus
  status = engine.getStatus();
  assert.equal(status.currentIndex, 1);
  assert.equal(status.currentItem?.id, "alkusiunaus");
  assert.equal(status.currentItem?.status, "active");

  // 3. Transcript event: Priest speaks Invocatio
  const transcriptMatched = await engine.onTranscript(
    "Liturgi aloittaa Isän ja Pojan ja Pyhän Hengen nimeen olkaa hyvät"
  );
  assert.equal(transcriptMatched, true);

  // Pointer advances to alkuvirsi
  status = engine.getStatus();
  assert.equal(status.currentIndex, 2);
  assert.equal(status.currentItem?.id, "alkuvirsi");

  // 4. Manual fire: operator triggers alkuvirsi directly
  executedCalls.length = 0;
  const fireRes = await engine.fire("alkuvirsi");
  assert.equal(fireRes.ok, true);

  // Verify pipgm action executed with interpolated hymn 332
  assert.ok(executedCalls.some((c) => c.url.includes("/pipgm/hymn/332")));

  // Pointer advances to paivan_rukous
  status = engine.getStatus();
  assert.equal(status.currentIndex, 3);
  assert.equal(status.currentItem?.id, "paivan_rukous");

  // 5. Test goto
  engine.goto("saarna");
  status = engine.getStatus();
  assert.equal(status.currentItem?.id, "saarna");

  // 6. Test reset
  engine.reset();
  status = engine.getStatus();
  assert.equal(status.currentIndex, 0);
  assert.equal(status.currentItem?.id, "alkusoitto");
});
