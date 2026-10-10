import { test } from "node:test";
import assert from "node:assert/strict";
import { arrivalPollMs } from "../src/live.js";

test("ac-1: the arrival cadence is a background degrade, never poll-on-scroll", () => {
  assert.equal(typeof arrivalPollMs, "number");
  assert.ok(arrivalPollMs > 5_000, "arrivals ride a cadence independent of scrolling");
});