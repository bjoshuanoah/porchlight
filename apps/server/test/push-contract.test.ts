import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig } from "@porchlight/shared";
import type { PorchlightConfig } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { ExpressWithRealtime } from "../src/router.js";
import { loadVapidKeys } from "../src/services/push-keys.js";
import type { Probe } from "../src/dependencies.js";

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "porchlight-push-"));
}

function hubConfig(): PorchlightConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
}

test("loadVapidKeys generates the runtime-setup keypair into hub server state at first run (ac-1)", (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = loadVapidKeys(home);
  assert.ok(first);
  assert.ok(first.publicKey.startsWith("B"));
  assert.ok(first.privateKey);
  const file = join(home, "state", "vapid-keys.json");
  assert.equal(existsSync(file), true, "the keypair is held in hub server state");
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, "server state carries owner-only file mode");
  // Never committed: this file lives under the hub home, outside the repo.
  const again = loadVapidKeys(home);
  assert.equal(again?.publicKey, first.publicKey, "every boot reuses the same VAPID identity");
  assert.equal(again?.privateKey, first.privateKey);
});

test("loadVapidKeys regenerates from a corrupt store and logs it", (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const logs: string[] = [];
  const first = loadVapidKeys(home, null, (line) => logs.push(line));
  writeFileSync(join(home, "state", "vapid-keys.json"), "{not json", { mode: 0o600 });
  const second = loadVapidKeys(home, null, (line) => logs.push(line));
  assert.ok(second);
  assert.notEqual(second?.privateKey, first?.privateKey);
  assert.ok(logs.some((line) => line.includes("vapid.keys.corrupt")));
});

/* ---- PORCH-059 Oct 15 finding: the VAPID subject Apple's relay accepts ---- */

test("loadVapidKeys derives the VAPID subject from the hub origin at mint", (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = loadVapidKeys(home, "https://noah-test-2.porch.love");
  assert.equal(material?.subject, "mailto:owner@noah-test-2.porch.love", "the subject names the hub's own DNS host");
  assert.ok(material?.publicKey.startsWith("B"));
  // Origins without a nameable host (IP literals, hostless dev binds): the
  // RFC 2606 placeholder — that path never mints a live web-push
  // subscription, but the subject must still be a valid contact claim.
  const ipHome = tempHome();
  t.after(() => rmSync(ipHome, { recursive: true, force: true }));
  assert.equal(loadVapidKeys(ipHome, "http://127.0.0.1:8710")?.subject, "mailto:owner@example.com");
  const nullHome = tempHome();
  t.after(() => rmSync(nullHome, { recursive: true, force: true }));
  assert.equal(loadVapidKeys(nullHome, null)?.subject, "mailto:owner@example.com");
});

