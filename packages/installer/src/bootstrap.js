// bootstrap.js — the first-run, zero-GUI bootstrap sequence (PORCH-134 ac-1).
//
// The installer's postinstall runs this on a fresh Apple-Silicon Mac:
// directories → config of record → system LaunchDaemon → launchd bootstrap →
// verification. Every step is idempotent (reinstall/upgrade re-runs it) and
// every failure names its state in plain language — no dead ends, no
// transient errors (earned-errors discipline).

import fsDefault from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildLaunchDaemonPlist, launchDaemonPath, launchctlCommands } from "./daemon.js";
import {
	DEFAULT_LABEL,
	DEFAULT_ROOT,
	ensureBootstrapConfig,
	loadPlatformConfig,
} from "./config.js";
import { verifyHealth } from "./verify.js";

const NODE_VERSION_FLOOR = 24;
const ENTRY_REL = "packages/installer/bin/installer.js";

/**
 * Resolve the node runtime the daemon will run under: a bundled runtime
 * (bin/runtime/node, staged by the pkg build with --node) first, then the
 * system PATH. Both must satisfy the monorepo floor (node >= 24) — checked,
 * never assumed. Plain-language failure names every attempt.
 * @param {{
 *   root?: string,
 *   floor?: number,
 *   execFile?: (file: string, args: string[]) => {stdout: string, status: number, error?: Error},
 *   pathEnv?: string,
 * }} [opts]
 */
export function resolveNodeRuntime({ root = DEFAULT_ROOT, node, floor = NODE_VERSION_FLOOR, execFile, pathEnv } = {}) {
	const run = execFile ?? ((file, args) => {
		const r = spawnSync(file, args, { encoding: "utf8", timeout: 10_000 });
		return { stdout: String(r.stdout ?? ""), status: r.status ?? 1, error: r.error };
	});
	if (node) {
		// Explicit runtime (CLI/test injection): still floor-checked, never assumed.
		const r = run(node, ["--version"]);
		if (r.error || r.status !== 0) {
			throw new Error(`Porchlight Home runtime ${node} did not run`);
		}
		const v = String(r.stdout).trim();
		const major = Number.parseInt(v.replace(/^v/, "").split(".")[0] ?? "0", 10);
		if (Number.isNaN(major) || major < floor) {
			throw new Error(`Porchlight Home needs Node.js ${floor}+ (found ${v} at ${node}).`);
		}
		return { node, version: v, bundled: false };
	}
	const bundled = path.join(root, "bin/runtime/node");
	const candidates = [bundled];
	const lookups = [
		...(pathEnv ?? process.env.PATH ?? "").split(":").filter(Boolean),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
	];
	for (const dir of lookups) {
		candidates.push(path.join(dir, "node"));
	}
	/** @type {string[]} */
	const tried = [];
	for (const candidate of candidates) {
		if (!fsDefault.existsSync(candidate)) {
			tried.push(`${candidate} (absent)`);
			continue;
		}
		const r = run(candidate, ["--version"]);
		if (r.error || r.status !== 0) {
			tried.push(`${candidate} (did not run)`);
			continue;
		}
		const v = String(r.stdout).trim(); // e.g. "v24.3.0"
		const major = Number.parseInt(v.replace(/^v/, "").split(".")[0] ?? "0", 10);
		if (Number.isNaN(major) || major < floor) {
			tried.push(`${candidate} (${v || "unknown release"} — needs ${floor}+)`);
			continue;
		}
		return { node: candidate, version: v, bundled: candidate === bundled && !fsDefault.statSync(bundled).isSymbolicLink() };
	}
	throw new Error(
		`Porchlight Home needs Node.js ${floor}+ to run its engine, and none was found.\n` +
		`Tried:\n  ${tried.join("\n  ")}\n` +
		`Install Node ${floor} or later, or rebuild the installer with --node <path> to bundle a runtime.`,
	);
}

/**
 * Build and write the daemon plist for a root — the one code path the
 * bootstrap flow and the CLI `launchd` command share, so manual and
 * installer flows cannot drift.
 * @param {{
 *   root: string,
 *   configPath: string,
 *   node?: string,          // resolved runtime; resolved on demand if absent
 *   label?: string,
 *   fs?: typeof fsDefault,
 *   log?: (line: string) => void,
 * }} opts
 * @returns {{plistPath: string, plist: string}}
 */
export function writeDaemonPlist({ root, configPath, node, label = DEFAULT_LABEL, fs: fsMod = fsDefault, log = console.log } = {}) {
	const resolved = node ? { node } : resolveNodeRuntime({ root });
	const entry = path.join(root, ENTRY_REL);
	const plistText = buildLaunchDaemonPlist({
		label,
		program: resolved.node,
		args: [entry, "daemon", "--config", configPath],
		workingDirectory: root,
		stdoutPath: path.join(root, "logs", "daemon.out.log"),
		stderrPath: path.join(root, "logs", "daemon.err.log"),
		environment: { TZ: "UTC" },
	});
	const plistPath = launchDaemonPath(label, path.join(root, ".."));
	fsMod.mkdirSync(path.dirname(plistPath), { recursive: true });
	fsMod.writeFileSync(plistPath, plistText, "utf8");
	log(`[bootstrap] plist written: ${plistPath}`);
	return { plistPath, plist: plistText };
}

/**
 * The full first-run bootstrap. Returns the per-step ledger (every step
 * names its state) and throws on failure? — no: it returns
 * { ok: false, steps } so the CLI prints the plain-language ledger and
 * exits nonzero; postinstall propagates that to the installer.
 * @param {{
 *   root?: string,
 *   configDir?: string,
 *   label?: string,
 *   inputs?: Record<string, unknown>,
 *   installLaunchDaemon?: boolean,       // default: real root + root privileges
 *   verifyTimeoutMs?: number,
 *   fs?: typeof fsDefault,
 *   log?: (line: string) => void,
 * }} [opts]
 */
