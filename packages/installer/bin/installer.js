#!/usr/bin/env node
// porchlight-home engine installer CLI (PORCH-134). Thin transport: parse
// argv, dispatch to the src/ modules (bootstrap, pkgspec, runtime, tcc,
// signing). No business logic lives here.

import fsDefault from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildPkg,
	loadPlatformConfig,
	renderLocalNetworkPosture,
	runBootstrap,
	runNetworkProbe,
	runDaemon,
	verifyInstall,
	writeDaemonPlist,
	DEFAULT_ROOT,
} from "../src/index.js";

const VERSION = JSON.parse(fsDefault.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {Record<string, string|boolean>} */
	const out = {};
	/** @type {string | null} */
	let command = null;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) {
			if (!command) command = a;
			continue;
		}
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			out[key] = next;
			i++;
		} else {
			out[key] = true;
		}
	}
	return { command, flags: out };
}

const HELP = `porchlight-home engine installer (v${VERSION})

  daemon --config FILE      run the platform daemon (launchd entrypoint)
  build --out FILE          build porchlight-home-<v>.pkg
                            [--sign-identity ID] [--node PATH] (bundle a runtime)
  bootstrap [--root DIR]    idempotent first-run bootstrap (postinstall path)
  launchd [--out FILE]      print/write the daemon plist [--root DIR]
  verify [--root DIR]       verify an installed deployment
  status --url URL          print /health JSON from a running hub
  verify-network            UDP multicast probe (Local-Network tripwire)
  posture                   Local-Network / TCC posture of record
`;

async function main() {
	const { command, flags } = parseArgs(process.argv.slice(2));
	switch (command) {
	case "daemon": {
		if (!flags.config) throw new Error("daemon: --config FILE required");
		await runDaemon({ configPath: String(flags.config), version: VERSION });
		return;
	}
	case "build": {
		if (!flags.out) throw new Error("build: --out FILE required");
		const result = await buildPkg({
			repoRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
			out: path.resolve(String(flags.out)),
			version: String(flags.version ?? VERSION),
			signIdentity: typeof flags["sign-identity"] === "string" ? flags["sign-identity"] : undefined,
			nodePath: typeof flags.node === "string" ? flags.node : null,
			log: (l) => console.log(l),
		});
		console.log(`[pkg] built ${result.pkg} (${result.signed ? "signed" : "UNSIGNED"})`);
		return;
	}
	case "bootstrap": {
		const root = String(flags.root ?? DEFAULT_ROOT);
		const result = await runBootstrap({
			root,
			node: typeof flags.node === "string" ? flags.node : undefined,
			// deployment default floor is 24 (repo engines); an explicit flag
			// lets a build host verify against the runtime it actually runs.
			floor: typeof flags["node-floor"] === "string" ? Number.parseInt(flags["node-floor"], 10) : undefined,
			log: (l) => console.log(l),
		});
		for (const s of result.steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step} — ${s.detail}`);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}
	case "launchd": {
		const root = String(flags.root ?? DEFAULT_ROOT);
		const configPath = path.join(root, "config", "config.yaml");
		const { plist } = writeDaemonPlist({ root, configPath, node: process.execPath, log: () => {} });
		if (typeof flags.out === "string") {
			fsDefault.writeFileSync(flags.out, plist, "utf8");
			console.log(`wrote ${flags.out}`);
		} else {
			process.stdout.write(plist);
		}
		return;
	}
	case "verify": {
		const root = String(flags.root ?? DEFAULT_ROOT);
		const cfg = fsDefault.existsSync(path.join(root, "config", "config.yaml"))
			? loadPlatformConfig(path.join(root, "config", "config.yaml"))
			: null;
		const result = await verifyInstall({
			root,
			statusPort: cfg?.statusPort,
			statusPortHost: cfg?.statusHost,
			wantDaemon: true,
		});
		for (const c of result.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}
	case "status": {
		const url = String(flags.url ?? "http://127.0.0.1:8970");
		const res = await fetch(`${url.replace(/\/$/, "")}/health`);
		const body = await res.text();
		console.log(body);
		process.exitCode = res.ok ? 0 : 1;
		return;
	}
	case "verify-network": {
		const probe = await runNetworkProbe({});
		console.log(probe.message);
		console.log(`replies: ${probe.replies}`);
		console.log(probe.note);
		return;
	}
	case "posture": {
		process.stdout.write(renderLocalNetworkPosture() + "\n");
		return;
	}
	default: {
		process.stdout.write(HELP);
		process.exitCode = command ? 1 : 0;
	}
	}
}

main().catch((err) => {
	console.error(`porchlight-home: ${/** @type {Error} */ (err).message}`);
	process.exit(1);
});