test("loadVapidKeys heals a stored non-DNS subject on boot — keypair and createdAt untouched", (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stale = webpush.generateVAPIDKeys();
  const seededAt = "2026-10-12T15:37:08.209Z";
  const file = join(home, "state", "vapid-keys.json");
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ subject: "mailto:owner@porchlight.hub", ...stale, createdAt: seededAt }, null, 2)}\n`, { mode: 0o600 });
  const logs: string[] = [];
  const healed = loadVapidKeys(home, "https://noah-test-2.porch.love", (line) => logs.push(line));
  assert.equal(healed?.subject, "mailto:owner@noah-test-2.porch.love", "the invalid constant is healed to the derived subject");
  assert.equal(healed?.publicKey, stale.publicKey, "the keypair rides the heal untouched — subscriptions survive");
  assert.equal(healed?.privateKey, stale.privateKey);
  assert.equal(healed?.createdAt, seededAt);
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, "the heal rewrites the state file with the owner-only mode");
  const migrated = logs.find((line) => line.includes("vapid.subject.migrated"));
  assert.ok(migrated, "the heal lands a structured line for the trail");
  assert.ok(migrated.includes("porchlight.hub"), "the line names what it migrated from");
  // Idempotent: the healed boot re-reads without churn.
  const logs2: string[] = [];
  const again = loadVapidKeys(home, "https://noah-test-2.porch.love", (line) => logs2.push(line));
  assert.equal(again?.subject, "mailto:owner@noah-test-2.porch.love");
  assert.equal(logs2.some((line) => line.includes("vapid.subject.migrated")), false, "a healed boot does not re-migrate");
});

test("the heal line lands on stdout when no sink is wired — the deployed-hub shape", (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stale = webpush.generateVAPIDKeys();
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "vapid-keys.json"), JSON.stringify({ subject: "mailto:owner@porchlight.hub", ...stale, createdAt: "2026-10-12T15:37:08.209Z" }, null, 2), { mode: 0o600 });
  const written: string[] = [];
  const original = console.log;
  console.log = (line: string) => written.push(line);
  try {
    // No log sink argument: the deployed boot's loadVapidKeys call shape.
    loadVapidKeys(home, "https://noah-test-2.porch.love");
  } finally {
    console.log = original;
  }
  const migrated = written.find((line) => line.includes("vapid.subject.migrated"));
  assert.ok(migrated, "the heal event survives with no sink wired (stdout → logs/hub.log)");
  assert.ok(migrated.includes('"kind":"push"'), "the fallback line carries the push kind");
  assert.ok(migrated.includes('"to":"mailto:owner@noah-test-2.porch.love"'));
});

test("the hub's subscription route serves the VAPID public key from runtime setup (ac-5)", async (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = hubConfig();
  const app = createServer({ store: createMemoryStore(), readiness: OK_PROBES, config, bootstrap: new BootstrapService(createMemoryStore(), config, home), homeRoot: home });
  // The listening surface: system + assembled domains ride the same app.
  const listener = app.listen(0, "127.0.0.1");
  t.after(() => { listener.closeIdleConnections(); listener.close(); });
  const port = await new Promise<number>((resolve) => listener.once("listening", () => {
    const address = listener.address();
    resolve(typeof address === "object" && address ? address.port : 0);
  }));
  const res = await fetch(`http://127.0.0.1:${port}/api/social/push/vapid`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { publicKey: string | null; available: boolean };
  assert.equal(body.available, true, "the route serves the key the runtime setup generated");
  assert.equal(body.publicKey, loadVapidKeys(home, null)?.publicKey, "the served material IS the hub server state");
});
/* ---- PORCH-063: the opt-in default over the production vertical ----------- */

interface Json {
  [key: string]: unknown;
}

/** One walked identity over the production vertical: bootstrap account,
 *  signed session, network bootstrap, bootstrap invite, admission — the
 *  full production chain producing the MEMBERSHIP token the settings and
 *  subscription routes authorize. Returns the call helper (HTTP over the
 *  listening vertical), the member-token headers, and the DID. */
