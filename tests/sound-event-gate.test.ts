import { test } from "node:test";
import assert from "node:assert/strict";
import { RundownEngine } from "../src/engine/rundown-engine.js";
import { VariableStore } from "../src/variables/variable-store.js";
import { VarfetchEngine } from "../src/variables/varfetch-engine.js";
import { CueMatcher } from "../src/cues/cue-matcher.js";
import { ActionDispatcher } from "../src/actions/action-dispatcher.js";
import { RundownEventBroker } from "../src/events.js";

function setup() {
  const store = new VariableStore();
  const varfetch = new VarfetchEngine(store);
  const matcher = new CueMatcher();
  const dispatcher = new ActionDispatcher(
    { pigatewayUrl: "http://gateway.test" } as any,
    store,
    varfetch,
    (async () => new Response("{}", { status: 200 })) as typeof fetch
  );
  const engine = new RundownEngine(store, varfetch, matcher, dispatcher, new RundownEventBroker());
  // Spy: each display build iterates the rundown array.
  let evaluations = 0;
  const origEvaluate = matcher.evaluate.bind(matcher);
  matcher.evaluate = ((...args: Parameters<CueMatcher["evaluate"]>) => {
    evaluations++;
    return origEvaluate(...args);
  }) as CueMatcher["evaluate"];
  return { engine, matcher, evals: () => evaluations };
}

function doc(items: unknown[]): any {
  return { version: 2, title: "t", rundown: items, connectors: {}, global_cues: [] };
}

/** Counts how often the rundown array is walked (= buildRundownDisplay calls). */
function watchWalks(d: any): { walks: () => number } {
  let walks = 0;
  const arr = d.rundown;
  d.rundown = new Proxy(arr, {
    get(t, p, r) {
      if (p === Symbol.iterator) walks++;
      return Reflect.get(t, p, r);
    },
  });
  return { walks: () => walks };
}

const phraseItem = (id: string) => ({ id, title: id, cue: { type: "phrase", phrase: "x" }, actions: [] });

test("onSoundEvent without sound cues: no display build, no cue evaluation, state still updated", async () => {
  const { engine, evals } = setup();
  const d = doc([phraseItem("a"), phraseItem("b")]);
  await engine.load(d);
  const w = watchWalks(d);
  for (let i = 0; i < 50; i++) assert.equal(await engine.onSoundEvent("silence"), false);
  assert.equal(w.walks(), 0);
  assert.equal(evals(), 0);
  assert.equal(engine.getSoundState(), "silence");
  await engine.onSoundEvent("music_start");
  assert.equal(engine.getSoundState(), "music");
});

test("onSoundEvent with a sound cue still evaluates (and a composite with a sound condition counts)", async () => {
  const { engine, evals } = setup();
  await engine.load(
    doc([
      { id: "a", title: "a", cue: { type: "manual" }, actions: [] },
      { id: "b", title: "b", cue: { type: "any", conditions: [{ type: "sound", event: "music_start" }] }, actions: [] },
    ])
  );
  assert.equal(await engine.onSoundEvent("music_start"), true);
  assert.ok(evals() > 0);
  assert.equal(engine.getStatus().currentItem?.id, "b");
});

test("level-triggered silence cue after advance while the room is already quiet", async () => {
  const { engine } = setup();
  await engine.load(
    doc([
      { id: "a", title: "a", cue: { type: "manual" }, actions: [] },
      { id: "b", title: "b", cue: { type: "sound", event: "silence", cooldown_ms: 0 }, actions: [] },
    ])
  );
  // Room already quiet; a is current, b is next: next-item silence cue fires on the next telemetry tick.
  assert.equal(await engine.onSoundEvent("silence"), true);
  assert.equal(engine.getStatus().currentItem?.id, "b");
});

test("sound-cue flag refreshes when a different rundown is loaded", async () => {
  const { engine, evals } = setup();
  await engine.load(doc([phraseItem("a")]));
  await engine.onSoundEvent("silence");
  assert.equal(evals(), 0);
  await engine.load(doc([{ id: "a", title: "a", cue: { type: "sound", event: "silence" }, actions: [] }]));
  await engine.onSoundEvent("silence");
  assert.ok(evals() > 0);
  await engine.load(doc([phraseItem("a")]));
  const before = evals();
  await engine.onSoundEvent("silence");
  assert.equal(evals(), before);
});
