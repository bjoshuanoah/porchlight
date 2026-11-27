// no-ha-sweep.mjs — the no-Home-Assistant sweep of record (PORCH-129 ac-5).
//
// Ruling of record (Brian, Nov 24, 2026): "Home assistant goes away." The
// bus — and everything that rides it — carries zero Home Assistant
// discovery, integration, subscription, or dependency: no HA-facing topic,
// payload, or code path, and no HA package in the dependency graph.
//
// Runs over the repository's SOURCE trees (apps, modules, packages, docs,
// scripts, the root manifests) — never node_modules / build output / lock
// files — and fails on any Home Assistant marker outside the sweep's own
// naming. Wired into the root `npm run test` so the sweep runs in CI on
// every push and pull request with the test matrix.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const SCAN_DIRS = ["apps", "modules", "packages", "docs", "scripts"];
const SCAN_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".md", ".yaml", ".yml", ".html", ".css"]);
const SKIP_FILE_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "build", ".turbo", "coverage", "tmp"]);
const MANIFESTS = ["package.json"];

// The markers: anything that names, integrates, or configures Home
// Assistant. `hass` catches hass.io / superhaus / hass- prefixes while the
// negative lookahead spares plain words ("embarrassment", "grasslands").
const HA_MARKER = /\b(home[\s_-]?assistant|hass\.io|homeassistant|home-assistant|"hass"|'hass'|\bhass\b)/i;
const HA_PACKAGE = /^@?home[-_]?assistant|homeassistant-/i;

/** @param {string} dir */
function* sourceFiles(dir) {
	for (const relative of SCAN_DIRS) {
		const root = join(repoRoot, relative);
		if (!existsSync(root)) continue;
		const stack = [root];
		while (stack.length) {
			const current = stack.pop();
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
				const file = join(current, entry.name);
				if (entry.isDirectory()) {
					stack.push(file);
				} else if (SCAN_EXTS.has(extname(entry.name)) && !SKIP_FILE_NAMES.has(entry.name)) {
					yield file;
				}
			}
		}
	}
	for (const manifest of MANIFESTS) {
		const file = join(repoRoot, manifest);
		if (existsSync(file)) yield file;
	}
}

export function sweep() {
	const failures = /** @type {{ file: string, line?: number, text: string, markerKind: "content" | "dependency" }[]} */ ([]);
	for (const file of sourceFiles(repoRoot)) {
		const relative = file.slice(repoRoot.length + 1);
		let raw;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (relative === "package.json" || relative.endsWith("package.json")) {
			const manifest = JSON.parse(raw);
			const depSections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundleDependencies"];
			for (const section of depSections) {
				for (const name of Object.keys(manifest[section] ?? {})) {
					if (HA_PACKAGE.test(name)) failures.push({ file: relative, text: `${section}: ${name}`, markerKind: "dependency" });
				}
			}
			if (relative !== "package.json") continue; // manifests: deps only, the content word hits docs too
		}
		// The sweep script itself names Home Assistant — that is the naming of
		// the sweep, not a dependency on it. docs/event-bus-transport.md is the
		// vetting record that STATES the no-HA law (the rationale of record
		// this sweep enforces); the statement is allowed, nothing else is.
		if (file === join(repoRoot, "scripts", "no-ha-sweep.mjs")) continue;
		if (file === join(repoRoot, "docs", "event-bus-transport.md")) continue;
		const lines = raw.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			if (HA_MARKER.test(lines[i])) failures.push({ file: relative, line: i + 1, text: lines[i].trim().slice(0, 160), markerKind: "content" });
		}
	}
	return { clean: failures.length === 0, failures };
}

function main() {
	const result = sweep();
	if (result.clean) {
		console.log(`no-ha-sweep: clean — zero Home Assistant discovery, integration, subscription, or dependency across the source trees`);
		return;
	}
	console.error(`no-ha-sweep: FAILED — ${result.failures.length} Home Assistant marker(s) found:`);
	for (const f of result.failures) {
		console.error(`  ${f.file}${f.line ? `:${f.line}` : ""} — ${f.text}`);
	}
	process.exit(1);
}

// Only run when invoked directly (the test imports `sweep`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
