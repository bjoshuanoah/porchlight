import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig } from "@porchlight/shared";
import type { PorchlightConfig, StoreLike } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
import type { Probe } from "../src/dependencies.js";

/**
 * PORCH-148 transport contract: the agent module's model-profile vertical
 * rides the running hub under /api/agent — the REAL identity module serves
 * (no identity mocks), the hub admin is the hub's first account, the
 * withheld-profile closure runs through the ONE assignment path, and the
 * member surface read carries no endpoint/token strings.
 */

interface Json { [key: string]: unknown }

const OK_PROBES: { mongo: Probe; redis: Probe } = { mongo: async () => "ok", redis: async () => "ok" };

function mutableConfig(): PorchlightConfig {
  return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PorchlightConfig);
}

function testHub() {
  const db = createMemoryStore() as StoreLike;
  const config = mutableConfig();
  const bootstrap = new BootstrapService(db, config, "/tmp/porchlight-agent-test");
  const app = createServer({ store: db, readiness: OK_PROBES, config, bootstrap });
  const { promise, resolve } = Promise.withResolvers<number>();
  const listener = app.listen(0, () => {
    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    resolve(port);
  });
  return { db, close: () => { listener.closeIdleConnections(); listener.close(); }, port: promise };
}

type DevicePair = { deviceId: string; privateKey: KeyObject; publicKeyJwk: Json };

function homePair(deviceId: string): DevicePair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { deviceId, privateKey, publicKeyJwk: publicKey.export({ format: "jwk" }) as Json };
}

