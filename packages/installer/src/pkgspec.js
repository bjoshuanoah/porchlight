// pkgspec.js — the pkgbuild project: install scripts + build (PORCH-134).
//
// Builds `porchlight-home-<version>.pkg`: payload (payload.js), install
// scripts (postinstall runs the first-run bootstrap), and the signing
// decision (signing.js — an unsigned build states itself, never silently).
// The deploy command of record for a fresh Mac:
//
//   sudo installer -pkg porchlight-home-<version>.pkg -target /
//
// (or an MDM-deployed installation — both headless, no GUI interaction).

import fsDefault from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { assemblePayload } from "./payload.js";
import { resolveSigningIdentity, UNSIGNED_NOTICE } from "./signing.js";
import { DEFAULT_ROOT } from "./config.js";

const execFileP = promisify(execFileCb);

/**
 * The install scripts. pkgbuild runs them as root on the deployment Mac.
 * Only postinstall exists — everything else (directories, config of
 * record, daemon plist, launchd registration, verification) lives in one
 * idempotent code path the CLI shares (src/bootstrap.js), so manual and
 * installer flows cannot drift.
 * @param {{root?: string}} [opts]
 */
export function buildInstallScripts({ root = DEFAULT_ROOT } = {}) {
	return {
		postinstall: `#!/bin/bash
# Porchlight Home postinstall — first-run bootstrap (PORCH-134).
set -euo pipefail
ROOT="${root}"
echo "Porchlight Home: running first-run bootstrap…"
"$ROOT/bin/porchlight-home" bootstrap
echo "Porchlight Home: bootstrap complete and verified."
`,
	};
}

/** @param {string} text */
function execBits(text) {
	return {
		text,
		mode: 0o755,
	};
}

/**
 * Build the distribution pkg.
 * @param {{
 *   repoRoot: string,
 *   out: string,
 *   version: string,
 *   identifier?: string,
 *   signIdentity?: string | null,
 *   nodePath?: string | null,
 *   run?: typeof execFileP,
 *   fs?: typeof fsDefault,
 *   log?: (line: string) => void,
 * }} opts
 * @returns {Promise<{pkg: string, signed: boolean, payloadRoot: string}>}
 */
export async function buildPkg({
	repoRoot,
	out,
	version,
	identifier = "com.porchlight.home",
	signIdentity,
	nodePath,
	run = execFileP,
	fs: fsMod = fsDefault,
	log = console.log,
} = {}) {
	const staging = fsMod.mkdtempSync(path.join(os.tmpdir(), "porchlight-pkg-"));
	const payloadRoot = path.join(staging, "payload");
	const scriptsDir = path.join(staging, "scripts");
	fsMod.mkdirSync(scriptsDir, { recursive: true });
	try {
		assemblePayload({ repoRoot, payloadRoot, includeNode: nodePath ?? null, fs: fsMod, log });
		const scripts = buildInstallScripts();
		fsMod.writeFileSync(path.join(scriptsDir, "postinstall"), execBits(scripts.postinstall).text, { encoding: "utf8", mode: 0o755 });

		const resolved = await resolveSigningIdentity({ identity: signIdentity ?? undefined });
		if (!resolved.signed) {
			log(`[pkg] NOTICE: ${UNSIGNED_NOTICE}`);
		} else {
			log(`[pkg] signing with: ${resolved.identity} (${resolved.source})`);
		}
		if (resolved.signed && !/^Developer ID/.test(resolved.identity)) {
			log(`[pkg] WARNING: "${resolved.identity}" is not a Developer ID identity — distribution-signed pkgs require one.`);
		}

		const argv = [
			"--root", payloadRoot,
			"--identifier", identifier,
			"--version", version,
			"--install-location", "/",
			"--scripts", scriptsDir,
		];
		if (resolved.identity) {
			argv.push("--sign", resolved.identity);
		}
		argv.push(out);
		await run("pkgbuild", argv);
		return { pkg: out, signed: resolved.signed, payloadRoot };
	} finally {
		// pkgbuild has consumed the payload; keep scripts for postmortem on
		// failure paths only.
		fsMod.rmSync(payloadRoot, { recursive: true, force: true });
	}
}
