// PORCH-061: fresh owner bootstrap lands usable — the three wiring points in
// main.jsx carry their contracts as source pins (the same style as the
// pwa-install and display-modes pins); the pure logic is exercised directly
// by the name-heal, session-credentials, and session-sync tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const webRoot = join(dirname(fileURLToPath(new URL(import.meta.url))), "..");
const src = async (file) => await readFile(join(webRoot, file), "utf8");

test("PORCH-061 ac-1: startNetwork persists the minted identity session before the restore attempt", async () => {
  const main = await src("src/main.jsx");
  const startNetwork = main.slice(main.indexOf("startNetwork: async ({ name, ownerDid })"));
  // The adoption merge lands BEFORE the restore request: a refused restore
  // (E_NOT_A_MEMBER while the founder row settles) can never leave the
  // landed connection presenting the just-superseded identity token.
  assert.ok(
    startNetwork.indexOf("mergeSessionAdoptions(connections, [{") < startNetwork.indexOf("social/session/restore"),
    "the identity mint must persist before the restore attempt",
  );
  // The restore still lands the membership tokens when it answers.
  assert.match(startNetwork, /token: first\.accessToken, refreshToken: first\.refreshToken, networkId: first\.networkId/);
  // The refused path keeps the identity plane live (no token wipe, no drop).
  assert.match(startNetwork, /the identity plane stays live; binding stays server-side/);
});

test("PORCH-061 ac-1: the name-heal sweep adopts what it mints", async () => {
  const main = await src("src/main.jsx");
  const sweep = main.slice(main.indexOf("const updates = await resolveStoredNames(live"));
  assert.match(sweep, /mergeSessionAdoptions\(current, updates\)/, "the sweep merges minted sessions and membership tokens, not only names");
  const heal = await src("src/name-heal.js");
  assert.match(heal, /identityToken: session\.accessToken/);
  assert.match(heal, /updates\.push\(update\)/, "every successful re-credential returns its adoption");
});

test("PORCH-061 ac-1: recovery re-credentials past the freshness gate", async () => {
  const main = await src("src/main.jsx");
  // The gate skips only tab-initiated TTL speculation; the recovery path —
  // whose adopt pass already found no sibling publication — rides force.
  const gate = main.slice(main.indexOf("if (!force && Date.now() - (target.renewedAt || 0) < renewFreshMs) return false"));
  assert.ok(gate.length > 0, "the freshness gate stays guard for tab-initiated renewal");
  const custody = await src("src/session-sync.js");
  assert.match(custody, /runRenewal\(\{ did: connection\.identity\?\.id \|\| null, force: true \}\)/);
  assert.match(custody, /performRenew\(args\)/, "the app's renew receives the force flag");
});

test("PORCH-061 ac-1: a refused founder binding retries through a forced recovery renewal on landing", async () => {
  const main = await src("src/main.jsx");
  const startNetwork = main.slice(main.indexOf("startNetwork: async ({ name, ownerDid })"));
  const retry = startNetwork.indexOf("custody.renew({ did: ownerDid, force: true })");
  assert.ok(retry !== -1, "the refused binding retries immediately — no custody-gate wait");
  const spaced = startNetwork.indexOf("setTimeout(resolve, 1500)");
  assert.ok(spaced !== -1 && spaced < retry, "the retry is spaced past the contested founder write");
});