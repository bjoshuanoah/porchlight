// signing.test.js — Developer ID resolution and requirement extraction (PORCH-134).

import test from "node:test";
import assert from "node:assert/strict";
import { UNSIGNED_NOTICE, codesignRequirement, parseIdentities, resolveSigningIdentity } from "../src/signing.js";

const NO_IDS = "     0 valid identities found\n";
const SOME_IDS = [
	'     5 valid identities found',
	'     1) 1111111111111111111111111111111111111111 "Developer ID Application: Porchlight Home (TEAM)"',
	'     2) 2222222222222222222222222222222222222222 "Developer ID Installer: Porchlight Home (TEAM)"',
	"     3) 3333333333333333333333333333333333333333 \"invalid identity (CSSMERR_TP_NOT_TRUSTED)\"",
	"",
].join("\n");

test("parseIdentities lists only valid quoted identities", () => {
	assert.deepEqual(parseIdentities(SOME_IDS), [
		"Developer ID Application: Porchlight Home (TEAM)",
		"Developer ID Installer: Porchlight Home (TEAM)",
	]);
	assert.deepEqual(parseIdentities(NO_IDS), []);
});

test("flag identity wins; keychain prefers the Installer certificate", async () => {
	const flagged = await resolveSigningIdentity({ identity: "Custom Identity", run: assert.fail.bind() });
	assert.deepEqual(flagged, { identity: "Custom Identity", signed: true, source: "flag", notice: null });
	const keychain = await resolveSigningIdentity({ run: async (_f, _a) => ({ stdout: SOME_IDS, status: 0 }) });
	assert.equal(keychain.identity, "Developer ID Installer: Porchlight Home (TEAM)");
	assert.equal(keychain.source, "keychain");
	assert.equal(keychain.signed, true);
});

test("an application-only keychain still signs; an empty keychain refuses silently-with-notice", async () => {
	const appOnly = await resolveSigningIdentity({ run: async (_f, _a) => ({ stdout: SOME_IDS.replace(/Developer ID Installer[^\n]*\n/, ""), status: 0 }) });
	assert.equal(appOnly.identity, "Developer ID Application: Porchlight Home (TEAM)");
	const none = await resolveSigningIdentity({ run: async (_f, _a) => ({ stdout: NO_IDS, status: 0 }) });
	assert.equal(none.identity, null);
	assert.equal(none.signed, false);
	assert.equal(none.notice, UNSIGNED_NOTICE);
	assert.match(UNSIGNED_NOTICE, /Developer ID Installer/);
});

test("codesignRequirement extracts the designated requirement string", async () => {
	const run = async () => ({
		stdout: `Executable=/Library/Porchlight/bin/porchlight-home\nIdentifier=com.porchlight.home\ndesignated => identifier "com.porchlight.home" and anchor apple generic\n`,
		status: 0,
	});
	const req = await codesignRequirement("/x/y", { run });
	assert.equal(req, 'identifier "com.porchlight.home" and anchor apple generic');
	await assert.rejects(
		() => codesignRequirement("/x/y", { run: async () => ({ stdout: "", status: 1 }) }),
		/failed \(exit 1\)/,
	);
});
