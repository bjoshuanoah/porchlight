import assert from "node:assert/strict";
import { test } from "node:test";

import { createMqttEngineConsumer, ENGINE_DETECTIONS_PREFIX } from "../src/services/engine.adapter.js";

/** A client seam the test drives directly (mirrors the detection sink's injectable client). */
function fakeClient() {
  /** @type {Map<string, (topic: string, buf: Buffer) => void>} */
  const handlers = new Map();
  return {
    connected: true,
    /** @type {string[]} */
    subscribed: [],
    ended: false,
    on(event, fn) {
      handlers.set(event, fn);
    },
    emitConnect() {
      handlers.get("connect")?.();
    },
    /** @param {string} topic @param {Buffer|string} buf */
    emitMessage(topic, buf) {
      handlers.get("message")(topic, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
    subscribe(pattern) {
      this.subscribed.push(pattern);
    },
    end() {
      this.ended = true;
      return Promise.resolve();
    },
  };
}

test("the bus consumer subscribes the family-of-record pattern `porchlight/engine/detections/+/+`", () => {
  const client = fakeClient();
  createMqttEngineConsumer({ url: "mqtt://unit.test", client, onEvent: () => Promise.resolve({}) });
  client.emitConnect();
  assert.deepEqual(client.subscribed, [`${ENGINE_DETECTIONS_PREFIX}/+/+`]);
});

test("ac-5: a topic-family detection WITHOUT a payload camera resolves the camera from the topic's own segment ([3] of `porchlight/engine/detections/<camera>/<cls>`)", async () => {
  const client = fakeClient();
  const received = /** @type {Record<string, unknown>[]} */ ([]);
  createMqttEngineConsumer({ url: "mqtt://unit.test", client, onEvent: (d) => Promise.resolve(received.push(d)) });
  client.emitMessage("porchlight/engine/detections/front-door/person", JSON.stringify({ trackId: "t9", cls: "person", conf: 0.9, t: 5 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.length, 1);
  assert.equal(received[0].camera, "front-door", "the fallback is the family's camera segment, not the class segment");
  assert.equal(received[0].cls, "person");
  assert.equal(received[0].trackId, "t9");
});

test("the payload's camera field stays authoritative over the topic segment", async () => {
  const client = fakeClient();
  const received = /** @type {Record<string, unknown>[]} */ ([]);
  createMqttEngineConsumer({ url: "mqtt://unit.test", client, onEvent: (d) => Promise.resolve(received.push(d)) });
  client.emitMessage("porchlight/engine/detections/topic-named/person", JSON.stringify({ camera: "payload-named", cls: "person", conf: 0.5, t: 1 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.length, 1);
  assert.equal(received[0].camera, "payload-named");
});

test("an unparseable payload is dropped, never fanned to the handler", async () => {
  const client = fakeClient();
  const received = /** @type {Record<string, unknown>[]} */ ([]);
  createMqttEngineConsumer({ url: "mqtt://unit.test", client, onEvent: (d) => Promise.resolve(received.push(d)) });
  client.emitMessage("porchlight/engine/detections/front-door/person", "{not json");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, []);
});
