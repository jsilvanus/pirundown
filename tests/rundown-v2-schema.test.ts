import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRundownYaml } from "../src/parser/yaml-parser.js";

test("Rundown v2 Schema - parses valid minimal rundown", () => {
  const yaml = `
version: 2
title: "Test Service"
rundown:
  - id: "item1"
    title: "Intro"
    actions:
      - cam: { id: 1, preset: "altar" }
`;
  const result = parseRundownYaml(yaml);
  assert.equal(result.ok, true);
  assert.equal(result.data?.title, "Test Service");
  assert.equal(result.data?.rundown.length, 1);
  assert.equal(result.data?.rundown[0]?.id, "item1");
});

test("Rundown v2 Schema - parses complex cues, connectors and actions", () => {
  const yaml = `
version: 2
title: "Sunday Mass"
service: "Messu"
connectors:
  lectionary:
    baseUrl: "https://api.example.com"
    requests:
      today:
        method: "GET"
        path: "/api/today"
        mappings:
          - jsonPath: "$.title"
            variable: "day_title"
preflight:
  variables:
    hymn1: "332"
rundown:
  - id: "intro"
    title: "Opening"
    cue:
      type: "fuzzy"
      phrase: "Isän ja Pojan"
      threshold: 0.85
    actions:
      - cam: { id: 1, preset: "altar" }
      - atem: { cut: 1 }
      - tally: { unit: 1, cue: "pan-left" }
      - pipgm: { hymn: "{{hymn1}}" }
      - var: { section: "Opening" }
`;
  const result = parseRundownYaml(yaml);
  assert.equal(result.ok, true);
  assert.equal(result.data?.preflight?.variables?.hymn1, "332");
  assert.equal(result.data?.rundown[0]?.cue?.type, "fuzzy");
  assert.equal(result.data?.rundown[0]?.actions.length, 5);
});

test("Rundown v2 Schema - rejects invalid version", () => {
  const yaml = `
version: 1
title: "Old Version"
rundown:
  - id: "1"
    title: "Test"
`;
  const result = parseRundownYaml(yaml);
  assert.equal(result.ok, false);
  assert.match(result.errors?.[0] ?? "", /version/);
});

test("Rundown v2 Schema - rejects empty rundown list", () => {
  const yaml = `
version: 2
title: "Empty Service"
rundown: []
`;
  const result = parseRundownYaml(yaml);
  assert.equal(result.ok, false);
});


test("Rundown v2 Schema - parses general and per-section AI instructions", () => {
  const yaml = `
version: 2
title: "AI Directed Sunday Mass"
service: "Messu"
ai:
  pacing: "liturgical"
  style: "Dignified, calm, contemplative Nordic liturgy"
  cameraRoles:
    "1": "Wide altar and sanctuary view"
    "2": "Pulpit close/medium"
    "3": "Organ loft and choir"
  constraints:
    disallowCongregationCloseup: true
    minShotDwellSec: 5
    maxShotDwellSec: 35
    avoidCutsDuringPrayer: true
  guidelines:
    - "Never cut to empty podium"
    - "Maintain wide establishing shot during communion"
  sections:
    Johdanto: "Keep wide on altar and procession"
    Sana: "Focus on reader at pulpit/ambo"
rundown:
  - id: "saarna"
    title: "Saarna (Sermon)"
    section: "Sana"
    notes: "Preacher delivers sermon from pulpit"
    ai:
      instructions: "Focus primarily on preacher at pulpit with Cam 2. Do not cut during prayers."
      targetZone: "pulpit"
      primarySubject: "Preacher"
      preferredCameras: [2, 1]
      framing: "medium"
      pacing: "calm"
      shotRules:
        - condition: "preacher_speaking"
          target: "cam:2:preset:pulpit"
          priority: 8
      graphicsCue:
        lowerThird:
          title: "Saarna"
          subtitle: "Pastori Matti"
    actions:
      - cam: { id: 2, preset: "pulpit" }
      - switch: { cut: 2 }
  - id: "virsi"
    title: "Virsi 332"
    section: "Ylistys"
    ai: "Switch to hymn overlay when singing starts and cut to organ/choir"
    actions:
      - switch: { cut: 3 }
`;
  const result = parseRundownYaml(yaml);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  
  // Verify top-level AI instructions
  const ai = result.data?.ai;
  assert.ok(typeof ai === "object" && ai !== null);
  if (typeof ai === "object" && ai !== null) {
    assert.equal(ai.pacing, "liturgical");
    assert.equal(ai.style, "Dignified, calm, contemplative Nordic liturgy");
    assert.equal(ai.constraints?.disallowCongregationCloseup, true);
    assert.equal(ai.constraints?.minShotDwellSec, 5);
    assert.equal(ai.guidelines?.length, 2);
    assert.equal(ai.cameraRoles?.["2"], "Pulpit close/medium");
  }

  // Verify item 1 with structured AI object
  const item1 = result.data?.rundown[0];
  assert.equal(item1?.id, "saarna");
  assert.ok(typeof item1?.ai === "object" && item1?.ai !== null);
  if (typeof item1?.ai === "object" && item1?.ai !== null) {
    assert.equal(item1.ai.targetZone, "pulpit");
    assert.equal(item1.ai.primarySubject, "Preacher");
    assert.deepEqual(item1.ai.preferredCameras, [2, 1]);
    assert.equal(item1.ai.framing, "medium");
    assert.equal(item1.ai.pacing, "calm");
    assert.equal(item1.ai.shotRules?.length, 1);
    assert.equal(item1.ai.shotRules?.[0]?.condition, "preacher_speaking");
  }

  // Verify item 2 with shorthand string AI instruction
  const item2 = result.data?.rundown[1];
  assert.equal(item2?.id, "virsi");
  assert.equal(typeof item2?.ai, "string");
  assert.match(item2?.ai as string, /Switch to hymn overlay/);
});
