import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionDispatcher } from "../src/actions/action-dispatcher.js";
import { VariableStore } from "../src/variables/variable-store.js";
import { VarfetchEngine } from "../src/variables/varfetch-engine.js";
import type { AppConfig } from "../src/config.js";

test("ActionDispatcher - dispatches Switch cut and preview via pigateway actions execute", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const mockFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true, target: "switch:cut" }), { status: 200 });
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

  // 1. Primary: switch cut
  const cutResult = await dispatcher.dispatch({ switch: { cut: 2 } });
  assert.equal(cutResult.ok, true);
  assert.deepEqual(calls[0]?.body, { actor: "rundown", action: "switch:cut", params: { input: 2 } });

  // 2. Switch preview
  const prevResult = await dispatcher.dispatch({ switch: { preview: 3 } });
  assert.equal(prevResult.ok, true);
  assert.deepEqual(calls[1]?.body, { actor: "rundown", action: "switch:preview", params: { input: 3 } });

  // 3. Alias: atem cut
  const atemResult = await dispatcher.dispatch({ atem: { cut: 4 } });
  assert.equal(atemResult.ok, true);
  assert.deepEqual(calls[2]?.body, { actor: "rundown", action: "switch:cut", params: { input: 4 } });

  // 4. Named camera / phone source
  const pastorResult = await dispatcher.dispatch({ switch: { preview: "pastorphone" } });
  assert.equal(pastorResult.ok, true);
  assert.deepEqual(calls[3]?.body, { actor: "rundown", action: "switch:preview", params: { input: "pastorphone" } });

  const cam1Result = await dispatcher.dispatch({ atem: { cut: "cam1" } });
  assert.equal(cam1Result.ok, true);
  assert.deepEqual(calls[4]?.body, { actor: "rundown", action: "switch:cut", params: { input: "cam1" } });
});

test("ActionDispatcher - dispatches camera preset with variable interpolation via pigateway", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const mockFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true, target: "camera:1:preset" }), { status: 200 });
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
  assert.equal(calls[0]?.url, "http://gateway.test/api/v1/actions/execute");
  assert.deepEqual(calls[0]?.body, { actor: "rundown", action: "cam:preset", params: { id: 1, preset: "altar" } });
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

test("ActionDispatcher - forwards string shorthand actions to pigateway", async () => {
  const calls: Array<{ url: string; body?: any }> = [];
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
  assert.equal(calls[0]?.url, "http://gateway.test/api/v1/actions/execute");
  assert.deepEqual(calls[0]?.body, { actor: "rundown", action: "cam:2:preset:pulpit" });

  await dispatcher.dispatch("atem:cut:3");
  assert.equal(calls[1]?.url, "http://gateway.test/api/v1/actions/execute");
  assert.deepEqual(calls[1]?.body, { actor: "rundown", action: "atem:cut:3" });

  await dispatcher.dispatch("var:speaker=Pastori");
  assert.equal(store.get("speaker"), "Pastori");
});
