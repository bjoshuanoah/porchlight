// audit.test.js — the source.url visibility law (PORCH-154 hard law).
//
// source.url may be read ONLY by packages/stream (this plane opens the one
// upstream connection per camera and never hands the URL onward) plus the
// config plane's registration of record. This audit walks every engine
// package's src tree, matches every /source(?:\?)?\.url/ occurrence, and
// proves the world: every match lives in the allowlist below or inside
// packages/stream/src/**, with ZERO matches in packages/audio/src and
// packages/detection/src (consumer packages that must never resolve a
// camera themselves).
//
// Allowlist notes:
//   - packages/recorder/src/args.js matches only comment/ refusal-message
//     text after the PORCH-154 relay-input refactor (its ffmpeg argv carries
//     the relay URL, never source.url) — the entry stays because the audit
//     regex reads those words in prose.
//   - packages/recorder/src/config.js holds the writer-side shape check that
//     a camera row carries source.url or source.synthetic (validation only;
//     the manager alone ever OPENS a camera connection).
//   - packages/config/src/stream-validate.js is the config plane's probe
//     surface of record; it is allowed whether or not a given cut names
//     source.url.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Packages whose src trees are audited (this task's sweep scope). */
const AUDIT_PACKAGES = ["recorder", "detection", "audio", "config", "installer", "overwatch", "recognition"];

const SOURCE_URL_RE = /source(?:\?)?\.url/g;

/** Files allowed to match (repo-root-relative, POSIX separators). */
const ALLOWLIST = new Set([
	"packages/config/src/engine-cameras.js",
	"packages/config/src/stream-validate.js",
	"packages/recorder/src/args.js",
	"packages/recorder/src/config.js",
]);

const FORBIDDEN_DIRS = ["packages/audio/src", "packages/detection/src"];

/** @param {string} dir @returns {string[]} every .js file (POSIX-relative to REPO_ROOT) */
function jsFiles(dir) {
	const abs = path.join(REPO_ROOT, dir);
	const out = [];
	for (const entry of fs.readdirSync(abs, { withFileTypes: true, recursive: true })) {
		const file = entry.isFile() ? entry.name : path.join(entry.parentPath ?? entry.path, entry.name);
		if (entry.isFile() && file.endsWith(".js")) {
			out.push(path.relative(REPO_ROOT, path.join(abs, file)).split(path.sep).join("/"));
		}
	}
	return out;
}

/** @returns {{ file: string, line: number, snippet: string }[]} */
function sweep() {
	/** @type {{ file: string, line: number, snippet: string }[]} */
	const matches = [];
	const dirs = [
		...AUDIT_PACKAGES.map((p) => `packages/${p}/src`),
		"packages/stream/src",
	];
	for (const dir of dirs) {
		for (const relPath of jsFiles(dir)) {
			const lines = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8").split("\n");
			for (let i = 0; i < lines.length; i++) {
				SOURCE_URL_RE.lastIndex = 0;
				if (SOURCE_URL_RE.test(lines[i])) {
					matches.push({ file: relPath, line: i + 1, snippet: lines[i].trim().slice(0, 120) });
				}
			}
		}
	}
	return matches;
}

test("source.url law: every match inside the allowlist + packages/stream/src; zero in audio/detection", () => {
	const matches = sweep();
	assert.ok(matches.length > 0, "the sweep must walk real files (found none) — audit is not a no-op");

	// hard law: consumer packages never read source.url
	for (const forbidden of FORBIDDEN_DIRS) {
		const hits = matches.filter((m) => m.file.startsWith(`${forbidden}/`));
		assert.deepEqual(hits, [], `ZERO source.url matches are allowed in ${forbidden} (consumer packages never open camera connections), found ${hits.length}`);
	}

	// allowlist + stream/src law
	const violations = matches.filter((m) => !ALLOWLIST.has(m.file) && !m.file.startsWith("packages/stream/src/"));
	assert.deepEqual(
		violations,
		[],
		`every source.url match must live in the allowlist or packages/stream/src — outside matches:\n${violations.map((v) => `  ${v.file}:${v.line} ${v.snippet}`).join("\n")}`,
	);

	// provenance evidence: the audit names the current world, and this plane
	// (the one legitimate reader) is visible in it.
	const byFile = new Map();
	for (const m of matches) byFile.set(m.file, (byFile.get(m.file) ?? 0) + 1);
	const streamFiles = [...byFile.keys()].filter((f) => f.startsWith("packages/stream/src/"));
	assert.ok(streamFiles.length > 0, "packages/stream/src reads source.url — that is the plane of record; the sweep must see it");
	const report = [...byFile.entries()].sort().map(([file, count]) => `${file} (${count})`).join(", ");
	console.log(`[audit] source.url matches: ${report}`);
});
