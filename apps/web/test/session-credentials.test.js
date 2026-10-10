import test from "node:test";
import assert from "node:assert/strict";
import { reCredentialPlanes } from "../src/session-credentials.js";

const HUB = "https://hub.example";
const DID = "did:porchlight:brian";

function connectionWith(overrides = {}) {
  return {
    url: HUB,
    identity: { id: DID, name: "Brian" },
    deviceId: "dev_1",
    token: "membership-1",
    identityToken: "identity-1",
    refreshToken: "refresh-1",
    ...overrides,
  };
}

/** Records every call; behavior is configured via the `answer` map. */
function stubRequest(plan = {}) {
  const calls = [];
  const request = async (connection, path, init = {}) => {
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    if (!(path in plan)) throw new Error(`unexpected request ${path}`);
    const answer = plan[path];
    if (typeof answer === "number") {
      const error = new Error(`hub ${path} failure`);
      error.status = answer;
      error.code = answer === 401 ? "E_SESSION_REQUIRED" : "E_UNEXPECTED";
      throw error;
    }
    if (answer === "network") {
      const error = new Error("fetch failed");
      error.status = null;
      throw error;
    }
    return answer;
  };
  return { request, calls };
}

function stubOpenDeviceSession(result = { accessToken: "identity-9", refreshToken: "identity-refresh-9" }) {
  const calls = [];
  const openDeviceSession = async (connection, registration) => {
    calls.push(registration);
    if (result === null) {
      const error = new Error("This device cannot open that identity.");
      error.code = "E_NO_REGISTRATION";
      error.status = 401;
      throw error;
    }
    return result;
  };
  return { openDeviceSession, calls };
}

test("PORCH-050 ac-1/2: a healthy refresh rotates the membership token; restore is never called", async () => {
  const { request, calls } = stubRequest({
    "social/session/refresh": { accessToken: "membership-2" },
  });
  const { openDeviceSession } = stubOpenDeviceSession();
  const result = await reCredentialPlanes(connectionWith(), request, { openDeviceSession });
  assert.equal(result.membershipFailed, false);
  assert.equal(result.connection.token, "membership-2");
  assert.equal(result.connection.identityToken, "identity-9");
  assert.equal(result.connection.refreshToken, "refresh-1", "refresh keeps the member's refresh token");
  assert.equal(calls.filter((call) => call.path === "social/session/restore").length, 0);
});

test("PORCH-050 ac-1/2: a dead refresh token falls through to restore and re-credentials the membership plane", async () => {
  const { request, calls } = stubRequest({
    "social/session/refresh": 401,
    "social/session/restore": {
      sessions: [{ accessToken: "membership-restore", refreshToken: "refresh-restore", networkId: "net_1", name: "Brian Noah" }],
    },
  });
  const { openDeviceSession, calls: mints } = stubOpenDeviceSession();
  const result = await reCredentialPlanes(connectionWith(), request, { openDeviceSession });
  assert.equal(result.membershipFailed, false);
  assert.equal(result.connection.token, "membership-restore");
  assert.equal(result.connection.refreshToken, "refresh-restore");
  assert.equal(result.connection.networkId, "net_1");
  assert.equal(result.connection.identity.name, "Brian Noah", "the name rides every restore (PORCH-034)");
  const restoreCall = calls.find((call) => call.path === "social/session/restore");
  assert.equal(restoreCall.body.identityAccessToken, "identity-9", "restore presents the freshly minted identity token, never the superseded one");
  assert.equal(restoreCall.body.deviceId, "dev_1");
  assert.equal(mints.length, 1, "exactly one identity mint per pass — renewedAt stamping keeps repetition away");
});

test("PORCH-050: refresh failing on a live network goes to restore, not the offline state", async () => {
  const { request } = stubRequest({
    "social/session/refresh": "network",
    "social/session/restore": { sessions: [{ accessToken: "membership-restore", refreshToken: "refresh-restore" }] },
  });
  const { openDeviceSession } = stubOpenDeviceSession();
  const result = await reCredentialPlanes(connectionWith(), request, { openDeviceSession });
  assert.equal(result.membershipFailed, false);
  assert.equal(result.connection.token, "membership-restore");
});

test("PORCH-050 ac-4: refresh and restore both failing leaves the membership plane honestly failed (no invented credentials)", async () => {
  const { request } = stubRequest({
    "social/session/refresh": 401,
    "social/session/restore": 401,
  });
  const { openDeviceSession } = stubOpenDeviceSession();
  const result = await reCredentialPlanes(connectionWith(), request, { openDeviceSession });
  assert.equal(result.membershipFailed, true);
  assert.equal(result.connection.token, "membership-1", "the dead token stays visible — no fake success");
  assert.equal(result.connection.identityToken, "identity-9", "the identity plane still re-news when it can");
});

test("PORCH-050 ac-4: a revoked device registration (mint failure) propagates — recovery is owner-routed, never client-faked", async () => {
  const { request, calls } = stubRequest({});
  const { openDeviceSession } = stubOpenDeviceSession(null);
  await assert.rejects(
    () => reCredentialPlanes(connectionWith(), request, { openDeviceSession }),
    (error) => error.code === "E_NO_REGISTRATION",
  );
  assert.equal(calls.length, 0, "no membership call rides a dead device registration");
});

test("PORCH-050 ac-4: a genuinely revoked member fails restore honestly (E_NOT_A_MEMBER stays membershipFailed)", async () => {
  const { request, calls } = stubRequest({
    "social/session/refresh": 401,
    "social/session/restore": 401,
  });
  const { openDeviceSession } = stubOpenDeviceSession();
  const result = await reCredentialPlanes(connectionWith(), request, { openDeviceSession });
  assert.equal(result.membershipFailed, true);
  assert.equal(calls.length, 2, "refresh + restore attempted once, then the pass ends");
});

test("PORCH-050: a connection with no refresh token and no membership token rides restore straight to network tokens", async () => {
  const { request, calls } = stubRequest({
    "social/session/restore": {
      sessions: [{ accessToken: "membership-restore", refreshToken: "refresh-restore", networkId: "net_1" }],
    },
  });
  const { openDeviceSession } = stubOpenDeviceSession();
  const result = await reCredentialPlanes(
    connectionWith({ token: null, refreshToken: null }),
    request,
    { openDeviceSession },
  );
  assert.equal(result.membershipFailed, false);
  assert.equal(result.connection.token, "membership-restore");
  assert.equal(calls.filter((call) => call.path === "social/session/refresh").length, 0, "nothing to refresh is never attempted");
});

test("PORCH-050: the identity record is copied, never mutated in place", async () => {
  const { request } = stubRequest({
    "social/session/refresh": 401,
    "social/session/restore": { sessions: [{ accessToken: "m", refreshToken: "r", name: "Healed Name" }] },
  });
  const { openDeviceSession } = stubOpenDeviceSession();
  const connection = connectionWith();
  await reCredentialPlanes(connection, request, { openDeviceSession });
  assert.equal(connection.identity.name, "Brian", "the caller's stored row is untouched by the pass");
});