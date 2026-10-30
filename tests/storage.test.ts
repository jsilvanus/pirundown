import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RundownStorage } from "../src/storage/rundown-storage.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const sampleYaml = `
version: 2
title: "Tallennus Testi"
service: "Messu"
date: "2026-11-01"
preflight:
  variables:
    preacher: "Pastori Matti"
rundown:
  - id: "alkusoitto"
    title: "Alkusoitto"
    actions:
      - cam: { id: 1, preset: "organ" }
`;

test("RundownStorage - lists, saves, gets, and deletes files", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pirundown-test-"));
  try {
    const storage = new RundownStorage(tmpDir);

    // Save
    const saveRes = storage.save("test-rundown", sampleYaml);
    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.item?.id, "test-rundown");
    assert.equal(saveRes.item?.title, "Tallennus Testi");

    // List
    const items = storage.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "test-rundown");

    // Get
    const detail = storage.get("test-rundown");
    assert.ok(detail);
    assert.equal(detail.title, "Tallennus Testi");
    assert.ok(detail.yaml.includes("Alkusoitto"));

    // Delete
    const deleted = storage.delete("test-rundown");
    assert.equal(deleted, true);
    assert.equal(storage.list().length, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("API Routes - storage endpoints (/api/v1/storage)", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pirundown-api-test-"));
  try {
    const config = loadConfig();
    config.storageDir = tmpDir;
    config.autoConnectGateway = false;

    const { app } = await buildApp(config);

    // 1. List initially (empty)
    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/storage",
    });
    assert.equal(listRes.statusCode, 200);
    const listData = JSON.parse(listRes.body);
    assert.equal(listData.ok, true);
    assert.equal(listData.count, 0);

    // 2. Save new rundown to storage
    const postRes = await app.inject({
      method: "POST",
      url: "/api/v1/storage",
      payload: {
        id: "messu-2026",
        yaml: sampleYaml,
        load: true,
      },
    });
    assert.equal(postRes.statusCode, 200);
    const postData = JSON.parse(postRes.body);
    assert.equal(postData.ok, true);
    assert.equal(postData.loaded, true);
    assert.equal(postData.item.title, "Tallennus Testi");

    // 3. Get item
    const getRes = await app.inject({
      method: "GET",
      url: "/api/v1/storage/messu-2026",
    });
    assert.equal(getRes.statusCode, 200);
    const getData = JSON.parse(getRes.body);
    assert.equal(getData.ok, true);
    assert.equal(getData.rundown.active, true);

    // 4. Load item
    const loadRes = await app.inject({
      method: "POST",
      url: "/api/v1/storage/messu-2026/load",
    });
    assert.equal(loadRes.statusCode, 200);
    const loadData = JSON.parse(loadRes.body);
    assert.equal(loadData.ok, true);
    assert.equal(loadData.loadedId, "messu-2026");

    // 5. Delete item
    const delRes = await app.inject({
      method: "DELETE",
      url: "/api/v1/storage/messu-2026",
    });
    assert.equal(delRes.statusCode, 200);
    const delData = JSON.parse(delRes.body);
    assert.equal(delData.ok, true);
    assert.equal(delData.deleted, true);

    await app.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
