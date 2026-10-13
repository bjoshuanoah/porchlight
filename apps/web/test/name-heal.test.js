import test from "node:test";
import assert from "node:assert/strict";
import { resolveStoredNames } from "../src/name-heal.js";

const connections = (names) => names.map(([id, name]) => ({
	url: "http://hub.test",
	deviceId: "dev_1",
	identity: { id, name },
	token: `stored_${id}`,
	refreshToken: `stored-refresh_${id}`,
}));

/** Fake device-session + hub IO recording what the heal actually sent. */
function io(responses, { restoreFails = false } = {}) {
	const calls = [];
	return {
		calls,
		openDeviceSession: async (connection, registration) => {
			calls.push({ kind: "session", did: registration.did });
			return { accessToken: `tok_${registration.did}`, refreshToken: `fresh-refresh_${registration.did}` };
		},
		request: async (connection, route, options) => {
			calls.push({ kind: "route", route, body: JSON.parse(options.body), token: connection.token });
			if (restoreFails) throw Object.assign(new Error("refused"), { status: 403 });
			return responses;
		},
	};
}

test("the sweep adopts what it mints: identity session, membership tokens, and the healed name", async () => {
	const record = io({ sessions: [{ name: "June River", accessToken: "member-2", refreshToken: "member-refresh-2", networkId: "net_1" }] });
	const updates = await resolveStoredNames(connections([["did_june", "Browser"]]), record);
	assert.deepEqual(updates, [{
		id: "did_june",
		name: "June River",
		identityToken: "tok_did_june",
		identityRefreshToken: "fresh-refresh_did_june",
		token: "member-2",
		refreshToken: "member-refresh-2",
		networkId: "net_1",
	}]);
	const restore = record.calls.find((call) => call.route === "social/session/restore");
	assert.equal(restore.body.deviceId, "dev_1");
	assert.equal(restore.body.identityAccessToken, "tok_did_june");
});

test("a refused restore limits adoption to the identity plane it minted", async () => {
	const record = io({}, { restoreFails: true });
	const updates = await resolveStoredNames(connections([["did_june", "Browser"]]), record);
	assert.deepEqual(updates, [{
		id: "did_june",
		name: "Browser",
		identityToken: "tok_did_june",
		identityRefreshToken: "fresh-refresh_did_june",
	}]);
});

test("resolveStoredNames changes nothing when the hub is unreachable", async () => {
	const record = { openDeviceSession: async () => { throw new Error("offline"); }, request: async () => { throw new Error("offline"); } };
	const updates = await resolveStoredNames(connections([["did_june", "Browser"]]), record);
	assert.deepEqual(updates, []);
});

test("resolveStoredNames skips rows that cannot re-credential (non-device rows)", async () => {
	const calls = [];
	const rows = [
		{ url: "http://hub.test", identity: { id: "did_memberless", name: "Browser" } },
		{ deviceId: "dev_1", identity: { id: "did_nohub", name: "Browser" } },
		...connections([["did_linked", "Browser"]]),
	];
	const updates = await resolveStoredNames(rows, {
		openDeviceSession: async (connection, registration) => { calls.push(registration.did); return { accessToken: "tok", refreshToken: "refresh-tok" }; },
		request: async () => ({ sessions: [{ name: "Brian Noah", accessToken: "member-2", refreshToken: "member-refresh-2", networkId: "net_1" }] }),
	});
	assert.deepEqual(calls, ["did_linked"]);
	assert.deepEqual(updates, [{
		id: "did_linked",
		name: "Brian Noah",
		identityToken: "tok",
		identityRefreshToken: "refresh-tok",
		token: "member-2",
		refreshToken: "member-refresh-2",
		networkId: "net_1",
	}]);
});

test("resolveStoredNames handles empty storage and memberless restore answers", async () => {
	assert.deepEqual(await resolveStoredNames([], io({})), []);
	// A restore that answers with no membership rows still adopts the mint.
	const record = io({ sessions: [] });
	assert.deepEqual(await resolveStoredNames(connections([["did_june", "Browser"]]), record), [{
		id: "did_june",
		name: "Browser",
		identityToken: "tok_did_june",
		identityRefreshToken: "fresh-refresh_did_june",
	}]);
});
