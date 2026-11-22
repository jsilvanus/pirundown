import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GatewaySseClient, GATEWAY_EVENT_TYPES, gatewayEventsUrl } from "../src/engine/gateway-sse-client.js";

function streamOf(text: string): Response {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("GatewaySseClient", () => {
  it("builds the URL from the handled types", () => {
    const url = gatewayEventsUrl("http://gw:3000/");
    assert.equal(url, `http://gw:3000/api/v1/events?types=${encodeURIComponent(GATEWAY_EVENT_TYPES.join(","))}`);
    const types = new URL(url).searchParams.get("types")!.split(",");
    assert.deepEqual(types, [...GATEWAY_EVENT_TYPES]);
    assert.deepEqual([...types].sort(), ["pisound", "pivoice", "rundown", "transcript"]);
  });

  it("requests the filtered URL and ignores unhandled types", async () => {
    const calls = { rundown: 0, sound: 0, transcripts: [] as string[] };
    const engine = {
      onGatewayRundownState: () => { calls.rundown++; },
      onTranscript: async (t: string) => { calls.transcripts.push(t); },
      onSoundEvent: async () => { calls.sound++; return true; },
    };
    const frames =
      `event: atem\ndata: ${JSON.stringify({ x: 1 })}\n\n` +
      `event: camera\ndata: ${JSON.stringify({ x: 1 })}\n\n` +
      `event: transcript\ndata: ${JSON.stringify({ text: "hello" })}\n\n`;
    let called = "";
    const client = new GatewaySseClient({
      gatewayUrl: "http://gw:3000",
      engine: engine as any,
      fetchFn: (async (url: string, init: any) => {
        if (called) {
          client.stop();
          throw new Error("stopped");
        }
        called = String(url);
        return streamOf(frames);
      }) as any,
    });
    client.start();
    await new Promise((r) => setTimeout(r, 100));
    client.stop();
    assert.ok(called.includes("/api/v1/events?types="));
    assert.deepEqual(calls.transcripts, ["hello"]);
    assert.equal(calls.rundown, 0);
    assert.equal(calls.sound, 0);
  });
});
