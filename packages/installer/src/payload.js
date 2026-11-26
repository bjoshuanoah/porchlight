// payload.js — assembles the installer payload root (PORCH-134).
//
// pkgbuild receives a payload directory laid out at the install location
// (`--install-location /`): Library/Porchlight carries the engine packages,
// the runtime entry, and the `porchlight-home` launcher. Only what the
// platform runtime actually imports ships: no test trees, no soak fixtures,
// no dev toolchains.

import fsDefault from "node:fs";
import path from "node:path";

export const PAYLOAD_PACKAGES = ["installer", "recorder", "hal"];
export const PAYLOAD_MODULES = ["yaml"];
/** Directory names never shipped in a package copy (soak harness rides along — ops tooling, not a test). */
const EXCLUDED_DIRS = new Set(["test", "node_modules"]);
const EXCLUDED_PREFIX_RE = /^e2e-soak-/;

/** @param {string} name */
function excluded(name) {
	return EXCLUDED_DIRS.has(name) || EXCLUDED_PREFIX_RE.test(name);
}

/** Recursive copy honoring the exclusion rules. @param {{fs?: typeof fsDefault}} [opts] */
export function copyTree(src, dest, { fs: fsMod = fsDefault } = {}) {
	fsMod.mkdirSync(dest, { recursive: true });
	for (const entry of fsMod.readdirSync(src, { withFileTypes: true })) {
		const from = path.join(src, entry.name);
		const to = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			if (excluded(entry.name)) continue;
			copyTree(from, to, { fs: fsMod });
		} else if (entry.isFile()) {
			fsMod.copyFileSync(from, to);
		}
	}
}

/**
 * The `porchlight-home` launcher sh script: resolves the bundled runtime
 * first, then the system PATH; checks the node floor; plain-language
 * failure. `PORCHLIGHT_ROOT` override keeps the launcher testable in
 * staged roots.
 * @param {{nodeFloor?: number}} [opts]
 */
export function launcherScript({ nodeFloor = 24 } = {}) {
	const lines = [
		"#!/bin/bash",
		"# porchlight-home — Porchlight Home engine CLI launcher (PORCH-134).",
		"set -euo pipefail",
		'ROOT="${PORCHLIGHT_ROOT:-/Library/Porchlight}"',
		`NODE_MIN=${nodeFloor}`,
		'BUNDLED="$ROOT/bin/runtime/node"',
		"find_node() {",
		'	if [ -x "$BUNDLED" ]; then echo "$BUNDLED"; return 0; fi',
		"	for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do",
		'		[ -x "$c" ] && { echo "$c"; return 0; }',
		"	done",
		"	command -v node",
		"}",
		'NODE_BIN="$(find_node)" || {',
		'	echo "Porchlight Home needs Node.js $NODE_MIN+ on this Mac." >&2',
		'	echo "Install Node $NODE_MIN or later, or rebuild the installer with --node <path>." >&2',
		"	exit 1",
		"}",
		'NODE_MAJOR="$("$NODE_BIN" -p \'process.versions.node.split(".")[0]\' 2>/dev/null || echo 0)"',
		'if [ "$NODE_MAJOR" -lt "$NODE_MIN" ]; then',
		'	echo "Porchlight Home needs Node.js $NODE_MIN+ (found $("$NODE_BIN" --version) at $NODE_BIN)." >&2',
		"	exit 1",
		"fi",
		'exec "$NODE_BIN" "$ROOT/packages/installer/bin/installer.js" "$@"',
		"",
	];
	return lines.join("\n");
}

/**
 * Assemble the payload at `payloadRoot` laid out for `--install-location /`.
 * @param {{
 *   repoRoot: string,
 *   payloadRoot: string,
 *   includeNode?: string | null,
 *   fs?: typeof fsDefault,
 *   log?: (line: string) => void,
 * }} opts
 */
export function assemblePayload({ repoRoot, payloadRoot, includeNode, fs: fsMod = fsDefault, log = console.log } = {}) {
	const root = path.join(payloadRoot, "Library", "Porchlight");
	// Packages (shipped trimmed: runtime import graph only).
	for (const name of PAYLOAD_PACKAGES) {
		copyTree(path.join(repoRoot, "packages", name), path.join(root, "packages", name), { fs: fsMod });
	}
	log(`[payload] packages shipped: ${PAYLOAD_PACKAGES.join(", ")}`);
	// Node modules: real deps (yaml is dependency-free) hoisted at the root,
	// workspace packages linked the way npm links them.
	for (const name of PAYLOAD_MODULES) {
		copyTree(path.join(repoRoot, "node_modules", name), path.join(root, "node_modules", name), { fs: fsMod });
	}
	fsMod.mkdirSync(path.join(root, "node_modules", "@porchlight"), { recursive: true });
	for (const name of PAYLOAD_PACKAGES) {
		fsMod.symlinkSync(`../../packages/${name}`, path.join(root, "node_modules", "@porchlight", name));
	}
	// Launcher + logs/recordings/config land at bootstrap, but the bin
	// directory must exist for the bundled runtime.
	fsMod.mkdirSync(path.join(root, "bin", "runtime"), { recursive: true });
	fsMod.writeFileSync(path.join(root, "bin", "porchlight-home"), launcherScript(), { encoding: "utf8", mode: 0o755 });
	if (includeNode) {
		fsMod.copyFileSync(includeNode, path.join(root, "bin", "runtime", "node"));
		fsMod.chmodSync(path.join(root, "bin", "runtime", "node"), 0o755);
		log(`[payload] bundled node runtime: ${includeNode}`);
	}
	return { root, launcher: path.join(root, "bin", "porchlight-home") };
}
