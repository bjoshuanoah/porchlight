import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The copy audit is the CI gate for the banned-vocabulary rule (PORCH-009
// ac-6): member identity surfaces never render password, email, log in,
// sign in, passkey, key, DID, crypto, or recover; no source file carries
// password/email route text. This pins the gate to the live tree, so a
// copy regression fails the web test suite.
test("member copy and route audit passes over the live source tree", () => {
  const script = fileURLToPath(new URL("../scripts/audit.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /audit passed/);
});