import { test } from "node:test";
import assert from "node:assert/strict";
import { isPresent } from "../src/index.js";

test("isPresent reports undefined/null/empty as absent", () => {
  assert.equal(isPresent(undefined), false);
  assert.equal(isPresent(null), false);
  assert.equal(isPresent(""), false);
});

test("isPresent reports values as present", () => {
  assert.equal(isPresent("x"), true);
  assert.equal(isPresent(0), true);
});
