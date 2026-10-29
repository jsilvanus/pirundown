import { test } from "node:test";
import assert from "node:assert/strict";
import { jaroWinkler, fuzzySubstringMatch } from "../src/cues/jaro-winkler.js";

test("Jaro-Winkler - exact matches return 1.0", () => {
  assert.equal(jaroWinkler("Aamen", "Aamen"), 1.0);
  assert.equal(jaroWinkler("aamen", "AAMEN"), 1.0);
});

test("Jaro-Winkler - similar Finnish words have high score", () => {
  // Minor phonetic/spelling variation
  const score = jaroWinkler("seurakunta", "seurakunda");
  assert.ok(score > 0.9, `Expected score > 0.9, got ${score}`);
});

test("Fuzzy Substring Match - finds phrase inside speech transcript", () => {
  const transcript = "ja nyt me aloitamme Isän ja Pojan ja Pyhän Hengen nimeen olkaa hyvät";
  const phrase = "Isän ja Pojan ja Pyhän Hengen nimeen";

  const result = fuzzySubstringMatch(phrase, transcript, 0.85);
  assert.equal(result.matched, true);
  assert.equal(result.score, 1.0);
});

test("Fuzzy Substring Match - matches with speech transcription typos", () => {
  // STT misspelled or omitted accents
  const transcript = "ja liturgi sanoo isan ja pojan ja pyhan hengen nimeen amen";
  const phrase = "Isän ja Pojan ja Pyhän Hengen nimeen";

  const result = fuzzySubstringMatch(phrase, transcript, 0.80);
  assert.equal(result.matched, true);
  assert.ok(result.score >= 0.80, `Expected score >= 0.80, got ${result.score}`);
});

test("Fuzzy Substring Match - does not match unrelated transcript", () => {
  const transcript = "seurakunta istuutuu ja kuuntelee musiikkia rauhassa";
  const phrase = "Herra siunatkoon teitä ja varjelkoon teitä";

  const result = fuzzySubstringMatch(phrase, transcript, 0.80);
  assert.equal(result.matched, false);
});
