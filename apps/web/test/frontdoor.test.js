import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJoinCode, parseDeviceGrant, splitJoinLink, hubOrigin, verifyFailure, FAILURE_STATES } from "../src/frontdoor.js";

test("join and device links parse their embedded one-time values", () => {
  assert.equal(parseJoinCode("/join/inv-code_123"), "inv-code_123");
  assert.equal(parseJoinCode("/join/"), "");
  assert.equal(parseJoinCode("/timeline"), "");
  assert.equal(parseDeviceGrant("/device-link/dl-grant-token"), "dl-grant-token");
  assert.equal(parseDeviceGrant("/device-link"), "");
  assert.equal(parseDeviceGrant("/join/x"), "");
});

test("a pasted join link fills both front-door fields", () => {
  assert.deepEqual(splitJoinLink("https://porchlight.home/join/someinvitecode"), { url: "https://porchlight.home", code: "someinvitecode" });
  assert.deepEqual(splitJoinLink("  https://hub.family:8443/join/c%20oded  "), { url: "https://hub.family:8443", code: "c oded" });
  assert.equal(splitJoinLink("https://example.com/other/x"), null);
  assert.equal(splitJoinLink("not a link"), null);
  assert.equal(splitJoinLink("https://example.com/join/"), null);
});

test("hub addresses reduce to their origin or name the failure", () => {
  assert.equal(hubOrigin(" https://porchlight.example:8443 "), "https://porchlight.example:8443");
  assert.equal(hubOrigin("http://localhost:4000"), "http://localhost:4000");
  assert.throws(() => hubOrigin("nonsense"), TypeError);
  assert.throws(() => hubOrigin("ftp://hub.example"), TypeError);
});

test("verification failures name their state in plain language", () => {
  // Hub answered the front-door route with a typed invite failure.
  assert.equal(verifyFailure({ code: "E_INVITE_NOT_FOUND", body: { valid: false, code: "E_INVITE_NOT_FOUND" } }), "invalid");
  assert.equal(verifyFailure({ body: { valid: false, code: "E_INVITE_REVOKED" } }), "revoked");
  assert.equal(verifyFailure({ body: { valid: false, code: "E_INVITE_EXHAUSTED" } }), "used");
  // The verify route does not exist at that address.
  assert.equal(verifyFailure({ status: 404, body: {} }), "wrongUrl");
  // Transport failure — the hub is unreachable.
  assert.equal(verifyFailure(new TypeError("Failed to fetch")), "unreachable");
  // 200-but-not-a-Porchlight-front-door answer.
  assert.equal(verifyFailure({ body: {} }), "wrongUrl");
  assert.ok(FAILURE_STATES.includes("invalid") && FAILURE_STATES.includes("wrongUrl"));
});