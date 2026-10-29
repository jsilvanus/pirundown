import { test } from "node:test";
import assert from "node:assert/strict";
import { CueMatcher } from "../src/cues/cue-matcher.js";
import type { Cue } from "../src/schema/rundown-v2.js";

test("CueMatcher - matches exact phrase", () => {
  const matcher = new CueMatcher();
  const cue: Cue = {
    type: "phrase",
    phrase: "Aamen",
    mode: "next",
    caseSensitive: false,
  };

  const res1 = matcher.evaluate(cue, { text: "seurakunta vastaa aamen" });
  assert.equal(res1.matched, true);

  const res2 = matcher.evaluate(cue, { text: "ei osumaa" }, "cue1");
  assert.equal(res2.matched, false);
});

test("CueMatcher - matches fuzzy phrase with variable interpolation", () => {
  const matcher = new CueMatcher();
  const cue: Cue = {
    type: "fuzzy",
    phrase: "Veisaamme virren {{hymn_num}}",
    threshold: 0.8,
    mode: "next",
  };

  const res = matcher.evaluate(cue, {
    text: "Ja nyt veisaamme virren 332 kaikki yhdessä",
    variables: { hymn_num: "332" },
  });

  assert.equal(res.matched, true);
});

test("CueMatcher - matches sound event", () => {
  const matcher = new CueMatcher();
  const cue: Cue = {
    type: "sound",
    event: "music_stop",
    mode: "next",
  };

  assert.equal(matcher.evaluate(cue, { soundEvent: "music_stop" }).matched, true);
  assert.equal(matcher.evaluate(cue, { soundEvent: "music_start" }).matched, false);
});

test("CueMatcher - enforces cooldown", () => {
  const matcher = new CueMatcher();
  const cue: Cue = {
    type: "phrase",
    phrase: "halleluja",
    mode: "next",
    cooldown_ms: 1000,
    caseSensitive: false,
  };

  const t0 = 10000;
  const res1 = matcher.evaluate(cue, { text: "halleluja", now: t0 }, "cue-1");
  assert.equal(res1.matched, true);

  // 200ms later: blocked by cooldown
  const res2 = matcher.evaluate(cue, { text: "halleluja", now: t0 + 200 }, "cue-1");
  assert.equal(res2.matched, false);
  assert.equal(res2.reason, "In cooldown period");

  // 1500ms later: allowed
  const res3 = matcher.evaluate(cue, { text: "halleluja", now: t0 + 1500 }, "cue-1");
  assert.equal(res3.matched, true);
});

test("CueMatcher - manual cue always matches on manual trigger", () => {
  const matcher = new CueMatcher();
  const cue: Cue = {
    type: "manual",
    mode: "next",
  };

  assert.equal(matcher.evaluate(cue, { isManual: false }).matched, false);
  assert.equal(matcher.evaluate(cue, { isManual: true }).matched, true);
});
