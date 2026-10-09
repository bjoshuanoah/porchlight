import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthService } from "../src/services/health.service.js";
import { healthModel } from "../src/models/health.model.js";

test("HealthService.getHealth returns the health document", () => {
  const service = new HealthService();
  const doc = service.getHealth();
  assert.equal(doc.status, "ok");
  assert.equal(doc.service, "porchlight-server");
});

test("HealthService owns the health model", () => {
  const service = new HealthService();
  assert.equal(service.models, healthModel);
  assert.deepEqual(healthModel.health.required, ["status", "service"]);
});