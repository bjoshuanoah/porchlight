/**
 * The owner-console address panel model (PORCH-066): the register-the-new-
 * domain screen over the reauth status surface (PORCH-065). Pure view tests,
 * no DOM — the audit gate (test/audit.test.js) carries the family-copy rule,
 * and the console reachability pin (test/console-tabs.test.js) carries the
 * panel's tab mapping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	addressPanelModel, draftHost, addressConsequences, addressIntro, addressRerunNote,
	addressConsequenceNames, redirectTarget,
} from "../src/address-panel.js";
import { bootRoute, selfGrantArrival, readSignedOut } from "../src/front-state.js";

test("the panel reads the hub's address as name + URL from the reauth status surface (ac-1)", () => {
	const reauth = {
		servingOrigin: "https://porch.love", networkHubUrl: "https://porch.love",
		lastRepoint: { origin: "https://porch.love", at: "2026-10-13T20:00:00.000Z", surface: "console" },
		residue: [],
	};
	const panel = addressPanelModel({ reauth, server: { url: "https://hub.test", name: "The Noah Family" }, networkName: "The Noah Family" });
	assert.equal(panel.url, "https://porch.love");
	assert.equal(panel.name, "The Noah Family");
	assert.equal(panel.lastRepoint.surface, "console");
	assert.deepEqual(panel.residue, []);
});

test("the panel falls back to the serving connection and to plain unavailability (ac-1)", () => {
	// A hub that has never been re-pointed reports no reauth row (pre-065
	// shape): the panel still reads the hub's address from the open session.
	const panel = addressPanelModel({ reauth: null, server: { url: "https://hub.test" }, networkName: "The Noah Family" });
	assert.equal(panel.url, "https://hub.test");
	assert.equal(panel.lastRepoint, null);
	assert.equal(addressPanelModel({ reauth: null, server: null, networkName: "The Noah Family" }).url, null);
});

test("the draft guard takes the hostname only and never a scheme, path, or user info (ac-1)", () => {
	assert.deepEqual(draftHost("porch.love"), { host: "porch.love", error: "" });
	assert.deepEqual(draftHost("  https://porch.love  "), { host: "porch.love", error: "" });
	assert.ok(draftHost("porch.love/path").error);
	assert.ok(draftHost("one two").error);
	assert.ok(draftHost("june@porch.love").error);
	assert.ok(draftHost("").error);
});

test("the redirect is exactly the URL the server minted, never a client construct (ac-2)", () => {
	assert.equal(redirectTarget({ redirectUrl: "https://porch.love/device-link/dk_123?reauth=1" }), "https://porch.love/device-link/dk_123?reauth=1");
	assert.equal(redirectTarget({}), null);
	assert.equal(redirectTarget(null), null);
});

test("the move-time consequence guidance names all four consequences in family copy (ac-4)", () => {
	assert.equal(addressConsequenceNames.join("\n"), "joinLinks\nnotifications\nclientState\norphanedDevices");
	const text = addressConsequences.map((item) => item.line).join("\n").toLowerCase();
	assert.match(text, /join links made before the move stop working/);
	assert.match(text, /notifications.*reconnect.*on their own/);
	assert.match(text, /start fresh/);
	assert.match(text, /removed from the members tab/);
	// Family language: no security-dashboard vocabulary in the guidance.
	for (const banned of ["security", "revoke", "orphan", "subscription", "credentials", "reauth"]) {
		assert.ok(!text.includes(banned), `the panel copy avoids "${banned}"`);
	}
	assert.match(addressIntro, /moments and accounts stay put/);
	assert.match(addressRerunNote, /safe/);
	assert.ok(!text.includes("did"));
});

test("the self-grant redirect's arrival carries the consume scope marker (ac-3)", () => {
	assert.equal(selfGrantArrival("?reauth=1"), true);
	assert.equal(selfGrantArrival("?device-link=dk_1&reauth=1"), true);
	assert.equal(selfGrantArrival(""), false);
	assert.equal(selfGrantArrival("?reauth=0"), false);
	assert.equal(selfGrantArrival("?invite=inv-code_1"), false);
});

test("the auto-consume scope is marker-only: a member link by any other channel keeps the consume screen (ac-3)", () => {
	// The marker rides only the console path's redirect (PORCH-065 mints it);
	// the normal member-channel deep link is bare.
	assert.equal(selfGrantArrival(new URL("https://porch.love/device-link/dk_123").search), false);
	assert.equal(selfGrantArrival(new URL("https://porch.love/device-link/dk_123?reauth=1").search), true);
});

test("the arrival flow rides the same deep-link precedence — the front state never traps the link (ac-3)", () => {
	// The /device-link path passes through boot routing untouched (its own
	// route owns consumption), marker or not.
	const connections = [{ url: "http://hub.test", identity: { id: "june" }, deviceId: "dev-1" }];
	assert.equal(bootRoute({ pathname: "/device-link/dk_123", search: "?reauth=1", connections, signedOut: true }), "/device-link/dk_123");
	assert.equal(bootRoute({ pathname: "/device-link/dk_123", search: "", connections, signedOut: true }), "/device-link/dk_123");
	assert.ok(readSignedOut({ getItem: () => null }, "https://hub.test") === false);
});

// Source pins (the render's contract, per the pinned-source test pattern:
// the SPA harness never mounts components — the strings and wiring below
// must appear in the shipped screens verbatim).
const identitySource = await readFile(new URL("../src/identity.jsx", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");

test("the arrival beat renders and auto-consumes only under the self-grant marker (ac-3)", () => {
	assert.match(identitySource, /const arrive = selfGrantArrival\(window\.location\.search\);/);
	assert.match(identitySource, /<CircularProgress size=\{32\} aria-label=\{arrivalBeatCopy\}/);
	// The beat screen shows the marker's consume in flight, then falls back
	// to the normal consume screen the moment the consume refuses.
	assert.match(identitySource, /operation\.setError\(cause\?\.body\?\.error \|\| memberError\(cause\)\);/);
});

test("the address action posts the one field and leaves through the server-minted redirect (ac-1)", () => {
	// The action is one owner-session POST with the hostname, and the browser
	// leaves through redirectTarget — never a client-constructed URL.
	assert.match(
		mainSource,
		/changeAddress: \(host\) => request\(active, "social\/console\/address", \{ method: "POST", body: JSON\.stringify\(\{ host \}\) \}\)/,
	);
	assert.match(identitySource, /const target = redirectTarget\(result\);/);
	assert.match(identitySource, /window\.location\.assign\(target\);/);
});

test("the panel's refusal paths surface the hub's plain language verbatim, zero mutation (ac-2)", () => {
	// submitAddress renders the refusal from the response body, and the
	// moving beat never redirects on a missing redirect URL.
	assert.match(identitySource, /const draft = draftHost\(hostDraft\);/);
	assert.match(identitySource, /The hub accepted the change but never named the new address\./);
	assert.match(identitySource, /Register this address<\/Button>/);
});