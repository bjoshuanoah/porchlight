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
test("getHealth carries the configured media root and its readiness state (PORCH-054, late-bound)", async () => {
  const doc = await service({ mongo: "ok", redis: "ok" }).getHealth();
  assert.equal(doc.media, null, "no media pipeline wired = null media readiness");
  const hub = service({ mongo: "ok", redis: "ok" });
  hub.setMediaStatus(async () => ({
    root: "/Volumes/FamilyArchive",
    state: "volume-not-ready",
    check: "volume-not-ready",
    reason: "The media root /Volumes/FamilyArchive is not a live mounted directory (volume not ready).",
    flag: null,
  }));
  const withMedia = await hub.getHealth();
  assert.ok(withMedia.media, "the wired provider surfaces the media readiness");
  assert.equal(withMedia.media.root, "/Volumes/FamilyArchive");
  assert.equal(withMedia.media.state, "volume-not-ready");
});
