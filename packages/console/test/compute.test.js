// Compute surface tests (PORCH-152): the pure compute model (closed stage
// vocabulary, provider classes, status chip mapping) and the api.js compute
// + camera-validate wrappers. The wrappers run against a stub config
// service that records every request, pinning methods, paths, bodies, and
// error propagation — the service's plain-language errors surface verbatim.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { ApiError, createApi } from "../src/api.js";
import { STAGES, PROVIDER_CLASSES, stageLabel, statusChipFor, sourceLabel } from "../src/compute/model.js";
import { consoleTabs } from "../src/tabs.js";

// --- the compute model ----------------------------------------------------

test("the compute model mirrors the closed config-package enums", () => {
  // packages/config/src/compute.js STAGES / PROVIDER_CLASSES (itself the
  // @porchlight/agent-runtime vocabulary) — mirrored, never imported.
  assert.deepEqual(STAGES, [
    "detection",
    "event-description",
    "audio-classification",
    "transcription",
    "overwatch-evaluation",
    "embedding",
  ]);
  assert.deepEqual(PROVIDER_CLASSES, ["native-mlx", "openai-spec", "local-server"]);
});

test("stageLabel renders human labels and falls back to the raw stage id", () => {
  assert.equal(stageLabel("detection"), "Detection");
  assert.equal(stageLabel("overwatch-evaluation"), "Overwatch evaluation");
  assert.equal(stageLabel("mystery"), "mystery");
});

test("sourceLabel keeps the three layers plain", () => {
  assert.equal(sourceLabel("admin"), "admin");
  assert.equal(sourceLabel("setup"), "setup");
  assert.equal(sourceLabel("built-in"), "built-in");
});

test("statusChipFor maps the closed status states, reason kept verbatim", () => {
  assert.deepEqual(statusChipFor({ state: "native", reason: null }), { severity: "neutral", label: "native", reason: null });
  const cpu = statusChipFor({ state: "cpu", reason: "coreml EP unavailable — session built for cpu" });
  assert.equal(cpu.severity, "warning");
  assert.equal(cpu.label, "running on CPU");
  assert.equal(cpu.reason, "coreml EP unavailable — session built for cpu");
  const degraded = statusChipFor({ state: "degraded", reason: "The sink is buffering events while offline." });
  assert.equal(degraded.severity, "error");
  assert.equal(degraded.label, "degraded");
  assert.equal(degraded.reason, "The sink is buffering events while offline.");
  const failed = statusChipFor({ state: "failed", reason: "The model file is missing." });
  assert.equal(failed.severity, "error");
  assert.equal(failed.label, "failed");
  const unknown = statusChipFor({
    state: "unknown",
    reason: "stage is not reporting — service wiring pending",
  });
  assert.equal(unknown.severity, "muted");
  assert.equal(unknown.label, "stage is not reporting");
  assert.equal(unknown.reason, "stage is not reporting — service wiring pending");
});

test("a missing status is itself unknown — never silent", () => {
  assert.deepEqual(statusChipFor(undefined), { severity: "muted", label: "stage is not reporting", reason: null });
  assert.deepEqual(statusChipFor({}), { severity: "muted", label: "stage is not reporting", reason: null });
});

// --- the tab model ---------------------------------------------------------

test("the console tab model contains Compute", () => {
  assert.ok(consoleTabs.some((tab) => tab.id === "compute" && tab.label === "Compute"));
});

// --- the compute + validate wrappers (stub service) ------------------------

const STAGE_DETAIL = (overrides = {}) => ({
  stage: "detection",
  effective: { providerClass: "native-mlx", model: null },
  source: "built-in",
  layers: { setup: null, admin: null },
  layerIssues: [],
  status: { state: "native", providerClass: "native-mlx", model: null, executionTarget: "gpu/ane", reason: null, updatedAt: "2026-01-01T00:00:00.000Z" },
  providerClasses: ["native-mlx", "openai-spec", "local-server"],
  ...overrides,
});

let stub;
let stubRequests;
let stubApi;

