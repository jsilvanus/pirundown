import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionDispatcher } from "../src/actions/action-dispatcher.js";
import { VariableStore } from "../src/variables/variable-store.js";
import { VarfetchEngine } from "../src/variables/varfetch-engine.js";
import type { AppConfig } from "../src/config.js";

test("ActionDispatcher - dispatches ATEM cut via mock fetch", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const mockFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const config: AppConfig = {
    port: 3400,
    host: "0.0.0.0",
    pigatewayUrl: "http://gateway.test",
    picamUrl: "http://cam.test",
    pilightUrl: "http://light.test",
    piprogramUrl: "http://pgm.test",
    autoConnectGateway: false,
  };

  const store = new VariableStore();
  const engine = new VarfetchEngine(store);
  const dispatcher = new ActionDispatcher(config, store, engine, mockFetch);

  const result = await dispatcher.dispatch({ atem: { cut: 2 } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://gateway.test/api/v1/atem/cut");
  assert.deepEqual(calls[0]?.body, { input: 2 });
});

test("ActionDispatcher - dispatches camera preset with variable interpolation", async () => {
  const calls: Array<{ url: string }> = [];
  const mockFetch: typeof fetch = async (url) => {
    calls.push({ url: String(url) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const config: AppConfig = {
    port: 3400,
    host: "0.0.0.0",
    pigatewayUrl: "http://gateway.test",
    picamUrl: "http://cam.test",
    pilightUrl: "http://light.test",
    piprogramUrl: "http://pgm.test",
    autoConnectGateway: false,
  };

  const store = new VariableStore({ target_pos: "altar" });
  const engine = new VarfetchEngine(store);
  const dispatcher = new ActionDispatcher(config, store, engine, mockFetch);

  const result = await dispatcher.dispatch({ cam: { id: 1, preset: "{{target_pos}}" } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://cam.test/api/v1/cameras/1/preset/altar");
});

test("ActionDispatcher - dispatches variable setting directly", async () => {
  const store = new VariableStore();
  const engine = new VarfetchEngine(store);
  const dispatcher = new ActionDispatcher({} as any, store, engine);

  const result = await dispatcher.dispatch({ var: { section: "Saarna", preacher: "Matti" } });
  assert.equal(result.ok, true);
  assert.equal(store.get("section"), "Saarna");
  assert.equal(store.get("preacher"), "Matti");
});

test("ActionDispatcher - parses string shorthand actions", async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const mockFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const config: AppConfig = {
    port: 3400,
    host: "0.0.0.0",
    pigatewayUrl: "http://gateway.test",
    picamUrl: "http://cam.test",
    pilightUrl: "http://light.test",
    piprogramUrl: "http://pgm.test",
    autoConnectGateway: false,
  };

  const store = new VariableStore();
  const engine = new VarfetchEngine(store);
  const dispatcher = new ActionDispatcher(config, store, engine, mockFetch);

  await dispatcher.dispatch("cam:2:preset:pulpit");
  assert.equal(calls[0]?.url, "http://cam.test/api/v1/cameras/2/preset/pulpit");

  await dispatcher.dispatch("atem:cut:3");
  assert.equal(calls[1]?.url, "http://gateway.test/api/v1/atem/cut");
  assert.deepEqual(calls[1]?.body, { input: 3 });

  await dispatcher.dispatch("var:speaker=Pastori");
  assert.equal(store.get("speaker"), "Pastori");
});
