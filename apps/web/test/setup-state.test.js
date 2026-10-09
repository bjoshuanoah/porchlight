import { test } from "node:test";
import assert from "node:assert/strict";
import { SETUP_STEPS, fullName, resumedDetail, setupStage } from "../src/setup-state.js";

const ledger = (statuses) => ({
  steps: Object.fromEntries(Object.entries(statuses).map(([step, status]) => [step, { status, at: null, detail: null }])),
});

test("the wizard opens on the network-name prompt on a fresh hub", () => {
  assert.equal(setupStage(null), "network");
  assert.equal(setupStage({}), "network");
  assert.equal(setupStage(ledger({ account: "pending" })), "network");
});

test("a ledger with only the network complete resumes at who-you-are", () => {
  assert.equal(setupStage(ledger({ network: "complete", account: "pending" })), "account");
});

test("a ledger with only the account complete resumes at the network name", () => {
  assert.equal(setupStage(ledger({ account: "complete", network: "pending" })), "network");
});

test("a fully completed ledger lands in the network, never a detached screen", () => {
  assert.equal(setupStage(ledger({ account: "complete", network: "complete" })), "landed");
  // Legacy invite/quota rows from the old four-step flow are ignored.
  assert.equal(setupStage(ledger({ account: "complete", network: "complete", invite: "complete", quota: "complete" })), "landed");
});

test("the wizard carries exactly two prompts", () => {
  assert.deepEqual(SETUP_STEPS, ["network", "account"]);
});

test("first and last names compose the family-facing name", () => {
  assert.equal(fullName("Brian", "Noah"), "Brian Noah");
  assert.equal(fullName("  Brian ", ""), "Brian");
  assert.equal(fullName(), "");
});

test("resumed-setup copy never renders a data dump", () => {
  assert.equal(resumedDetail('quota settings: {"storageCeilingMb":1024}'), "Setup paused here earlier. Nothing was lost — continue below.");
  assert.equal(resumedDetail('network "Family" created'), 'Setup paused here earlier: network "Family" created. Continue below — nothing was lost.');
  assert.equal(resumedDetail(""), "");
  assert.equal(resumedDetail(null), "");
});