import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthService } from "../src/services/auth.service.js";

test("AuthService.createSession returns a session with token", () => {
  const auth = new AuthService();
  const session = auth.createSession({ id: "abc", userId: "user_1" });
  assert.equal(session.userId, "user_1");
  assert.equal(typeof session.token, "string");
  assert.ok(session.token.length > 0);
});

test("AuthService.validate accepts a well-formed session", () => {
  const auth = new AuthService();
  assert.equal(auth.validate({ userId: "user_1", token: "t" }), true);
  assert.equal(auth.validate({}), false);
});