export async function runBootstrap({
	root = DEFAULT_ROOT,
	configDir = path.join(root, "config"),
	label = DEFAULT_LABEL,
	inputs = {},
	node,
	floor,
	installLaunchDaemon,
	verifyTimeoutMs = 45_000,
	fs: fsMod = fsDefault,
	log = console.log,
} = {}) {
	/** @type {{step: string, ok: boolean, detail: string}[]} */
	const steps = [];
	const step = (name, ok, detail) => {
		steps.push({ step: name, ok, detail });
		log(`[bootstrap] ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
		return ok;
	};

	// 1. Directory scaffolding (idempotent).
	for (const dir of [root, path.join(root, "logs"), path.join(root, "recordings"), configDir]) {
		fsMod.mkdirSync(dir, { recursive: true });
	}
	step("directories", true, `${root}{,/logs,/recordings,/config}`);

	// 2. Config of record (written once; never overwritten on reinstall).
	const cfgResult = ensureBootstrapConfig(configDir, inputs, { fs: fsMod });
	step("config", cfgResult.created, `${cfgResult.path}${cfgResult.created ? "" : " (kept the existing config of record)"}`);
	const cfg = loadPlatformConfig(cfgResult.path, { fs: fsMod });

	// 3. Runtime resolution (bundled node preferred, floor checked).
	/** @type {{node: string, version: string}} */
	let runtime;
	try {
		runtime = resolveNodeRuntime({ root, node, floor });
	} catch (err) {
		step("runtime", false, /** @type {Error} */ (err).message.split("\n")[0]);
		return { ok: false, steps, configPath: cfgResult.path };
	}
	step("runtime", true, `${runtime.node} (${runtime.version})`);

	// 4. System LaunchDaemon plist (boot-time autostart, KeepAlive).
	const plistResult = writeDaemonPlist({ root, configPath: cfgResult.path, node: runtime.node, fs: fsMod, log });
	const plistPath = plistResult.plistPath;
	step("plist", true, `${plistPath}`);

	// 5. launchd registration — only on the real system path with root
	// privileges; staged boots verify the plist without touching the host.
	const wantsInstall = installLaunchDaemon ?? (root === DEFAULT_ROOT && process.getuid?.() === 0 && process.platform === "darwin");
	if (wantsInstall) {
		const cmds = launchctlCommands(label, plistPath, "system");
		const loaded = spawnSync("sh", ["-c", `${cmds.print} >/dev/null 2>&1 && echo loaded || echo absent`], { encoding: "utf8" });
		if (String(loaded.stdout).trim() === "loaded") {
			spawnSync("sh", ["-c", cmds.bootout], { encoding: "utf8" });
		}
		const boot = spawnSync("sh", ["-c", cmds.bootstrap], { encoding: "utf8" });
		step("launchd", boot.status === 0, boot.status === 0
			? `${cmds.bootstrap}`
			: `${cmds.bootstrap} failed: ${(boot.stderr || boot.stdout || "no output").trim()}`);
	} else {
		step("launchd", true, `skipped in staged root (${root} is not the system install path ${DEFAULT_ROOT})`);
	}

	// 6. Verification: plist lint, config re-read, health endpoints up.
	const verification = await verifyInstall({ root, label, configPath: cfgResult.path, statusPort: cfg.statusPort, statusPortHost: cfg.statusHost, timeoutMs: verifyTimeoutMs, wantDaemon: wantsInstall, fs: fsMod });
	for (const v of verification.checks) step(`verify: ${v.name}`, v.ok, v.detail);
	return { ok: verification.ok, steps, configPath: cfgResult.path, plistPath, verification };
}

/**
 * Static + live verification of the installed platform.
 * @param {{
 *   root?: string, label?: string, configPath?: string,
 *   statusPort?: number, statusPortHost?: string, wantDaemon?: boolean,
 *   timeoutMs?: number, fs?: typeof fsDefault,
 * }} [opts]
 */
export async function verifyInstall({
	root = DEFAULT_ROOT,
	label = DEFAULT_LABEL,
	configPath = path.join(root, "config", "config.yaml"),
	statusPort,
	statusPortHost,
	wantDaemon = false,
	timeoutMs = 45_000,
	fs: fsMod = fsDefault,
} = {}) {
	/** @type {{name: string, ok: boolean, detail: string}[]} */
	const checks = [];
	let ok = true;
	const check = (name, passed, detail) => {
		checks.push({ name, ok: passed, detail });
		ok = ok && passed;
	};

	check("payload", fsMod.existsSync(path.join(root, ENTRY_REL)), `${root}/${ENTRY_REL}`);
	check("config", fsMod.existsSync(configPath), configPath);

	const plistPath = launchDaemonPath(label, path.join(root, ".."));
	if (fsMod.existsSync(plistPath)) {
		if (process.platform === "darwin") {
			const lint = spawnSync("plutil", ["-lint", plistPath], { encoding: "utf8" });
			check("plist-lint", lint.status === 0, String(lint.stdout).trim());
		} else {
			check("plist-lint", true, "skipped on non-darwin host (darwin command)");
		}
	} else {
		check("plist-lint", false, `${plistPath} not present`);
	}

	if (wantDaemon && statusPort) {
		const result = await verifyHealth({ statusPort, statusHost: statusPortHost ?? "127.0.0.1", timeoutMs, root });
		check("status-page", result.ok, result.detail);
	} else {
		check("status-page", true, "daemon not registered in this context; run verify against the system install");
	}
	return { ok, checks, plistPath };
}

export { verifyHealth };
