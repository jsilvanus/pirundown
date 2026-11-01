import { test } from "node:test";
import assert from "node:assert/strict";
import { CueMatcher } from "../src/cues/cue-matcher.js";
import { parseRundownYaml } from "../src/parser/yaml-parser.js";
import { VariableStore } from "../src/variables/variable-store.js";
import { VarfetchEngine } from "../src/variables/varfetch-engine.js";
import { ActionDispatcher } from "../src/actions/action-dispatcher.js";
import { RundownEventBroker } from "../src/events.js";
import { RundownEngine } from "../src/engine/rundown-engine.js";
import { loadConfig } from "../src/config.js";
import type { Cue } from "../src/schema/rundown-v2.js";

test("RundownEngine & CueMatcher - preflights semantic cues and matches rolling caption windows via piembed", async () => {
  const preflightPayloads: any[] = [];
  const matchPayloads: any[] = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/cues/preflight")) {
      const body = JSON.parse(String(init?.body));
      preflightPayloads.push(body);
      return new Response(
        JSON.stringify({ status: "ok", registered: body.cues.length, provider: "ollama", dimensions: 1024 }),
        { status: 200 }
      );
    }
    if (url.endsWith("/api/v1/cues/match")) {
      const body = JSON.parse(String(init?.body));
      matchPayloads.push(body);
      const isPaternoster =
        body.text.includes("Isä meidän") && body.text.includes("taivaissa");
      const score = isPaternoster ? 0.85 : 0.25;
      return new Response(
        JSON.stringify({
          matched: score >= (body.threshold ?? 0.70),
          bestMatch: { id: body.cueIds[0], score, matched: score >= (body.threshold ?? 0.70) },
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const config = loadConfig({ PIRUNDOWN_PIEMBED_URL: "http://127.0.0.1:3300" });
  const varStore = new VariableStore();
  const varfetch = new VarfetchEngine(varStore);
  const matcher = new CueMatcher({ piembedUrl: config.piembedUrl, fetchFn: mockFetch });
  const dispatcher = new ActionDispatcher(config, varStore, varfetch, mockFetch);
  const broker = new RundownEventBroker();
  const engine = new RundownEngine(varStore, varfetch, matcher, dispatcher, broker);

  const yaml = `
version: 2
title: "Messu"
rundown:
  - id: step_prayer
    title: "Herran rukous"
    cue:
      type: semantic
      phrase: "Isä meidän, joka olet taivaissa"
      threshold: 0.70
      context_mode: window
      context_segments: 3
    actions:
      - switch: { cut: 2 }
  - id: step_blessing
    title: "Siunaus"
    actions:
      - switch: { cut: 1 }
`;

  const parsed = parseRundownYaml(yaml);
  assert.equal(parsed.ok, true);
  await engine.load(parsed.data!);

  // Verify preflight was sent at rundown load
  assert.equal(preflightPayloads.length, 1);
  assert.equal(preflightPayloads[0].cues.length, 1);
  assert.equal(preflightPayloads[0].cues[0].id, "step_prayer");
  assert.equal(preflightPayloads[0].cues[0].phrase, "Isä meidän, joka olet taivaissa");

  // Line 1 alone does not match
  const fired1 = await engine.onTranscript("ja nyt rukoilemme yhdessä Isä meidän");
  assert.equal(fired1, false);

  // Line 2 joins with Line 1 in the rolling window -> matches!
  const fired2 = await engine.onTranscript("joka olet taivaissa pyhitetty olkoon sinun nimesi");
  assert.equal(fired2, true);
  assert.ok(matchPayloads.some((p) => p.text.includes("Isä meidän joka olet taivaissa")));
});

test("CueMatcher - cheap-first short-circuit skips piembed when exact phrase in 'any' group matches", async () => {
  let piembedCalled = false;
  const matcher = new CueMatcher({
    piembedUrl: "http://127.0.0.1:3300",
    fetchFn: async () => {
      piembedCalled = true;
      return new Response("{}", { status: 200 });
    },
  });

  // Semantic is listed FIRST in YAML, phrase is listed SECOND,
  // but cheap-first ordering evaluates phrase first!
  const cue: Cue = {
    type: "any",
    mode: "next",
    conditions: [
      {
        type: "semantic",
        phrase: "Herran siunaus",
        threshold: 0.70,
        mode: "next",
        context_mode: "window",
        context_segments: 3,
      },
      {
        type: "phrase",
        phrase: "Herra siunatkoon teitä",
        caseSensitive: false,
        mode: "next",
      },
    ],
  };

  const res = await matcher.evaluateAsync(cue, { text: "Herra siunatkoon teitä ja varjelkoon teitä" }, "cue_any");
  assert.equal(res.matched, true);
  assert.equal(piembedCalled, false);
});

test("CueMatcher - falls back to Jaro-Winkler fuzzy matching when piembed is unreachable", async () => {
  const matcher = new CueMatcher({
    piembedUrl: "http://127.0.0.1:3300",
    fetchFn: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  const cue: Cue = {
    type: "semantic",
    phrase: "Isä meidän joka olet taivaissa",
    threshold: 0.70,
    mode: "next",
    context_mode: "window",
    context_segments: 3,
  };

  const res = await matcher.evaluateAsync(cue, { text: "Rukoilemme Isä meidän joka olet taivaissa" }, "cue_fb");
  assert.equal(res.matched, true);
  assert.ok(res.reason?.includes("fuzzy fallback"));
});
