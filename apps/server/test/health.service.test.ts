import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthService } from "../src/services/health.service.js";

function service(deps: { mongo: "ok" | "down"; redis: "ok" | "down" }) {
  return new HealthService(
    { mongo: async () => deps.mongo, redis: async () => deps.redis },
    { deploymentMode: "self-hosted", socialServingEnabled: true, identityServingEnabled: true },
    () => "https://hub.example",
  );
}

test("getHealth reports ok when every dependency probe is ok", async () => {
  const doc = await service({ mongo: "ok", redis: "ok" }).getHealth();
  assert.equal(doc.status, "ok");
  assert.equal(doc.service, "porchlight-server");
  assert.deepEqual(doc.deps, { mongo: "ok", redis: "ok" });
});

test("getHealth degrades when one dependency is down", async () => {
  const doc = await service({ mongo: "down", redis: "ok" }).getHealth();
  assert.equal(doc.status, "degraded");
});

test("getHealth reports the phase mode and the tunnel hub URL", async () => {
  const doc = await service({ mongo: "ok", redis: "ok" }).getHealth();
  assert.equal(doc.mode.deploymentMode, "self-hosted");
  assert.equal(doc.hubUrl, "https://hub.example");
});