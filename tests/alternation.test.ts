import { test } from "node:test";
import assert from "node:assert/strict";
import { RundownEngine } from "../src/engine/rundown-engine.js";
import { VariableStore } from "../src/variables/variable-store.js";
import { VarfetchEngine } from "../src/variables/varfetch-engine.js";
import { CueMatcher } from "../src/cues/cue-matcher.js";
import { ActionDispatcher } from "../src/actions/action-dispatcher.js";
import { RundownEventBroker } from "../src/events.js";

test("Alternation - deterministic action alternation between cam 1 and cam 2", async () => {
  const executedCalls: Array<{ url: string; body?: any }> = [];
  const mockFetch: typeof fetch = async (url, init) => {
    executedCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const store = new VariableStore();
  const engine = new VarfetchEngine(store);
  const matcher = new CueMatcher();
  const dispatcher = new ActionDispatcher(
    { pigatewayUrl: "http://gateway.test" } as any,
    store,
    engine,
    mockFetch
  );
  const broker = new RundownEventBroker();
  const rundownEngine = new RundownEngine(store, engine, matcher, dispatcher, broker);

  // Service item:
  // Set cam 1 to preset 1, set cam 2 to preset 2, cut to cam 1,
  // alternate every 10 seconds between cam 1 and cam 2
  await rundownEngine.load({
    version: 2,
    title: "Alternation Test",
    rundown: [
      {
        id: "dialogue",
        title: "Vuoropuhelu",
        actions: [
          { cam: { id: 1, preset: 1 } },
          { cam: { id: 2, preset: 2 } },
          { atem: { cut: 1 } },
          {
            alternate: {
              interval_sec: 10,
              during: "any",
              cut: [1, 2],
            },
          },
        ],
      },
    ],
  } as any);

  // Fire dialogue item
  executedCalls.length = 0;
  await rundownEngine.fire("dialogue");

  // Initial actions executed: cam 1 preset 1, cam 2 preset 2, cut 1
  assert.ok(executedCalls.some((c) => c.body?.action === "cam:preset" && Number(c.body?.params?.id) === 1));
  assert.ok(executedCalls.some((c) => c.body?.action === "cam:preset" && Number(c.body?.params?.id) === 2));
  assert.ok(executedCalls.some((c) => c.body?.action === "atem:cut" && Number(c.body?.params?.input) === 1));

  // Alternator is active
  const alternator = rundownEngine.getActiveAlternator();
  assert.ok(alternator);
  assert.equal(alternator.getStatus().active, true);
  assert.equal(alternator.getStatus().totalSteps, 2);

  // Step 1: cuts to Cam 2
  executedCalls.length = 0;
  await alternator.step();
  assert.equal(executedCalls.length, 1);
  assert.equal(executedCalls[0]?.body?.action === "atem:cut" && executedCalls[0]?.body?.params?.input, 2);

  // Step 2: cuts back to Cam 1
  executedCalls.length = 0;
  await alternator.step();
  assert.equal(executedCalls.length, 1);
  assert.equal(executedCalls[0]?.body?.action === "atem:cut" && executedCalls[0]?.body?.params?.input, 1);

  // Step 3: cuts back to Cam 2
  executedCalls.length = 0;
  await alternator.step();
  assert.equal(executedCalls.length, 1);
  assert.equal(executedCalls[0]?.body?.action === "atem:cut" && executedCalls[0]?.body?.params?.input, 2);

  // Stopping / advancing stops alternator
  await rundownEngine.next();
  assert.equal(rundownEngine.getActiveAlternator(), null);
});

test("Alternation - sound conditions: only during music", async () => {
  const executedCalls: Array<{ url: string; body?: any }> = [];
  const mockFetch: typeof fetch = async (url, init) => {
    executedCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const store = new VariableStore();
  const engine = new VarfetchEngine(store);
  const matcher = new CueMatcher();
  const dispatcher = new ActionDispatcher(
    { pigatewayUrl: "http://gateway.test" } as any,
    store,
    engine,
    mockFetch
  );
  const broker = new RundownEventBroker();
  const rundownEngine = new RundownEngine(store, engine, matcher, dispatcher, broker);

  await rundownEngine.load({
    version: 2,
    title: "Hymn Alternation Test",
    rundown: [
      {
        id: "hymn",
        title: "Alkuvirsi",
        actions: [
          { atem: { cut: 1 } },
          {
            alternate: {
              interval_sec: 12,
              during: "music",
              steps: [
                { actions: [{ atem: { cut: 1 } }, "cam:2:preset:congregation"] },
                { actions: [{ atem: { cut: 2 } }, "cam:1:preset:altar"] },
              ],
            },
          },
        ],
      },
    ],
  } as any);

  await rundownEngine.fire("hymn");
  const alternator = rundownEngine.getActiveAlternator();
  assert.ok(alternator);

  // Sound state is currently unknown/silence -> condition not met
  executedCalls.length = 0;
  const steppedBeforeMusic = await alternator.step();
  assert.equal(steppedBeforeMusic, false);
  assert.equal(executedCalls.length, 0);

  // Music starts!
  await rundownEngine.onSoundEvent("music_start");
  assert.equal(rundownEngine.getSoundState(), "music");

  // Step fires now that music is active
  executedCalls.length = 0;
  const steppedDuringMusic = await alternator.step();
  assert.equal(steppedDuringMusic, true);
  assert.ok(executedCalls.some((c) => c.body?.action === "atem:cut" && c.body?.params?.input === 2));

  // Music stops -> condition no longer met
  await rundownEngine.onSoundEvent("music_stop");
  assert.equal(rundownEngine.getSoundState(), "silence");

  executedCalls.length = 0;
  const steppedAfterMusic = await alternator.step();
  assert.equal(steppedAfterMusic, false);
  assert.equal(executedCalls.length, 0);

  rundownEngine.reset();
});

test("Alternation - sound conditions: only during speech and silence", async () => {
  const store = new VariableStore();
  const engine = new VarfetchEngine(store);
  const matcher = new CueMatcher();
  const dispatcher = new ActionDispatcher(
    { pigatewayUrl: "http://gateway.test" } as any,
    store,
    engine,
    async () => new Response(JSON.stringify({ ok: true }))
  );
  const broker = new RundownEventBroker();
  const rundownEngine = new RundownEngine(store, engine, matcher, dispatcher, broker);

  // Test during: speech
  rundownEngine.setSoundState("speech");
  assert.equal(rundownEngine.checkSoundCondition("speech"), true);
  assert.equal(rundownEngine.checkSoundCondition("music"), false);
  assert.equal(rundownEngine.checkSoundCondition("silence"), false);
  assert.equal(rundownEngine.checkSoundCondition("any"), true);

  // Test during: silence
  rundownEngine.setSoundState("silence");
  assert.equal(rundownEngine.checkSoundCondition("speech"), false);
  assert.equal(rundownEngine.checkSoundCondition("silence"), true);
  assert.equal(rundownEngine.checkSoundCondition("music"), false);
});

test("Alternation - randomized interval range [10, 20] seconds", async () => {
  const executedCalls: Array<{ url: string; body?: any }> = [];
  const mockFetch: typeof fetch = async (url, init) => {
    executedCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const store = new VariableStore();
  const engine = new VarfetchEngine(store);
  const matcher = new CueMatcher();
  const dispatcher = new ActionDispatcher(
    { pigatewayUrl: "http://gateway.test" } as any,
    store,
    engine,
    mockFetch
  );
  const broker = new RundownEventBroker();
  const rundownEngine = new RundownEngine(store, engine, matcher, dispatcher, broker);

  await rundownEngine.load({
    version: 2,
    title: "Randomized Alternation Test",
    rundown: [
      {
        id: "sermon",
        title: "Saarna",
        actions: [
          {
            alternate: {
              interval_sec: [10, 20],
              during: "speech",
              cut: [1, 2],
            },
          },
        ],
      },
    ],
  } as any);

  await rundownEngine.fire("sermon");
  const alternator = rundownEngine.getActiveAlternator();
  assert.ok(alternator);

  const status = alternator.getStatus();
  assert.equal(status.active, true);
  assert.equal(status.minIntervalMs, 10000);
  assert.equal(status.maxIntervalMs, 20000);
  assert.equal(status.during, "speech");

  // Display summary shows the range
  const rundownStatus = rundownEngine.getStatus();
  const line = rundownStatus.display?.lines.find((l) => l.id === "sermon");
  assert.ok(line);
  assert.ok(line.actionsSummary.some((s) => s.includes("10-20s") && s.includes("cut [1, 2]")));

  rundownEngine.reset();
});
