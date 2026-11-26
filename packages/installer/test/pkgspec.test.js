// pkgspec.test.js — payload assembly + pkgbuild spec + install scripts (PORCH-134).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assemblePayload, copyTree, launcherScript, PAYLOAD_PACKAGES } from "../src/payload.js";
import { buildInstallScripts, buildPkg } from "../src/pkgspec.js";
import { UNSIGNED_NOTICE } from "../src/signing.js";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("copyTree ships the runtime import graph only — no tests, no soak fixtures", () => {
	const src = fs.mkdtempSync(path.join(os.tmpdir(), "porch-src-"));
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "porch-dst-"));
	try {
		fs.mkdirSync(path.join(src, "src"), { recursive: true });
		fs.writeFileSync(path.join(src, "src", "a.js"), "export {};\n", "utf8");
		for (const skip of ["test", "e2e-soak-1f38-vh6v"]) {
			fs.mkdirSync(path.join(src, skip), { recursive: true });
			fs.writeFileSync(path.join(src, skip, "x.js"), "junk", "utf8");
		}
		copyTree(src, path.join(dest, "pkg"));
		const copied = path.join(dest, "pkg");
		assert.ok(fs.existsSync(path.join(copied, "src", "a.js")));
		assert.ok(!fs.existsSync(path.join(copied, "test")));
		assert.ok(!fs.existsSync(path.join(copied, "e2e-soak-1f38-vh6v")));
	} finally {
		fs.rmSync(src, { recursive: true, force: true });
		fs.rmSync(dest, { recursive: true, force: true });
	}
});

test("assemblePayload lays out Library/Porchlight with packages, hoisted deps, and the launcher", () => {
	const payloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), "porch-pay-"));
	try {
		const logLines = [];
		const result = assemblePayload({ repoRoot, payloadRoot, log: (l) => logLines.push(l) });
		const root = result.root;
		for (const name of PAYLOAD_PACKAGES) {
			assert.ok(fs.existsSync(path.join(root, "packages", name, "package.json")), name);
			assert.ok(fs.existsSync(path.join(root, "node_modules", "@porchlight", name)), `${name} linked`);
			const link = fs.readlinkSync(path.join(root, "node_modules", "@porchlight", name));
			assert.equal(link, `../../packages/${name}`);
		}
		// runtime deps hoisted; workspace imports resolve through the layout
		assert.ok(fs.existsSync(path.join(root, "node_modules", "yaml", "package.json")));
		assert.ok(fs.statSync(path.join(result.launcher)).mode & 0o111, "launcher is executable");
		const launcher = fs.readFileSync(result.launcher, "utf8");
		assert.ok(launcher.includes('packages/installer/bin/installer.js" "$@"'));
		assert.ok(launcher.includes("PORCHLIGHT_ROOT"));
		// no test trees inside the payload; the soak harness rides along as ops tooling
		assert.ok(!fs.existsSync(path.join(root, "packages", "recorder", "test")));
		assert.ok(fs.existsSync(path.join(root, "packages", "recorder", "soak", "run-soak.mjs")));
		assert.ok(logLines.some((l) => l.includes("packages shipped")));
	} finally {
		fs.rmSync(payloadRoot, { recursive: true, force: true });
	}
});

test("the launcher script resolves bundled node first, PATH second, floor-checked", () => {
	const sh = launcherScript({ nodeFloor: 24 });
	assert.match(sh, /\$BUNDLED/);
	assert.match(sh, /NODE_MIN=24/);
	for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
		assert.ok(sh.includes(candidate));
	}
	assert.match(sh, /needs Node\.js/);
});

test("postinstall is the single idempotent bootstrap path, with the root of record", () => {
	const scripts = buildInstallScripts();
	assert.match(scripts.postinstall, /set -euo pipefail/);
	assert.match(scripts.postinstall, /ROOT="\/Library\/Porchlight"/);
	assert.match(scripts.postinstall, /"\$ROOT\/bin\/porchlight-home" bootstrap/);
	const staged = buildInstallScripts({ root: "/staged/Porchlight" });
	assert.match(staged.postinstall, /ROOT="\/staged\/Porchlight"/);
});

test("buildPkg assembles the payload and invokes pkgbuild with the signing decision", async () => {
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "porch-pkg-"));
	const out = path.join(outDir, "porchlight-home-0.5.3.pkg");
	/** @type {{file: string, args: string[]}[]} */
	const calls = [];
	const logs = [];
	try {
		const result = await buildPkg({
			repoRoot,
			out,
			version: "0.5.3",
			run: async (file, args) => {
				calls.push({ file, args });
				fs.writeFileSync(out, "fake pkg", "utf8");
				return { stdout: "", status: 0 };
			},
			log: (l) => logs.push(l),
		});
		assert.equal(result.signed, false);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].file, "pkgbuild");
		const argv = calls[0].args;
		assert.equal(argv[argv.indexOf("--identifier") + 1], "com.porchlight.home");
		assert.equal(argv[argv.indexOf("--version") + 1], "0.5.3");
		assert.equal(argv[argv.indexOf("--install-location") + 1], "/");
		assert.ok(!argv.includes("--sign"), "no identity → no --sign, and the consequence is stated");
		assert.ok(logs.some((l) => l.includes(UNSIGNED_NOTICE)), "unsigned builds announce themselves");
		// payload cleanup: pkgbuild consumed it, staging payload removed
		assert.ok(!fs.existsSync(path.join(out, "payload")));
		// signed path: identity rides the flag
		const calls2 = [];
		await buildPkg({
			repoRoot,
			out,
			version: "0.5.3",
			signIdentity: "Developer ID Installer: Porchlight Home (TEAM)",
			nodePath: process.execPath,
			run: async (file, args) => { calls2.push({ file, args }); return { stdout: "", status: 0 }; },
			log: () => {},
		});
		const argv2 = calls2[0].args;
		assert.equal(argv2[argv2.indexOf("--sign") + 1], "Developer ID Installer: Porchlight Home (TEAM)");
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
});
