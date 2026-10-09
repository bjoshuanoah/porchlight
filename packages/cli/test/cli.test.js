// Co-located unit tests for the porchlight CLI bin (PORCH-002 ac-4).
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/porchlight.mjs", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("--version prints porchlight v<pkg.version> and exits 0", () => {
  const r = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), `porchlight v${pkg.version}`);
});

test("bare invocation runs with no further setup and exits 0 (post-install shape)", () => {
  const r = spawnSync(process.execPath, [BIN], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: porchlight/);
  assert.match(r.stdout, /License: MIT/);
});

test("--help exits 0 with usage", () => {
  const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: porchlight/);
});

test("unknown argument exits nonzero with a diagnosis", () => {
  const r = spawnSync(process.execPath, [BIN, "--bogus"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown argument: --bogus/);
});