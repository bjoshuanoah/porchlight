// signing.js — pkg signing resolution (PORCH-134).
//
// The deliverable of record is a SIGNED macOS installer/pkg (product-supply
// chain anchor). Signatures require a Developer ID identity in the build
// host's keychain; when none exists the build does NOT silently ship an
// unsigned artifact as if it were signed — it states the fact in plain
// language (never-silent law) so the operator knows Gatekeeper will reject
// it on a fresh Mac without an override.
//
// Prefer the Developer ID **Installer** certificate (the product-signing
// certificate for .pkg artifacts); fall back to any valid Developer ID
// identity; never guess.

/** Plain-language notice for an unsigned build. */
export const UNSIGNED_NOTICE =
	"no codesigning identity found — building an UNSIGNED .pkg. " +
	"Pass --sign-identity <id> or install a Developer ID Installer certificate; " +
	"unsigned packages cannot pass Gatekeeper on a machine without an explicit override.";

/**
 * @param {{
 *   identity?: string | null,
 *   run?: (file: string, args: string[]) => Promise<{stdout: string, status: number, error?: void}>,
 * }} [opts]
 * @returns {Promise<{identity: string | null, signed: boolean, source: "flag"|"keychain"|"none", notice: string | null}>}
 */
export async function resolveSigningIdentity({ identity, run = defaultRun } = {}) {
	if (identity) {
		return { identity, signed: true, source: "flag", notice: null };
	}
	const out = await run("security", ["find-identity", "-p", "codesigning", "-v"]);
	const candidates = parseIdentities(out.stdout);
	const installer = candidates.find((c) => c.includes("Developer ID Installer"));
	const anyDevId = candidates.find((c) => c.includes("Developer ID"));
	const chosen = installer ?? anyDevId ?? null;
	if (!chosen) {
		return { identity: null, signed: false, source: "none", notice: UNSIGNED_NOTICE };
	}
	return {
		identity: chosen,
		signed: true,
		source: "keychain",
		notice: null,
	};
}

/**
 * @param {string} stdout of `security find-identity -v`
 * @returns {string[]} identity CNs of valid identities
 */
export function parseIdentities(stdout) {
	/** @type {string[]} */
	const out = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!/^\s*\d+\)/.test(line)) continue;
		if (/CSSMERR|invalid|ERROR/.test(line)) continue;
		const name = line.match(/"(.+)"$/);
		if (name) out.push(name[1]);
	}
	return out;
}

/**
 * Designated code requirement string of a signed binary — the anchor the
 * deployment can pin on (e.g. for Gatekeeper/MDM code-requirement bookkeeping
 * and for tracking code identity across updates).
 * @param {string} binPath
 * @param {{run?: typeof defaultRun}} [opts]
 */
export async function codesignRequirement(binPath, { run = defaultRun } = {}) {
	const out = await run("codesign", ["-dr", "-", binPath]);
	if (out.status !== 0) {
		throw new Error(`codesign -dr - ${binPath} failed (exit ${out.status}): ${(out.stdout || "").trim()}`);
	}
	const line = String(out.stdout).split(/\r?\n/).find((l) => l.includes("=>"));
	if (!line) {
		throw new Error(`codesign -dr - ${binPath} printed no designated requirement: ${out.stdout.trim()}`);
	}
	return line.split("=>").pop()?.trim() ?? "";
}

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFileCb);

/** @param {string} file @param {string[]} args */
async function defaultRun(file, args) {
	try {
		const { stdout } = await execFileP(file, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 1 << 20 });
		return { stdout, status: 0 };
	} catch (err) {
		const e = /** @type {{code?: number, stdout?: string}} */ (err);
		return { stdout: String(e.stdout ?? ""), status: e.code ?? 1 };
	}
}
