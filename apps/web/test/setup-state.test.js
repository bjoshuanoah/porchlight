import { test } from "node:test";
import assert from "node:assert/strict";
import { SETUP_STEPS, fullName, joinNameErrors, resumedDetail, setupStage } from "../src/setup-state.js";

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

test("setupStage reads the exact document /api/bootstrap/state serves (PORCH-021)", () => {
  // The served shape, verbatim from the system route: resumable, lastError,
  // steps, diagnostics, config. The wizard maps this one state — the same
  // source the CLI resume driver reads — never a second stored copy.
  const served = (statuses, extra = {}) => ({
    resumable: false, lastError: null, steps: ledger(statuses).steps, diagnostics: [],
    config: { mode: {}, quota: {}, hubUrl: null }, updatedAt: "2026-10-09T00:00:00.000Z", ...extra,
  });
  assert.equal(setupStage(served({ account: "complete", network: "complete" })), "landed");
  assert.equal(setupStage(served({ account: "complete", network: "pending" })), "network");
  assert.equal(setupStage(served({ account: "pending", network: "complete" })), "account");
  assert.equal(setupStage(served({ account: "failed", network: "pending" }, { lastError: "account step crashed mid-bootstrap" })), "network");
  assert.equal(setupStage(served({ account: "failed", network: "complete" }, { lastError: "account step crashed mid-bootstrap" })), "account");
});

test("the wizard carries exactly two prompts", () => {
  assert.deepEqual(SETUP_STEPS, ["network", "account"]);
});

test("first and last names compose the family-facing name", () => {
  assert.equal(fullName("Brian", "Noah"), "Brian Noah");
  assert.equal(fullName("  Brian ", ""), "Brian");
  assert.equal(fullName(), "");
});

test("a submit missing a name shows the error on that empty field (PORCH-024)", () => {
  const both = joinNameErrors("", "");
  assert.equal(both.first, "Add your first name — this is who your family sees.");
  assert.equal(both.last, "Add your last name — this is who your family sees.");

  const firstOnly = joinNameErrors("Brian", "   ");
  assert.equal(firstOnly.first, "");
  assert.equal(firstOnly.last, "Add your last name — this is who your family sees.");

  const lastOnly = joinNameErrors("  ", "Noah");
  assert.equal(lastOnly.first, "Add your first name — this is who your family sees.");
  assert.equal(lastOnly.last, "");

  const complete = joinNameErrors("Brian", "Noah");
  assert.deepEqual(complete, { first: "", last: "" }, "a complete form carries no field errors");
});

test("resumed-setup copy never renders a data dump", () => {
  assert.equal(resumedDetail('quota settings: {"storageCeilingMb":1024}'), "Setup paused here earlier. Nothing was lost — continue below.");
  assert.equal(resumedDetail('network "Family" created'), 'Setup paused here earlier: network "Family" created. Continue below — nothing was lost.');
  assert.equal(resumedDetail(""), "");
  assert.equal(resumedDetail(null), "");
});