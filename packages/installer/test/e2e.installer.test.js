// e2e.installer.test.js — the headless deploy proof (PORCH-134 ac-1).
//
// Env-gated (PORCHLIGHT_E2E=1, darwin only): builds the real pkg with
// pkgbuild, expands it, runs the first-run bootstrap in staged roots,
// boots the runtime daemon for real (health + status page over HTTP), and
// proves launchd accepts the generated daemon plist with KeepAlive
// relaunch. Ports deliberately off the recorder's 8971 (the deployment
// soak agent may be live on the build host).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assemblePayload } from "../src/payload.js";
import { writeDaemonPlist } from "../src/bootstrap.js";

const execFile = promisify(execFileCb);
const darwin = process.platform === "darwin";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const REPO = path.resolve(PKG, "..", "..");
const CLI = path.join(PKG, "bin", "installer.js");

async function fetchUntil(url, want, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok) {
				const body = await res.text();
				if (want(body)) return body;
				last = body.slice(0, 200);
			}
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 400));
	}
	assert.fail(`server did not report healthy at ${url} (last: ${last ?? "no response"})`);
}

function stagedRoot(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStagedInputs(root, statusPort, healthPort) {
	// deployment inputs ride the config directory the bootstrap reads
	fs.mkdirSync(path.join(root, "config"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "config", "config.inputs.yaml"),
		[
			"statusPort: " + statusPort,
			"statusHost: 127.0.0.1",
			"port: " + healthPort,
			`storageRoot: ${root.replace(/"/g, "")}/recordings`,
			"cameras: []",
		].join("\n"),
		"utf8",
	);
}

test("PORCH-134 ac-1: build → pkg layout → staged bootstrap → daemon health → launchd KeepAlive", { skip: !darwin || !process.env.PORCHLIGHT_E2E ? "PORCHLIGHT_E2E=1 on darwin required" : false }, async (t) => {
	// ---- 1. The real pkg build (pkgbuild), then the expanded layout.
	const outDir = stagedRoot("porch-e2e-pkg-");
	const pkgPath = path.join(outDir, "porchlight-home-0.5.3.pkg");
	const build = spawnSync("node", [CLI, "build", "--out", pkgPath], { encoding: "utf8", cwd: PKG });
	assert.equal(build.status, 0, build.stderr || build.stdout);
	assert.ok(fs.existsSync(pkgPath));
	assert.ok(build.stdout.includes("UNSIGNED"), "the build states what it is: no identity on this host");

	const expanded = path.join(outDir, "expanded");
	await execFile("pkgutil", ["--expand-full", pkgPath, expanded]);
	const payloadRoot = path.join(expanded, "Payload");
	for (const rel of [
		"Library/Porchlight/bin/porchlight-home",
		"Library/Porchlight/packages/installer/bin/installer.js",
		"Library/Porchlight/packages/recorder/src/supervisor.js",
		"Library/Porchlight/packages/hal/src/index.js",
		"Library/Porchlight/node_modules/yaml/package.json",
		"Library/Porchlight/node_modules/@porchlight/recorder",
		"Library/Porchlight/node_modules/@porchlight/hal",
	]) {
		assert.ok(fs.existsSync(path.join(payloadRoot, rel)), rel);
	}
	assert.ok(fs.existsSync(path.join(expanded, "scripts", "postinstall")));

	// ---- 2. First-run bootstrap in a staged root (the postinstall path).
	const stage = stagedRoot("porch-e2e-boot-");
	const root = path.join(stage, "Library", "Porchlight");
	const logLines = [];
	assemblePayload({ repoRoot: REPO, payloadRoot: stage, log: (l) => logLines.push(l) });
	t.diagnostic(`staged root: ${root}`);
	writeStagedInputs(root, 19870, 19871);
	const boot = spawnSync("node", [CLI, "bootstrap", "--root", root, "--node", process.execPath, "--node-floor", String(process.versions.node.split(".")[0])], { encoding: "utf8" });
	assert.equal(boot.status, 0, boot.stdout + boot.stderr);
	assert.match(boot.stdout, /✓ config —/);
	assert.match(boot.stdout, /kept the existing config of record|config\.yaml/);
	const plistPath = boot.stdout.match(/plist — (\S+)/)?.[1];
	assert.ok(plistPath);
	t.diagnostic(`plist: ${plistPath}`);

	// ---- 3. The daemon serves the status page + healthy aggregate.
	const daemon = spawn("node", [CLI, "daemon", "--config", path.join(root, "config", "config.yaml")], { stdio: "pipe" });
	try {
		const healthJson = await fetchUntil("http://127.0.0.1:19870/health", (b) => JSON.parse(b).status === "healthy");
		const agg = JSON.parse(healthJson);
		assert.equal(agg.services.find((s) => s.name === "recorder").healthy, true);
		assert.equal(agg.awaitingConfiguration, true);
		assert.equal(agg.platform.platform, "darwin");
		assert.equal(agg.platform.decode, "videotoolbox");
		const page = await fetch("http://127.0.0.1:19870/");
		const html = await page.text();
		assert.ok(html.includes("<!DOCTYPE html>"));
		assert.ok(html.includes("No cameras configured yet"));
		assert.ok(!html.includes("<script"));
	} finally {
		daemon.kill("SIGTERM");
		await new Promise((resolve) => daemon.once("exit", resolve));
	}

	// ---- 4. launchd accepts the generated daemon plist; KeepAlive relaunches.
	const stageB = stagedRoot("porch-e2e-lcd-");
	const rootB = path.join(stageB, "Library", "Porchlight");
	assemblePayload({ repoRoot: REPO, payloadRoot: stageB, log: () => {} });
	writeStagedInputs(rootB, 19880, 19881);
	const bootB = spawnSync("node", [CLI, "bootstrap", "--root", rootB, "--node", process.execPath, "--node-floor", String(process.versions.node.split(".")[0])], { encoding: "utf8" });
	assert.equal(bootB.status, 0, bootB.stdout + bootB.stderr);
	const label = "com.porchlight.home";
	const { plistPath: daemonPlist } = writeDaemonPlist({
		root: rootB,
		configPath: path.join(rootB, "config", "config.yaml"),
		node: process.execPath,
	});
	const uid = process.getuid();
	const domain = `gui/${uid}`;
	const bootout = () => { try { spawnSync("launchctl", ["bootout", domain, daemonPlist], {}); } catch { /* absent */ } };
	t.diagnostic(`launchctl bootstrap gui/${uid} ${daemonPlist}`);
	try {
		bootout(); // clear any stale registration from a prior run
		const inBoot = spawnSync("launchctl", ["bootstrap", domain, daemonPlist], { encoding: "utf8" });
		if (inBoot.status !== 0) {
			assert.match(inBoot.stderr || "", /already bootstrapped|Input\/output error|No such process/, inBoot.stderr);
		}
		// launchd runs the daemon: health becomes reachable
		await fetchUntil("http://127.0.0.1:19880/health", (b) => JSON.parse(b).status === "healthy");
		const print = (await execFile("launchctl", ["print", `${domain}/${label}`])).stdout;
		const pid = Number(print.match(/pid = (\d+)/)?.[1]);
		assert.ok(pid > 0, `launchd job running (pid reported in launchctl print)`);
		// KeepAlive: kill the child; launchd relaunches within RestartInterval
		process.kill(pid, "SIGKILL");
		let relaunched = 0;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 1000));
			try {
				const p2 = (await execFile("launchctl", ["print", `${domain}/${label}`])).stdout;
				const pid2 = Number(p2.match(/pid = (\d+)/)?.[1]);
				if (pid2 > 0 && pid2 !== pid) { relaunched = pid2; break; }
			} catch { /* restarting */ }
		}
		assert.ok(relaunched > 0, "launchd KeepAlive relaunched the daemon after SIGKILL");
		await fetchUntil("http://127.0.0.1:19880/health", (b) => JSON.parse(b).status === "healthy");
	} finally {
		bootout();
		await new Promise((r) => setTimeout(r, 500));
		fs.rmSync(stageB, { recursive: true, force: true });
		fs.rmSync(outDir, { recursive: true, force: true });
	}
	fs.rmSync(stage, { recursive: true, force: true });
});
