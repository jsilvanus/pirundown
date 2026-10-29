import { test } from "node:test";
import assert from "node:assert/strict";
import { VariableStore } from "../src/variables/variable-store.js";

test("VariableStore - sets and gets variables", () => {
  const store = new VariableStore({ initial: "123" });
  assert.equal(store.get("initial"), "123");

  store.set("hymn", "450");
  assert.equal(store.get("hymn"), "450");
  assert.deepEqual(store.getAll(), { initial: "123", hymn: "450" });
});

test("VariableStore - interpolates {{ }} patterns using varfetch", () => {
  const store = new VariableStore({
    preacher: "Pastori Matti",
    hymn: "332",
  });

  const interpolated = store.interpolate("Veisaamme virren {{hymn}} pastori {{preacher}} johdolla");
  assert.equal(interpolated, "Veisaamme virren 332 pastori Pastori Matti johdolla");
});

test("VariableStore - handles TTL reverts", async () => {
  const store = new VariableStore({ section: "Johdanto" });

  // Set temporary variable with 50ms TTL, revert to previous
  store.set("section", "Rukous", "test", 50);
  assert.equal(store.get("section"), "Rukous");

  // Wait for TTL to expire
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(store.get("section"), "Johdanto");
});

test("VariableStore - notifies subscribers on change", () => {
  const store = new VariableStore();
  const received: string[] = [];

  const unsub = store.subscribe((v) => {
    received.push(`${v.name}=${v.value}`);
  });

  store.set("cam", "altar");
  store.set("atem", "1");
  unsub();
  store.set("cam", "pulpit");

  assert.deepEqual(received, ["cam=altar", "atem=1"]);
});
