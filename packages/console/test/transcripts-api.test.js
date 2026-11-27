// Transcription wrapper tests (PORCH-155): the src/api.js transcription
// wrappers end to end against a live @porchlight/config service booted with
// an INJECTED fake transcription part (a real TranscriptionService can't be
// built in a console test — the console plane never constructs the engine's
// service). The stub records every (method, segments, query, body) the
// config server forwards and answers 200 { handled: true, ... }, so the
// wrappers' URLs, query strings, and bodies pin exactly. The unwired 503
// (console-only build) is covered by a second service without the part.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfigService } from "@porchlight/config";

import { ApiError, createApi } from "../src/api.js";

let root;
let live;
let api;
let stubCalls;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "porch-console-transcripts-"));
  stubCalls = [];
  // The injected part the engine composition would supply: it records the
  // (method, segments) the config server's `r` carries plus the URL query
  // and drained body, and owns its own 200 response whenever it handles.
  const transcription = {
    async handle(req, res, method, segments, url) {
      const raw = await new Promise((resolve) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", () => resolve(""));
      });
      let body = null;
      try {
        body = raw.trim() === "" ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      stubCalls.push({ method, segments: [...segments], query: url.search, body });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ handled: true, method, segments, query: url.search, body }));
      return true;
    },
  };
  const service = createConfigService({ root, consoleDist: null, transcription });
  live = await service.start(0);
  api = createApi(`http://127.0.0.1:${live.port}`);
});

after(async () => {
  await live?.close();
});

test("getTranscriptionMethod GETs the method doc", async () => {
  const payload = await api.getTranscriptionMethod();
  assert.equal(payload.handled, true);
  assert.ok(stubCalls.some((c) => c.method === "GET" && JSON.stringify(c.segments) === JSON.stringify(["transcription", "method"]) && c.query === ""));
});

test("putTranscriptionMethod PUTs the partial doc body", async () => {
  const doc = { global: "openai-spec", cameras: { cam_1: "local-server" } };
  const payload = await api.putTranscriptionMethod(doc);
  assert.equal(payload.handled, true);
  assert.ok(stubCalls.some((c) => c.method === "PUT" && JSON.stringify(c.segments) === JSON.stringify(["transcription", "method"]) && JSON.stringify(c.body) === JSON.stringify(doc)));
});

test("inspectTranscriptionMethod builds the cameraId+type query", async () => {
  const payload = await api.inspectTranscriptionMethod("cam-1", "rolling");
  assert.equal(payload.handled, true);
  assert.ok(stubCalls.some((c) => c.method === "GET" && JSON.stringify(c.segments) === JSON.stringify(["transcription", "method", "inspect"]) && c.query === "?cameraId=cam-1&type=rolling"));
});

test("getTranscriptionStatus GETs the posture", async () => {
  const payload = await api.getTranscriptionStatus();
  assert.ok(stubCalls.some((c) => c.method === "GET" && JSON.stringify(c.segments) === JSON.stringify(["transcription", "status"])));
  assert.equal(payload.handled, true);
});

test("listTranscripts omits undefined params and sends present ones", async () => {
  await api.listTranscripts({ cameraId: "cam-1", sourceType: "rolling", limit: 5 });
  assert.ok(
    stubCalls.some(
      (c) => c.method === "GET" && JSON.stringify(c.segments) === JSON.stringify(["transcripts"]) && c.query === "?cameraId=cam-1&sourceType=rolling&limit=5",
    ),
  );

  await api.listTranscripts({});
  assert.ok(stubCalls.some((c) => c.method === "GET" && JSON.stringify(c.segments) === JSON.stringify(["transcripts"]) && c.query === ""));
});

test("searchTranscripts posts only the present body keys", async () => {
  await api.searchTranscripts({ query: "someone at the door", k: 3, cameraId: "cam-2", sourceType: "event" });
  assert.ok(
    stubCalls.some(
      (c) =>
        c.method === "POST" &&
        JSON.stringify(c.segments) === JSON.stringify(["transcripts", "search"]) &&
        JSON.stringify(c.body) === JSON.stringify({ query: "someone at the door", k: 3, cameraId: "cam-2", sourceType: "event" }),
    ),
  );

  await api.searchTranscripts({ query: "hello" });
  assert.ok(
    stubCalls.some((c) => c.method === "POST" && JSON.stringify(c.segments) === JSON.stringify(["transcripts", "search"]) && JSON.stringify(c.body) === JSON.stringify({ query: "hello" })),
  );
});

test("transcriptCascadeAudit GETs the audit line", async () => {
  const payload = await api.transcriptCascadeAudit();
  assert.ok(stubCalls.some((c) => c.method === "GET" && JSON.stringify(c.segments) === JSON.stringify(["transcripts", "cascade", "audit"])));
  assert.equal(payload.handled, true);
});

test("the config plane keeps serving its own routes beside the injected part", async () => {
  const list = await api.listCameras();
  assert.deepEqual(list, []);
});

test("an unwired build refuses transcription surfaces 503 in plain language", async () => {
  const unwiredRoot = await mkdtemp(join(tmpdir(), "porch-console-transcripts-unwired-"));
  const service = createConfigService({ root: unwiredRoot, consoleDist: null });
  const handle = await service.start(0);
  try {
    const unwiredApi = createApi(`http://127.0.0.1:${handle.port}`);
    await assert.rejects(
      () => unwiredApi.getTranscriptionStatus(),
      (error) =>
        error instanceof ApiError &&
        error.status === 503 &&
        error.message === "the transcription service of record is not wired into this build's config service — the engine composition owns that wiring",
    );
  } finally {
    await handle.close();
  }
});
