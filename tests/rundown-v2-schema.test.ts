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