before(async () => {
  stubRequests = [];
  const json = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      stubRequests.push({ method: req.method, url: req.url, body });
      const { method, url } = req;

      if (method === "GET" && url === "/api/compute/stages") {
        return json(res, 200, { stages: [STAGE_DETAIL()] });
      }
      if (method === "GET" && url === "/api/compute/stages/detection") {
        return json(res, 200, STAGE_DETAIL());
      }
      if (method === "PUT" && url === "/api/compute/stages/detection") {
        if (body?.providerClass === "openai-spec" && !body?.endpointRef) {
          return json(res, 422, { error: 'providerClass "openai-spec" requires an endpointRef (where the stage\'s endpoint is configured)' });
        }
        return json(res, 200, STAGE_DETAIL({ effective: { providerClass: body?.providerClass ?? "native-mlx", model: body?.model ?? null, endpointRef: body?.endpointRef }, source: "admin" }));
      }
      if (method === "DELETE" && url === "/api/compute/stages/detection") {
        return json(res, 200, STAGE_DETAIL());
      }
      if (method === "GET" && url === "/api/compute/stages/mystery") {
        return json(res, 404, { error: "Unknown compute stage \"mystery\"." });
      }
      if (method === "POST" && url === "/api/cameras/validate") {
        if (!body?.url) return json(res, 422, { error: "Enter the camera's stream URL." });
        if (body.url === "rtsp://dud") return json(res, 200, { ok: false, reason: "The camera did not answer the stream probe." });
        return json(res, 200, { ok: true, aspect: { width: 1920, height: 1080 }, audio: true, codec: "h264" });
      }
      return json(res, 404, { error: `No handler for ${method} ${url}` });
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubApi = createApi(`http://127.0.0.1:${stub.address().port}`);
});

after(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

test("getComputeStages returns the stage list", async () => {
  const payload = await stubApi.getComputeStages();
  assert.equal(payload.stages.length, 1);
  assert.equal(payload.stages[0].stage, "detection");
  assert.ok(stubRequests.some((entry) => entry.method === "GET" && entry.url === "/api/compute/stages"));
});

test("getComputeStage hits the single-stage path and 404s keep the server's words", async () => {
  const detail = await stubApi.getComputeStage("detection");
  assert.equal(detail.stage, "detection");

  const failure = await stubApi.getComputeStage("mystery").catch((error) => error);
  assert.ok(failure instanceof ApiError);
  assert.equal(failure.status, 404);
  assert.equal(failure.message, 'Unknown compute stage "mystery".');
  assert.ok(stubRequests.some((entry) => entry.method === "GET" && entry.url === "/api/compute/stages/mystery"));
});

test("setComputeStage PUTs the plan body; a 422 refusal surfaces verbatim", async () => {
  const plan = { providerClass: "openai-spec", model: "gpt-4o-mini", endpointRef: "http://127.0.0.1:11434" };
  const detail = await stubApi.setComputeStage("detection", plan);
  assert.equal(detail.source, "admin");
  assert.deepEqual(detail.effective, plan);
  assert.ok(stubRequests.some((entry) => entry.method === "PUT" && entry.url === "/api/compute/stages/detection" && entry.body?.endpointRef === "http://127.0.0.1:11434"));

  const failure = await stubApi.setComputeStage("detection", { providerClass: "openai-spec", model: null }).catch((error) => error);
  assert.ok(failure instanceof ApiError);
  assert.equal(failure.status, 422);
  assert.equal(failure.message, 'providerClass "openai-spec" requires an endpointRef (where the stage\'s endpoint is configured)');
});

test("resetComputeStage DELETEs the admin layer", async () => {
  const detail = await stubApi.resetComputeStage("detection");
  assert.equal(detail.source, "built-in");
  assert.ok(stubRequests.some((entry) => entry.method === "DELETE" && entry.url === "/api/compute/stages/detection"));
});

test("validateCameraUrl POSTs the url; refusal and 422 both surface plain language", async () => {
  const ok = await stubApi.validateCameraUrl("rtsp://gate");
  assert.deepEqual(ok, { ok: true, aspect: { width: 1920, height: 1080 }, audio: true, codec: "h264" });
  assert.ok(stubRequests.some((entry) => entry.method === "POST" && entry.url === "/api/cameras/validate" && entry.body?.url === "rtsp://gate"));

  const refused = await stubApi.validateCameraUrl("rtsp://dud");
  assert.deepEqual(refused, { ok: false, reason: "The camera did not answer the stream probe." });

  const failure = await stubApi.validateCameraUrl("").catch((error) => error);
  assert.ok(failure instanceof ApiError);
  assert.equal(failure.status, 422);
  assert.equal(failure.message, "Enter the camera's stream URL.");
});
