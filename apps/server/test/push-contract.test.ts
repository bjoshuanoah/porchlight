import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, createMemoryStore, normalizeConfig } from "@porchlight/shared";
import type { PorchlightConfig } from "@porchlight/shared";
import { BootstrapService } from "../src/services/bootstrap.service.js";
import { createServer } from "../src/router.js";
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
  const first = loadVapidKeys(home, (line) => logs.push(line));
  writeFileSync(join(home, "state", "vapid-keys.json"), "{not json", { mode: 0o600 });
  const second = loadVapidKeys(home, (line) => logs.push(line));
  assert.ok(second);
  assert.notEqual(second?.privateKey, first?.privateKey);
  assert.ok(logs.some((line) => line.includes("vapid.keys.corrupt")));
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
  assert.equal(body.publicKey, loadVapidKeys(home)?.publicKey, "the served material IS the hub server state");
});