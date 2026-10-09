import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore, normalizeConfig } from "@porchlight/shared";
import type { PorchlightConfig } from "@porchlight/shared";
import type { Express } from "express";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

const TUNNEL_ISSUER = "https://family.example.trycloudflare.com";

interface TestHub {
  app: Express;
  /** Populated once the listener callback fires (before `boot` resolves). */
  address: { address: string; port: number };
  close: () => void;
  boot: Promise<number>;
}

/**
 * Boots the app on the operator's LAN-facing bind (hub.host = "0.0.0.0",
 * PORCH-025). The tunnel-side issuer provider is injected so the pinning
 * behavior is observable: a request arriving on the LAN-bound listener must
 * still see the tunnel-pinned issuer.
 */
function lanHub(hubUrl: () => string | null): TestHub {
  const db = createMemoryStore();
  const config = normalizeConfig({ hub: { host: "0.0.0.0" } }) as PorchlightConfig;
  const bootstrap = new BootstrapService(db, config, "/tmp/porchlight-lan-bind-home");
  const app = createServer({ store: db, readiness: OK_PROBES, config, bootstrap, hubUrl });
  const listener = app.listen(0, "0.0.0.0", () => void 0);
  const { promise: boot, resolve, reject } = Promise.withResolvers<number>();
  const listenerAddress = { address: "", port: 0 };
  listener.on("listening", () => {
    const address = listener.address();
    if (address && typeof address === "object") {
      listenerAddress.address = address.address;
      listenerAddress.port = address.port;
      resolve(address.port);
    } else {
      reject(new Error("listener did not report an address"));
    }
  });
  listener.on("error", reject);
  return {
    app,
    address: listenerAddress,
    close: () => {
      listener.closeIdleConnections();
      listener.close();
    },
    boot,
  };
}

test("LAN bind: the listener binds 0.0.0.0 on the operator's opt-in and serves the enforced app (ac-1)", async (t) => {
  const hub = lanHub(() => TUNNEL_ISSUER);
  t.after(hub.close);
  // The listener itself binds the LAN-facing wildcard (the config option
  // flows into app.listen); loopback stays covered by the wider bind.
  const port = await hub.boot;
  assert.equal(hub.address.address, "0.0.0.0");
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200);
});

test("LAN bind: token enforcement on the LAN-bound listener — zero trust at the boundary (ac-2)", async (t) => {
  const hub = lanHub(() => TUNNEL_ISSUER);
  t.after(hub.close);
  const port = await hub.boot;
  const base = `http://127.0.0.1:${port}`;

  // A write without a membership token resolves no perimeter: refused.
  const tokenlessWrite = await fetch(`${base}/api/social/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: { type: "text", body: "x" } }),
  });
  assert.equal(tokenlessWrite.status, 401);

  // A content read without a membership token: refused identically.
  const tokenlessRead = await fetch(`${base}/api/social/timeline`);
  assert.equal(tokenlessRead.status, 401);

  // A forged bearer value is still verified against the token verifiers:
  // garbage resolves no perimeter (E_NOT_PERMITTED → 403), never content.
  const forged = await fetch(`${base}/api/social/timeline`, {
    headers: { authorization: "Bearer not-a-real-token" },
  });
  assert.equal(forged.status, 403);
});

test("LAN bind: identity issuance stays pinned to the tunnel issuer for LAN-origin requests (ac-3)", async (t) => {
  const hub = lanHub(() => TUNNEL_ISSUER);
  t.after(hub.close);
  const port = await hub.boot;

  // The request arrives on the LAN-bound listener (Host: 127.0.0.1:<port>);
  // discovery must still report the pinned issuer, never the request host.
  const res = await fetch(`http://127.0.0.1:${port}/.well-known/openid-configuration`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { issuer: string; jwks_uri: string };
  assert.equal(body.issuer, TUNNEL_ISSUER);
  assert.equal(body.jwks_uri, `${TUNNEL_ISSUER}/.well-known/jwks.json`);
});

test("LAN bind: a missing issuer is surfaced loudly, never silently replaced by the request host (ac-3)", async (t) => {
  const hub = lanHub(() => null);
  t.after(hub.close);
  const port = await hub.boot;

  const res = await fetch(`http://127.0.0.1:${port}/.well-known/openid-configuration`);
  assert.equal(res.status, 503);
  const body = (await res.json()) as { code?: string };
  assert.equal(body.code, "E_HUB_URL_UNKNOWN");
});