import test from "node:test";
import assert from "node:assert/strict";
import { resolveStoredNames } from "../src/name-heal.js";

const connections = (names) => names.map(([id, name]) => ({
	url: "http://hub.test",
	deviceId: "dev_1",
	identity: { id, name },
}));

/** Fake device-session + hub IO recording what the heal actually sent. */
function io(responses) {
	const calls = [];
	return {
		calls,
		openDeviceSession: async (connection, registration) => {
			calls.push({ kind: "session", did: registration.did });
			return { accessToken: `tok_${registration.did}` };
		},
		request: async (connection, route, options) => {
			calls.push({ kind: "route", route, body: JSON.parse(options.body), token: connection.token });
			return responses;
		},
	};
}

test("resolveStoredNames heals device-local labels to hub-resolved member names", async () => {
	const record = io({ sessions: [{ name: "June River" }] });
	const updates = await resolveStoredNames(connections([["did_june", "Browser"]]), record);
	assert.deepEqual(updates, [{ id: "did_june", name: "June River" }]);
	const restore = record.calls.find((call) => call.route === "social/session/restore");
	assert.equal(restore.body.deviceId, "dev_1");
	assert.equal(restore.body.identityAccessToken, "tok_did_june");
});

test("resolveStoredNames changes nothing when the stored name already matches the hub", async () => {
	const record = io({ sessions: [{ name: "June River" }] });
	const updates = await resolveStoredNames(connections([["did_june", "June River"]]), record);
	assert.deepEqual(updates, []);
	assert.ok(record.calls.length > 0, "still re-credentials: resolution reads the hub, never a local memo");
});

test("resolveStoredNames leaves rows untouched on hub failure and heal the rest", async () => {
	const calls = [];
	const rows = connections([["did_a", "Browser"], ["did_b", "member"], ["did_c", "Name for tok_did_c"]]);
	const updates = await resolveStoredNames(rows, {
		openDeviceSession: async (connection, registration) => {
			if (registration.did === "did_b") throw new Error("vault unavailable");
			calls.push(registration.did);
			return { accessToken: `tok_${registration.did}` };
		},
		request: async (connection) => ({ sessions: [{ name: `Name for ${connection.token}` }] }),
	});
	assert.deepEqual(updates, [{ id: "did_a", name: "Name for tok_did_a" }]);
});

test("resolveStoredNames skips rows that cannot re-credential (non-device rows)", async () => {
	const calls = [];
	const rows = [
		{ url: "http://hub.test", identity: { id: "did_memberless", name: "Browser" } },
		{ deviceId: "dev_1", identity: { id: "did_nohub", name: "Browser" } },
		...connections([["did_linked", "Browser"]]),
	];
	const updates = await resolveStoredNames(rows, {
		openDeviceSession: async (connection, registration) => { calls.push(registration.did); return { accessToken: "tok" }; },
		request: async () => ({ sessions: [{ name: "Brian Noah" }] }),
	});
	assert.deepEqual(calls, ["did_linked"]);
	assert.deepEqual(updates, [{ id: "did_linked", name: "Brian Noah" }]);
});

test("resolveStoredNames handles empty storage and missing per-network names", async () => {
	assert.deepEqual(await resolveStoredNames([], io({})), []);
	const record = io({ sessions: [] });
	assert.deepEqual(await resolveStoredNames(connections([["did_june", "Browser"]]), record), []);
});