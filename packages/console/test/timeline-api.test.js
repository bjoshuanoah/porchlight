// Timeline + setup wrapper tests (PORCH-130): the api.js wrappers run
// against a stub engine that records every request, pinning methods,
// paths, and query strings; non-2xx responses surface their plain-language
// error verbatim via ApiError, and refusal bodies that arrive as 200
// (like a { gap: "unavailable" } moment lookup) pass through as data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { ApiError, createApi } from "../src/api.js";

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

      // --- setup wizard ---
      if (method === "GET" && url === "/api/setup") {
        return json(res, 200, { completed: false, deployment: { name: null }, owner: { firstName: null, lastName: null, photo: false }, missing: ["deployment", "owner"] });
      }
      if (method === "PUT" && url === "/api/setup/deployment") {
        if (!body?.name || body.name.length > 80) {
          return json(res, 422, { error: "The deployment name is needed — between 1 and 80 letters." });
        }
        return json(res, 200, { completed: false, deployment: { name: body.name }, owner: { firstName: null, lastName: null, photo: false }, missing: ["owner"] });
      }
      if (method === "PUT" && url === "/api/setup/owner") {
        return json(res, 200, { completed: false, deployment: { name: "Home" }, owner: { firstName: "Ada", lastName: "Lovelace", photo: true }, missing: [] });
      }
      if (method === "GET" && url === "/api/setup/photo") {
        return json(res, 200, { photo: "data:image/png;base64,AAAA" });
      }
      if (method === "POST" && url === "/api/setup/complete") {
        return json(res, 422, { error: "Setup is missing the deployment name — finish that step first." });
      }

      // --- timeline ---
      if (method === "GET" && url === "/api/segments/days?cameraId=front") {
        return json(res, 200, { days: [{ date: "2026-03-05", hours: ["10", "11"] }] });
      }
      if (method === "GET" && url === "/api/segments?cameraId=front&date=2026-03-05&hour=10") {
        return json(res, 200, { cameraId: "front", date: "2026-03-05", hour: "10", segments: [{ start: 36000, end: 36060, ref: "abc", path: "/api/media/front/2026-03-05/10/abc" }] });
      }
      if (method === "GET" && url.startsWith("/api/segment?")) {
        if (url === "/api/segment?cameraId=front&at=36001") {
          return json(res, 200, { ref: "abc", path: "/api/media/front/2026-03-05/10/abc", start: 36000, end: 36060, kind: "segment" });
        }
        return json(res, 200, { gap: "unavailable" }); // an empty moment is data, never an error
      }
      if (method === "GET" && url === "/api/events?cameraId=front&from=36000&to=39600&limit=50") {
        return json(res, 200, { events: [{ t: 36120, camera: "front", cls: "person", conf: 0.9, trackId: 7, source: "detection" }], bus: { connected: true, url: "/api/events/bus" } });
      }
      if (method === "GET" && url === "/api/events?from=36000&to=39600") {
        return json(res, 200, { events: [], bus: { connected: false, url: null } });
      }

      // --- health seams ---
      if (method === "GET" && url === "/api/health") {
        return json(res, 200, { state: "ok", detail: null });
      }
      if (method === "GET" && url === "/service") {
        return json(res, 200, { state: "degraded", detail: "The stream is reconnecting." });
      }
      if (method === "GET" && url === "/storage") {
        return json(res, 404, { error: "The recorder's storage state could not be found." });
      }

      // --- engine camera registration seam ---
      if (method === "POST" && url === "/cameras") {
        if (body?.url === "rtsp://already-there") {
          return json(res, 200, { ok: false, reason: "That camera is already registered." });
        }
        return json(res, 200, { ok: true, cameraId: "cam-9", aspect: { width: 1920, height: 1080 }, audio: true, recording: { ok: true }, streaming: { ok: true } });
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

test("getSetup pinpoints the gate endpoint", async () => {
  const state = await stubApi.getSetup();
  assert.equal(state.completed, false);
  assert.deepEqual(state.missing, ["deployment", "owner"]);
  assert.ok(stubRequests.some((entry) => entry.method === "GET" && entry.url === "/api/setup"));
});

test("putSetupDeployment PUTs the name; a 422 keeps the server's words", async () => {
  const state = await stubApi.putSetupDeployment("Home");
  assert.equal(state.deployment.name, "Home");
  assert.ok(stubRequests.some((entry) => entry.method === "PUT" && entry.url === "/api/setup/deployment" && entry.body?.name === "Home"));

  const failure = await stubApi.putSetupDeployment("").catch((error) => error);
  assert.ok(failure instanceof ApiError);
  assert.equal(failure.status, 422);
  assert.equal(failure.message, "The deployment name is needed — between 1 and 80 letters.");
});

test("putSetupOwner carries the owner body, getSetupPhoto returns the data URL", async () => {
  const body = { firstName: "Ada", lastName: "Lovelace", photo: "data:image/jpeg;base64,BBBB" };
  await stubApi.putSetupOwner(body);
  assert.ok(stubRequests.some((entry) => entry.method === "PUT" && entry.url === "/api/setup/owner" && entry.body?.photo === body.photo));

  const photo = await stubApi.getSetupPhoto();
  assert.match(photo.photo, /^data:image\/png;base64,/);
});

test("completeSetup's 422 lists what setup is missing, verbatim", async () => {
  const failure = await stubApi.completeSetup().catch((error) => error);
  assert.ok(failure instanceof ApiError);
  assert.equal(failure.status, 422);
  assert.equal(failure.message, "Setup is missing the deployment name — finish that step first.");
});

test("listRecordingDays pins the days path with its camera query", async () => {
  const payload = await stubApi.listRecordingDays("front");
  assert.deepEqual(payload.days, [{ date: "2026-03-05", hours: ["10", "11"] }]);
  assert.ok(stubRequests.some((entry) => entry.method === "GET" && entry.url === "/api/segments/days?cameraId=front"));
});

test("listHourSegments pinpoints camera, date, and hour", async () => {
  const payload = await stubApi.listHourSegments({ cameraId: "front", date: "2026-03-05", hour: "10" });
  assert.equal(payload.cameraId, "front");
  assert.equal(payload.segments[0].ref, "abc");
  assert.ok(stubRequests.some((entry) => entry.method === "GET" && entry.url === "/api/segments?cameraId=front&date=2026-03-05&hour=10"));
});

test("segmentAt returns the containing clip; a gap passes through as data", async () => {
  const hit = await stubApi.segmentAt({ cameraId: "front", at: 36001 });
  assert.equal(hit.kind, "segment");
  assert.ok(stubRequests.some((entry) => entry.method === "GET" && entry.url === "/api/segment?cameraId=front&at=36001"));

  const miss = await stubApi.segmentAt({ cameraId: "front", at: 99999 });
  assert.deepEqual(miss, { gap: "unavailable" });
});

test("listEvents pins the event window and limit; the bus state rides along", async () => {
  const payload = await stubApi.listEvents({ cameraId: "front", from: 36000, to: 39600, limit: 50 });
  assert.equal(payload.events[0].cls, "person");
  assert.equal(payload.bus.connected, true);
  assert.ok(stubRequests.some((entry) => entry.method === "GET" && entry.url === "/api/events?cameraId=front&from=36000&to=39600&limit=50"));

  const everyCamera = await stubApi.listEvents({ from: 36000, to: 39600 }); // no cameraId param at all
  assert.equal(everyCamera.bus.connected, false);
  assert.ok(stubRequests.some((entry) => entry.method === "GET" && entry.url === "/api/events?from=36000&to=39600"));
});

test("health and service seams return their rows; a failed storage lookup stays verbatim", async () => {
  const health = await stubApi.getHealth();
  assert.equal(health.state, "ok");

  const service = await stubApi.getService();
  assert.equal(service.state, "degraded");
  assert.equal(service.detail, "The stream is reconnecting.");

  const failure = await stubApi.getSystemStorage().catch((error) => error);
  assert.ok(failure instanceof ApiError);
  assert.equal(failure.message, "The recorder's storage state could not be found.");
});

test("registerCamera posts to the engine seam; a refusal passes through as data", async () => {
  const ok = await stubApi.registerCamera({ url: "rtsp://good", name: "Side gate" });
  assert.equal(ok.ok, true);
  assert.equal(ok.cameraId, "cam-9");
  assert.ok(stubRequests.some((entry) => entry.method === "POST" && entry.url === "/cameras" && entry.body?.url === "rtsp://good"));

  const refused = await stubApi.registerCamera({ url: "rtsp://already-there" });
  assert.deepEqual(refused, { ok: false, reason: "That camera is already registered." });
});

test("mediaUrl and liveUrl stay same-origin relative to the base", () => {
  assert.equal(stubApi.mediaUrl("/api/media/front/2026-03-05/10/abc"), `${stubAddress()}/api/media/front/2026-03-05/10/abc`);
  assert.equal(stubApi.liveUrl("front 1"), `${stubAddress()}/live/front%201`);
});

function stubAddress() {
  return `http://127.0.0.1:${stub.address().port}`;
}
