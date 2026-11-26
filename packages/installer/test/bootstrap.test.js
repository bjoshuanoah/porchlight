// bootstrap.test.js — the first-run bootstrap sequence (PORCH-134 ac-1).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveNodeRuntime, runBootstrap, verifyInstall } from "../src/bootstrap.js";
import { loadPlatformConfig } from "../src/config.js";

test("resolveNodeRuntime prefers the bundled runtime and checks the version floor", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "porch-rt-res-"));
	try {
		// A real shim stands in for a bundled node binary.
		fs.mkdirSync(path.join(root, "bin/runtime"), { recursive: true });
		const shim = path.join(root, "bin/runtime/node");
		fs.writeFileSync(shim, "#!/bin/sh\necho v24.3.0\n", "utf8");
		fs.chmodSync(shim, 0o755);
		const r = resolveNodeRuntime({ root, execFile: () => ({ stdout: "v24.3.0\n", status: 0 }), pathEnv: "" });
		assert.equal(r.node, shim);
		assert.equal(r.version, "v24.3.0");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a runtime below the floor is refused in plain language naming every attempt", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "porch-rt-low-"));
	try {
		fs.mkdirSync(path.join(root, "bin/runtime"), { recursive: true });
		const shim = path.join(root, "bin/runtime/node");
		fs.writeFileSync(shim, "#!/bin/sh\necho v22.23.1\n", "utf8");
		fs.chmodSync(shim, 0o755);
		assert.throws(() => {
			resolveNodeRuntime({
				root,
				execFile: () => ({ stdout: "v22.23.1\n", status: 0 }),
				pathEnv: "/usr/local/bin:/opt/homebrew/bin",
			});
		}, (err) => {
			const m = err.message;
			return /needs Node\.js 24\+/.test(m)
				&& m.includes(shim + " (v22.23.1 — needs 24+)")
				&& m.includes("/opt/homebrew/bin/node")
				&& m.includes("Install Node 24 or later");
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a first-run bootstrap in a staged root writes dirs, config, plist — and skips launchd", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "porch-boot-"));
	try {
		// The payload check requires the runtime entry to exist.
		const entryDir = path.join(root, "packages/installer/bin");
		fs.mkdirSync(entryDir, { recursive: true });
		fs.writeFileSync(path.join(entryDir, "installer.js"), "#!/usr/bin/env node\n", "utf8");

		const runtime = process.execPath;
		const result = await runBootstrap({
			root,
			node: runtime,
			floor: Number.parseInt(process.versions.node.split(".")[0], 10),
			log: () => {},
			installLaunchDaemon: false,
		});
		// staged root skips launchd registration — stated, not silent
		const steps = Object.fromEntries(result.steps.map((s) => [s.step, s.ok]));
		assert.equal(steps["directories"], true);
		assert.equal(steps["config"], true);
		assert.equal(steps["launchd"], true);
		const plistStep = result.steps.find((s) => s.step === "plist");
		assert.equal(plistStep.ok, true);

		const cfg = loadPlatformConfig(result.configPath);
		assert.deepEqual(cfg.cameras, []);
		assert.ok(result.plistPath.endsWith("/LaunchDaemons/com.porchlight.home.plist"));
		const plist = fs.readFileSync(result.plistPath, "utf8");
		assert.match(plist, /com\.porchlight\.home/);
		assert.match(plist, new RegExp(runtime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.ok(result.verification.checks.every((c) => c.ok === true || c.name === "status-page"), JSON.stringify(result.verification.checks));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		if (fs.existsSync(path.join(root, "..", "LaunchDaemons"))) {
			fs.rmSync(path.join(root, "..", "LaunchDaemons"), { recursive: true, force: true });
		}
	}
});

test("a broken config of record fails validation on reinstall instead of at daemon boot", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "porch-boot-"));
	try {
		const entryDir = path.join(root, "packages/installer/bin");
		fs.mkdirSync(entryDir, { recursive: true });
		fs.writeFileSync(path.join(entryDir, "installer.js"), "x", "utf8");
		fs.mkdirSync(path.join(root, "config"), { recursive: true });
		fs.writeFileSync(path.join(root, "config", "config.yaml"), "segmentSeconds: not-a-number\n", "utf8");
		await assert.rejects(() => runBootstrap({ root, log: () => {}, installLaunchDaemon: false }), /segmentSeconds/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("verifyInstall checks payload, config, plist existence and lint status", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "porch-ver-"));
	try {
		const absent = await verifyInstall({ root, label: "com.porchlight.verification-absent", wantDaemon: false, fs });
		assert.equal(absent.ok, false);
		const detail = Object.fromEntries(absent.checks.map((c) => [c.name, c]));
		assert.equal(detail.payload.ok, false);
		assert.equal(detail.config.ok, false);
		assert.equal(detail["plist-lint"].ok, false);
		assert.match(detail["plist-lint"].detail, /not present/);

		const entryDir = path.join(root, "packages/installer/bin");
		fs.mkdirSync(entryDir, { recursive: true });
		fs.writeFileSync(path.join(entryDir, "installer.js"), "x", "utf8");
		fs.mkdirSync(path.join(root, "config"), { recursive: true });
		fs.writeFileSync(path.join(root, "config", "config.yaml"), 'storageRoot: "/x/cams"\ncameras: []\n', "utf8");
		fs.mkdirSync(path.join(root, "..", "LaunchDaemons"), { recursive: true });
		const plistPath = path.join(root, "..", "LaunchDaemons", "com.porchlight.verification.plist");
		fs.writeFileSync(
			plistPath,
			'<plist version="1.0"><dict><key>Label</key><string>com.porchlight.verification</string></dict></plist>',
			"utf8",
		);
		const present = await verifyInstall({ root, label: "com.porchlight.verification", wantDaemon: false, fs });
		const d2 = Object.fromEntries(present.checks.map((c) => [c.name, c]));
		assert.equal(d2.payload.ok, true);
		assert.equal(d2.config.ok, true);
		if (process.platform === "darwin") {
			assert.equal(d2["plist-lint"].ok, true, d2["plist-lint"].detail);
		} else {
			assert.match(d2["plist-lint"].detail, /non-darwin/);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(path.join(root, "..", "LaunchDaemons"), { recursive: true, force: true });
	}
});
