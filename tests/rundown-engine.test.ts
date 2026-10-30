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
  const executedCalls: Array<{ url: string; body?: any }> = [];
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

  // 2. Sound event: music stops (Prelude triggers alkusoitto / line 1)
  const soundMatched = await engine.onSoundEvent("music_stop");
  assert.equal(soundMatched, true);

  // Actions for alkusoitto should have dispatched to gateway execute
  assert.ok(executedCalls.some((c) => c.url.includes("/actions/execute") && c.body?.action === "cam:preset" && c.body?.actor === "rundown"));
  assert.ok(executedCalls.some((c) => c.url.includes("/actions/execute") && c.body?.action === "atem:cut" && c.body?.actor === "rundown"));

  // Line 1 fired: pointer moves to line 1 and remains active while playing
  status = engine.getStatus();
  assert.equal(status.currentIndex, 0);
  assert.equal(status.currentLine, 1);
  assert.equal(status.currentItem?.id, "alkusoitto");
  assert.equal(status.currentItem?.status, "active");

  // 3. Transcript event: Priest speaks Invocatio for line 2 (alkusiunaus)
  const transcriptMatched = await engine.onTranscript(
    "Liturgi aloittaa Isän ja Pojan ja Pyhän Hengen nimeen olkaa hyvät"
  );
  assert.equal(transcriptMatched, true);

  // Line 2 fired: pointer moves to line 2 (alkusiunaus), line 1 becomes completed
  status = engine.getStatus();
  assert.equal(status.currentIndex, 1);
  assert.equal(status.currentLine, 2);
  assert.equal(status.currentItem?.id, "alkusiunaus");
  assert.equal(status.currentItem?.status, "active");
  assert.equal(status.items[0]?.status, "completed");

  // 4. Manual fire: operator triggers line 3 (alkuvirsi) directly
  executedCalls.length = 0;
  const fireRes = await engine.fire("alkuvirsi");
  assert.equal(fireRes.ok, true);

  // Verify pipgm action dispatched to gateway with interpolated hymn 332
  assert.ok(
    executedCalls.some(
      (c) =>
        c.url.includes("/actions/execute") &&
        c.body?.action === "pipgm:hymn" &&
        c.body?.params?.hymn === "332"
    )
  );

  // Line 3 fired: pointer moves to line 3 (alkuvirsi)
  status = engine.getStatus();
  assert.equal(status.currentIndex, 2);
  assert.equal(status.currentLine, 3);
  assert.equal(status.currentItem?.id, "alkuvirsi");
  assert.equal(status.currentItem?.status, "active");
  assert.equal(status.items[1]?.status, "completed");

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

test("RundownEngine - operator toggle cue engine on and off for pure human control", async () => {
  const executedCalls: Array<{ url: string; body?: any }> = [];
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

  const events: any[] = [];
  eventBroker.subscribe((e) => events.push(e));

  const engine = new RundownEngine(variableStore, varfetchEngine, cueMatcher, actionDispatcher, eventBroker);

  const yamlPath = resolve("d:/pirundown/examples/sunday-mass.yaml");
  const parseResult = loadRundownFile(yamlPath);
  assert.equal(parseResult.ok, true);
  await engine.load(parseResult.data!);

  // By default, cue engine is enabled
  assert.equal(engine.isCueEngineEnabled(), true);
  assert.equal(engine.getStatus().cueEngineEnabled, true);

  // 1. Operator toggles cue engine OFF for pure human control
  const stateAfterToggle = engine.toggleCueEngine();
  assert.equal(stateAfterToggle, false);
  assert.equal(engine.isCueEngineEnabled(), false);
  assert.equal(engine.getStatus().cueEngineEnabled, false);

  // Verify event emitted
  const toggleEvents = events.filter((e) => e.type === "cue_engine_toggled");
  assert.equal(toggleEvents.length, 1);
  assert.deepEqual(toggleEvents[0].data, { enabled: false });

  // 2. While OFF, incoming sound events are ignored
  executedCalls.length = 0;
  const soundMatched = await engine.onSoundEvent("music_stop");
  assert.equal(soundMatched, false);
  assert.equal(engine.getStatus().currentIndex, 0); // Still at item 0
  assert.equal(executedCalls.length, 0); // No actions fired

  // 3. While OFF, incoming transcript cues are ignored
  const transcriptMatched = await engine.onTranscript("Liturgi aloittaa Isän ja Pojan ja Pyhän Hengen nimeen");
  assert.equal(transcriptMatched, false);
  assert.equal(engine.getStatus().currentIndex, 0); // Still at item 0
  assert.equal(executedCalls.length, 0);

  // 4. Pure human control: manual operations STILL WORK
  const advanced = await engine.next();
  assert.equal(advanced, true);
  assert.equal(engine.getStatus().currentIndex, 1);

  // Manual fire executes actions even when cue engine is OFF
  const fireRes = await engine.fire();
  assert.equal(fireRes.ok, true);
  assert.ok(executedCalls.length > 0);

  // 5. Operator turns cue engine back ON
  engine.setCueEngineEnabled(true);
  assert.equal(engine.isCueEngineEnabled(), true);
  assert.equal(engine.getStatus().cueEngineEnabled, true);

  // Advance to an item with cue
  engine.goto("alkusiunaus");
  executedCalls.length = 0;
  const reenabledMatch = await engine.onTranscript("Liturgi aloittaa Isän ja Pojan ja Pyhän Hengen nimeen");
  assert.equal(reenabledMatch, true);
  assert.ok(executedCalls.length > 0);
});

test("RundownEngine - line 17 fires and pointer moves to line 17", async () => {
  const variableStore = new VariableStore();
  const varfetchEngine = new VarfetchEngine(variableStore);
  const cueMatcher = new CueMatcher();
  const actionDispatcher = new ActionDispatcher(
    { pigatewayUrl: "http://gateway.test" } as any,
    variableStore,
    varfetchEngine,
    async () => new Response(JSON.stringify({ ok: true }))
  );
  const eventBroker = new RundownEventBroker();
  const engine = new RundownEngine(
    variableStore,
    varfetchEngine,
    cueMatcher,
    actionDispatcher,
    eventBroker
  );

  const items = Array.from({ length: 25 }, (_, i) => ({
    id: `item-${i + 1}`,
    title: `Item ${i + 1}`,
    actions: [],
  }));

  await engine.load({
    version: 2,
    title: "Large Rundown",
    rundown: items,
  } as any);

  // pirundown says line 17 fires!
  const res = await engine.fire(17);
  assert.equal(res.ok, true);

  const status = engine.getStatus();
  assert.equal(status.currentIndex, 16);
  assert.equal(status.currentLine, 17);
  assert.equal(status.currentItem?.id, "item-17");
  assert.equal(status.currentItem?.status, "active");

  // Items before line 17 are completed
  for (let idx = 0; idx < 16; idx++) {
    assert.equal(status.items[idx]?.status, "completed");
  }

  // Items after line 17 are pending
  for (let idx = 17; idx < 25; idx++) {
    assert.equal(status.items[idx]?.status, "pending");
  }
});