/** The real identity flow: account birth → challenge proof → session token. */
async function firstAccountSession(hub: { port: Promise<number> }, device: DevicePair): Promise<{ token: string; did: string }> {
  const port = await hub.port;
  const created = await fetch(`http://127.0.0.1:${port}/api/identity/bootstrap/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Porch", lastName: "Admin", device: { deviceId: device.deviceId, publicKeyJwk: device.publicKeyJwk } }),
  });
  assert.equal(created.status, 201);
  const body = (await created.json()) as Json;
  const did = ((body.account as Json) ?? body).did as string;
  const challenge = await fetch(`http://127.0.0.1:${port}/api/identity/session/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did }),
  });
  assert.equal(challenge.status, 200);
  const nonce = ((await challenge.json()) as Json).nonce as string;
  const session = await fetch(`http://127.0.0.1:${port}/api/identity/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      did,
      deviceId: device.deviceId,
      nonce,
      signature: sign(null, Buffer.from(nonce, "utf8"), device.privateKey).toString("base64url"),
    }),
  });
  assert.equal(session.status, 201);
  return { token: ((await session.json()) as Json).accessToken as string, did };
}

async function api(hub: { port: Promise<number> }, path: string, init: { method?: string; token?: string | null; body?: object } = {}) {
  const port = await hub.port;
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Json };
}

test("the agent vertical rides the hub: profile definition, the availability gate, the member read, and the unassigned state", async () => {
  const hub = testHub();
  try {
    const admin = await firstAccountSession(hub, homePair("dev-admin"));
    const bearerAdmin = admin.token;

    // Unsigned calls refuse.
    assert.equal((await api(hub, "/agent/profiles")).status, 401);

    // The hub admin defines two profiles — an ollama-GLM profile and the
    // withheld premium profile (memberSelectable false).
    const glm = await api(hub, "/agent/profiles", {
      method: "POST",
      token: bearerAdmin,
      body: { name: "Ollama GLM", providerClass: "local-server", modelId: "glm-5.3", endpointRef: "engine:ollama-endpoint" },
    });
    assert.equal(glm.status, 200);
    const premium = await api(hub, "/agent/profiles", {
      method: "POST",
      token: bearerAdmin,
      body: { name: "Premium", providerClass: "local-server", modelId: "premium-model", endpointRef: "engine:premium-endpoint", memberSelectable: false },
    });
    assert.equal(premium.status, 200);

    // The member-selectable list never leaks the withheld profile.
    const selectable = await api(hub, "/agent/me/profiles", { token: bearerAdmin });
    assert.equal(selectable.status, 200);
    const selectableText = JSON.stringify(selectable.body);
    assert.ok(!selectableText.includes((premium.body as Json)._id as string));
    assert.ok(!selectableText.includes("Premium") && !selectableText.includes("premium-endpoint"));

    // Nothing is assigned yet: the member read names the EXPLICIT state.
    const unassignedView = await api(hub, "/agent/me/model", { token: bearerAdmin });
    assert.equal(unassignedView.body.state, "unassigned");
    assert.equal((unassignedView.body as Json).model, null);

    // The admin assignment of the WITHHELD profile still runs — the gate is
    // on member self-selection, never on the admin's assignment power.
    const assigned = await api(hub, "/agent/assignments", {
      method: "POST",
      token: bearerAdmin,
      body: { target: { agentType: "household-member" }, profileId: (premium.body as Json)._id },
    });
    assert.equal(assigned.status, 200);

    // The queried type renders its assignment; a member self-selection of
    // the withheld profile refuses in plain language.
    const listing = await api(hub, "/agent/assignments?agentType=household-member", { token: bearerAdmin });
    assert.equal(listing.body.state, "assigned");
    const attempt = await api(hub, "/agent/me/model", { method: "POST", token: bearerAdmin, body: { profileId: (premium.body as Json)._id } });
    assert.equal(attempt.status, 403);
    assert.equal(attempt.body.code, "E_PROFILE_UNAVAILABLE");
    assert.match(attempt.body.error as string, /not made this profile available/);

    // The member surface read: which model runs, and the provider CLASS —
    // never the address (no endpoint/token strings anywhere).
    const view = await api(hub, "/agent/me/model", { token: bearerAdmin });
    assert.equal(view.status, 200);
    assert.equal(view.body.state, "running");
    assert.deepEqual(view.body.model, { modelId: "premium-model", providerClass: "local-server" });
    const sweep = JSON.stringify(view.body);
    assert.ok(!sweep.includes("engine:premium-endpoint") && !sweep.includes("://"), "no endpoint ref or URL rides the member surface");
  } finally {
    hub.close();
  }
});

test("every member-side availability attempt survives the withheld ceiling, and the flips/assignments land the server-side audit trail", async () => {
  const hub = testHub();
  try {
    const admin = await firstAccountSession(hub, homePair("dev-admin"));
    const kids = await api(hub, "/agent/profiles", {
      method: "POST",
      token: admin.token,
      body: { name: "Kids MLX", providerClass: "native-mlx", modelId: "gemma4:e2b-mlx" },
    });
    const premium = await api(hub, "/agent/profiles", {
      method: "POST",
      token: admin.token,
      body: { name: "Premium", providerClass: "local-server", modelId: "premium-model", memberSelectable: false },
    });

    // Repeated member-side attempts never land (each audited server-side).
    for (let i = 0; i < 3; i++) {
      const attempt = await api(hub, "/agent/me/model", { method: "POST", token: admin.token, body: { profileId: (premium.body as Json)._id } });
      assert.equal(attempt.status, 403);
      assert.equal(attempt.body.code, "E_PROFILE_UNAVAILABLE");
      assert.match(attempt.body.error as string, /not made this profile available/);
    }
    // NOTHING landed: no assignment row exists after any attempt.
    const listing = await api(hub, "/agent/assignments", { token: admin.token });
    assert.deepEqual(listing.body.rows, []);

    // The write of record: the admin's type assignment rides the vertical and
    // lands its audit row (who, what, when) on the hub store.
    const assigned = await api(hub, "/agent/assignments", {
      method: "POST",
      token: admin.token,
      body: { target: { agentType: "household-member" }, profileId: (kids.body as Json)._id },
    });
    assert.equal(assigned.status, 200);
    const audit = (hub.db.collection("agent_audit") as unknown as {
      find(): Promise<Array<Record<string, unknown>>>;
    });
    const rows = await audit.find();
    const swapRow = rows.find((r) => r.type === "profile-assigned" && (r.detail as Record<string, unknown>).profileId === (kids.body as Json)._id);
    assert.ok(swapRow);
    assert.equal(swapRow.actorIdentityRef, admin.did);
    assert.ok(typeof swapRow.at === "string");

    // The admin availability flip lands its own audited row.
    const flipped = await api(hub, `/agent/profiles/${(premium.body as Json)._id}/availability`, {
      method: "PUT",
      token: admin.token,
      body: { memberSelectable: true },
    });
    assert.equal(flipped.status, 200);
    assert.equal(flipped.body.memberSelectable, true);
    const flipRows = (await audit.find()).filter((r) => r.type === "profile-availability");
    assert.equal(flipRows.length, 1);
    assert.equal(flipRows[0].actorIdentityRef, admin.did);
    assert.equal((flipRows[0].detail as Record<string, unknown>).from, false);
    assert.equal((flipRows[0].detail as Record<string, unknown>).to, true);

    // The provenance trail answers over the vertical (empty until an agent
    // session rides the router — read authorization proven).
    const provenance = await api(hub, "/agent/provenance?memberId=nobody", { token: admin.token });
    assert.equal(provenance.status, 200);
    assert.deepEqual(provenance.body.rows, []);
    // Profile identity + provider class + model named, as defined.
    const adminList = await api(hub, "/agent/profiles", { token: admin.token });
    const profiles = (adminList.body as Json).profiles as Array<Record<string, unknown>>;
    const premiumRow = profiles.find((p) => p.modelId === "premium-model");
    assert.equal(premiumRow?.memberSelectable, true, "the flip survives reads");
  } finally {
    hub.close();
  }
});
