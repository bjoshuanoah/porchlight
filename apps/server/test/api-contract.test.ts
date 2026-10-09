import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/index.js";

test("health route returns ok (contract)", async () => {
  const app = createServer();
  const listener = app.listen(0);
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { status: string; service: string };
  assert.equal(body.status, "ok");
  assert.equal(body.service, "porchlight-server");

  listener.close();
});
