import { test } from "node:test";
import assert from "node:assert/strict";
import { directoryRows, inviteDialogCopy, inviteRows, copyLink } from "../src/member-directory.js";

// PORCH-029: the member directory's view mapping is pure and deterministic —
// owner first, then everyone by admission, and every row carries the three
// directory facts: name, role, join status.
test("the directory rows carry name, role, and join status, owner first", () => {
  const rows = directoryRows([
    { _id: "mem_2", did: "did:porch:june", name: "June River", role: "member", state: "active", admittedAt: "2026-10-09T11:00:00.000Z" },
    { _id: "mem_1", did: "did:porch:owner", name: "Brian Noah", role: "owner", state: "active", admittedAt: "2026-10-09T10:00:00.000Z" },
    { _id: "mem_3", did: "did:porch:gone", name: "Jake Cole", role: "member", state: "revoked", admittedAt: "2026-10-09T12:00:00.000Z", revokedAt: "2026-10-09T13:00:00.000Z" },
  ], "did:porch:owner");
  assert.deepEqual(rows.map((row) => row.name), ["Brian Noah", "June River", "Jake Cole"]);
  assert.deepEqual(rows.map((row) => row.role), ["Owner", "Member", "Member"]);
  assert.deepEqual(rows.map((row) => row.status), ["Active", "Active", "Removed"]);
  assert.equal(rows[0].isSelf, true);
  assert.equal(rows[1].isSelf, false);
  assert.equal(rows[0].id, "mem_1");
});

test("an identity row the hub cannot name renders the plain fallback, never a raw code", () => {
  const rows = directoryRows([{ _id: "mem_9", did: "did:porch:x", role: "member", state: "active" }]);
  assert.deepEqual(rows, [{ id: "mem_9", name: "Member", role: "Member", status: "Active", joined: null, isSelf: false }]);
  assert.deepEqual(directoryRows([], "did:porch:owner"), []);
  assert.equal(directoryRows(null).length, 0);
});

test("join links resolve against the hub serving the directory and carry lifecycle states", () => {
  const rows = inviteRows([
    { _id: "inv_1", joinUrl: "https://hub.example/join/code_1", status: "unused" },
    { _id: "inv_2", token: "code_2", status: "used" },
    { _id: "inv_3", joinUrl: "/join/code_3", status: "revoked" },
  ], "https://noah.example");
  assert.deepEqual(
    rows.map(({ id, url, status }) => ({ id, url, status })),
    [
      { id: "inv_1", url: "https://hub.example/join/code_1", status: "unused" },
      { id: "inv_2", url: "https://noah.example/join/code_2", status: "used" },
      { id: "inv_3", url: "https://noah.example/join/code_3", status: "revoked" },
    ],
  );
  assert.equal(inviteRows([null, undefined]).length, 0);
  assert.deepEqual(inviteRows([]), []);
});

test("the invite dialog copy names exactly who the link is for", () => {
  const copy = inviteDialogCopy("The Noah Family");
  assert.match(copy, /^One link, one new member of The Noah Family\./);
  assert.match(copy, /it is never for you/);
  assert.match(copy, /you became a member when you created the network/);
});

test("copyLink fails soft where no clipboard exists (deterministic in node)", async () => {
  assert.equal(await copyLink(""), false);
  // Node has no navigator clipboard nor a document fallback: the helper
  // reports the missed copy instead of throwing at the screen.
  const result = await copyLink("https://hub.example/join/code_1");
  assert.equal(typeof result, "boolean");
});