async function walkedIdentity(app: ExpressWithRealtime) {
  const listener = app.listen(0, "127.0.0.1");
  const port = await new Promise<number>((resolve) => listener.once("listening", () => {
    const address = listener.address();
    resolve(typeof address === "object" && address ? address.port : 0);
  }));
  const call = async (path: string, init?: RequestInit): Promise<{ status: number; body: Json }> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: res.status, body: (await res.json()) as Json };
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyJwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  const account = await call("/api/identity/bootstrap/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Brian", lastName: "Noah", device: { deviceId: "dev_walk", publicKeyJwk } }),
  });
  assert.equal(account.status, 201, `account bootstrap failed: ${JSON.stringify(account.body)}`);
  const did = (account.body.account as Json).did as string;
  const challenge = await call("/api/identity/session/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did }),
  });
  assert.ok([200, 201].includes(challenge.status));
  const session = await call("/api/identity/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did,
      deviceId: "dev_walk",
      nonce: challenge.body.nonce,
      signature: sign(null, Buffer.from(challenge.body.nonce as string, "utf8"), privateKey).toString("base64url"),
    }),
  });
  assert.equal(session.status, 201, `identity session failed: ${session.status} ${JSON.stringify(session.body)}`);
  const identityToken = (session.body as Json).accessToken as string;
  // Network bootstrap (the founder binding writes the owner's membership
  // at creation) + the first invite, admitted with the identity's session.
  const network = await call("/api/social/bootstrap/network", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Brian's Family", ownerDid: did }),
  });
  assert.equal(network.status, 201, `network bootstrap failed: ${JSON.stringify(network.body)}`);
  const invite = await call("/api/social/bootstrap/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "member", maxUses: 1 }),
  });
  assert.ok([200, 201].includes(invite.status), `bootstrap invite failed: ${JSON.stringify(invite.body)}`);
  const code = ((invite.body as Json).joinUrl as string).split("/join/")[1] as string;
  const admission = await call("/api/social/join/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      identityAccessToken: identityToken,
      deviceId: "dev_walk",
      devicePublicKeyJwk: publicKeyJwk,
      signature: sign(null, Buffer.from(`porchlight-join:${code}`, "utf8"), privateKey).toString("base64url"),
    }),
  });
  assert.equal(admission.status, 201, `admission failed: ${admission.status} ${JSON.stringify(admission.body)}`);
  const auth = { "content-type": "application/json", authorization: `Bearer ${(admission.body as Json).accessToken as string}` };
  return { call, auth, did, close: () => { listener.closeIdleConnections(); listener.close(); } };
}

test("the walked enable flow gates the push route class on the production vertical (PORCH-063)", async (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = hubConfig();
  const store = createMemoryStore();
  const app = createServer({ store, readiness: OK_PROBES, config, bootstrap: new BootstrapService(createMemoryStore(), config, home), homeRoot: home });
  const { call, auth, did, close } = await walkedIdentity(app);
  t.after(close);

  // ac-1: a fresh identity's unset row resolves the opt-in default — off.
  const fresh = await call("/api/social/push/settings", { headers: auth });
  assert.equal(fresh.status, 200);
  assert.equal((fresh.body.settings as { enabled: boolean }).enabled, false, "the unset row resolves enabled=false through the production mounting path");

  // ac-2: an off-state identity holds no subscription — the registration
  // route refuses before any walked flow, over the wire.
  const refusedRegistration = await call("/api/social/push/subscriptions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ endpoint: "https://push.example.com/walk", keys: { p256dh: "B_walk", auth: "A_walk" } }),
  });
  assert.equal(refusedRegistration.status, 400, "an off-state identity's registration is refused");
  assert.equal(refusedRegistration.body.code, "E_PUSH_NOT_ENABLED");
  const subs = store.collection("push_subscriptions");
  assert.deepEqual(await subs.find({}), []);

  // The walked flow: the off-to-on write persists enabled=true first, then
  // the subscription registers.
  const enable = await call("/api/social/push/settings", { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true }) });
  assert.equal(enable.status, 200);
  assert.equal((enable.body.settings as { enabled: boolean }).enabled, true);
  const registered = await call("/api/social/push/subscriptions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ endpoint: "https://push.example.com/walk", keys: { p256dh: "B_walk", auth: "A_w2" } }),
  });
  assert.equal(registered.status, 200, "the enabled identity's registration lands");
  const walkStored = await subs.find({});
  assert.deepEqual(walkStored.map((row) => row.identityId), [did], "one identity-scoped subscription exists after the walk");

  // Flipping the switch off expires the stored subscription at the same
  // write — the off-state identity (resolved through the route-persisted
  // row) holds no subscription anywhere.
  const off = await call("/api/social/push/settings", { method: "PUT", headers: auth, body: JSON.stringify({ enabled: false }) });
  assert.equal(off.status, 200);
  assert.deepEqual(await subs.find({}), [], "the off write expired the identity's subscription");
  const reoffered = await call("/api/social/push/subscriptions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ endpoint: "https://push.example.com/walk-again", keys: { p256dh: "B_w2", auth: "A_w2" } }),
  });
  assert.equal(reoffered.status, 400, "registration stays refused while off");
});