/**
 * Perimeter fence audit (ac-10, Porchlight Identity TS 1 "service plane"):
 * in V1 no federation adapter exists and no endpoint admits inbound identity
 * resolution, membership, or content from any external federation surface.
 * This pins the identity module's complete route table — any future inbound
 * surface fails this audit until this file is changed deliberately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@porchlight/shared";
import { assembleIdentityModule } from "../src/assemble.js";

function routePaths(router) {
  return router.stack
    .map((layer) => {
      if (!layer.route) return null;
      const methods = Object.keys(layer.route.methods ?? {}).join(",");
      return `${methods.toUpperCase()} ${layer.route.path}`;
    })
    .filter(Boolean)
    .sort();
}

test("the V1 route table admits no federation surface (perimeter fence audit)", async () => {
  const identity = assembleIdentityModule(createMemoryStore(), { hubUrl: () => "https://hub.test" });

  const apiPaths = routePaths(identity.api);
  assert.deepEqual(apiPaths, [
    "GET /account",
    "GET /devices",
    "GET /did/:did",
    "POST /account/profile",
    "POST /bootstrap/account",
    "POST /bootstrap/adopt",
    "POST /device-link",
    "POST /device-link/consume",
    "POST /devices/revoke",
    "POST /handle",
    "POST /migration/handoff",
    "POST /migration/receive",
    "POST /oidc/authorize",
    "POST /oidc/token",
    "POST /pair",
    "POST /pairing-code",
    "POST /session",
    "POST /session/challenge",
    "POST /session/refresh",
  ]);

  const wellKnownPaths = routePaths(identity.wellKnown);
  assert.deepEqual(wellKnownPaths, [
    "GET /.well-known/identity-keys.json",
    "GET /.well-known/jwks.json",
    "GET /.well-known/openid-configuration",
    "GET /.well-known/webfinger",
  ]);

  // Nothing anywhere is an adapter surface: no ActivityPub-class inbox/outbox
  // actor URIs, no AT Protocol-class record/repo endpoints, no inbound
  // identity resolution that ADMITS anything, and no owner-enabled adapter flag.
  for (const path of [...apiPaths, ...wellKnownPaths]) {
    assert.doesNotMatch(path, /federation|adapter|inbox|outbox|actor|atproto|at-protocol|activitypub/i);
  }
});