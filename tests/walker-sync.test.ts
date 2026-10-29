import { test } from "node:test";
import assert from "node:assert/strict";
import { RundownEngine } from "../src/engine/rundown-engine.js";
import { VariableStore } from "../src/variables/variable-store.js";
import { VarfetchEngine } from "../src/variables/varfetch-engine.js";
import { CueMatcher } from "../src/cues/cue-matcher.js";
import { ActionDispatcher } from "../src/actions/action-dispatcher.js";
import { RundownEventBroker } from "../src/events.js";
import { loadRundownFile } from "../src/parser/yaml-parser.js";
import { resolve } from "node:path";

test("Walker - synchronizes with gateway rundown state updates", async () => {
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

  const walker = new RundownEngine(store, engine, matcher, dispatcher, broker);

  const yamlPath = resolve("d:/pirundown/examples/sunday-mass.yaml");
  const parsed = loadRundownFile(yamlPath);
  assert.equal(parsed.ok, true);
  await walker.load(parsed.data!);

  assert.equal(walker.getStatus().currentIndex, 0);
  assert.equal(walker.getStatus().currentItem?.id, "alkusoitto");

  // Gateway broadcasts that the operator advanced to alkusiunaus (index 1)
  walker.onGatewayRundownState({
    currentIndex: 1,
    items: [
      { id: "alkusoitto", status: "completed" },
      { id: "alkusiunaus", status: "active" },
    ],
    variables: {
      preacher: "Pastori Matti",
      hymn_1: "332",
      stage_mode: "sermon",
    },
  });

  const syncedStatus = walker.getStatus();
  assert.equal(syncedStatus.currentIndex, 1);
  assert.equal(syncedStatus.currentItem?.id, "alkusiunaus");
  assert.equal(syncedStatus.variables.stage_mode, "sermon");

  // Walker cue matcher now evaluates against item 1
  const match = await walker.onTranscript("Liturgi aloittaa Isän ja Pojan ja Pyhän Hengen nimeen olkaa hyvät");
  assert.equal(match, true);
});
