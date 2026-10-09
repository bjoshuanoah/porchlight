import { test } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";
import { createServer } from "../src/index.js";

function listen(app: Express): { port: Promise<number>; close: () => void } {
  const { promise, resolve } = Promise.withResolvers<number>();
  const listener = app.listen(0, () => {
    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    resolve(port);
  });
  return { port: promise, close: () => listener.close() };
}

test("health route returns ok (contract)", async (t) => {
  const app = createServer();
  const { port, close } = listen(app);
  t.after(close);
  const actualPort = await port;

  const res = await fetch(`http://127.0.0.1:${actualPort}/api/health`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { status: string; service: string };
  assert.equal(body.status, "ok");
  assert.equal(body.service, "porchlight-server");
});

test("identity module owns /api/identity session creation (contract)", async (t) => {
  const app = createServer();
  const { port, close } = listen(app);
  t.after(close);
  const actualPort = await port;

  const res = await fetch(`http://127.0.0.1:${actualPort}/api/identity/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user_1" }),
  });
  assert.equal(res.status, 201);

  const body = (await res.json()) as { userId: string; token: string };
  assert.equal(body.userId, "user_1");
  assert.equal(typeof body.token, "string");
});

test("social module owns /api/social post creation (contract)", async (t) => {
  const app = createServer();
  const { port, close } = listen(app);
  t.after(close);
  const actualPort = await port;

  const res = await fetch(`http://127.0.0.1:${actualPort}/api/social/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user_1", body: "hello" }),
  });
  assert.equal(res.status, 201);

  const body = (await res.json()) as { userId: string; body: string };
  assert.equal(body.userId, "user_1");
  assert.equal(body.body, "hello");
});

test("missing fields return 400 without domain state", async (t) => {
  const app = createServer();
  const { port, close } = listen(app);
  t.after(close);
  const actualPort = await port;

  const res = await fetch(`http://127.0.0.1:${actualPort}/api/identity/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});