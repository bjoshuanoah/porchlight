// launchd.js — headless autostart for the deployment Mac (PORCH-127 ac-2).
//
// The deployment Macs run headless, so first-run must require zero GUI
// interaction: the recorder supervisor installs as a LaunchAgent with
// RunAtLoad (auto-start at boot/login) + KeepAlive (relaunch when the
// process dies — power loss, crash). The plist is generated from the
// recorder config; installation rides `launchctl bootstrap` commands this
// module documents and the soak harness exercises end to end.

/**
 * @param {{
 *   label: string,
 *   program: string,           // absolute path to node (or any interpreter)
 *   args: string[],
 *   workingDirectory?: string,
 *   stdoutPath?: string,
 *   stderrPath?: string,
 *   keepAlive?: boolean,
 *   runAtLoad?: boolean,
 *   environment?: Record<string, string>,
 * }} opts
 * @returns {string} plist XML
 */
export function buildLaunchAgentPlist(opts) {
	const {
		label,
		program,
		args,
		workingDirectory,
		stdoutPath,
		stderrPath,
		keepAlive = true,
		runAtLoad = true,
		environment = {},
	} = opts;
	const esc = (s) => s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	const lines = [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
		`<plist version="1.0">`,
		`<dict>`,
		`\t<key>Label</key>`,
		`\t<string>${esc(label)}</string>`,
		`\t<key>ProgramArguments</key>`,
		`\t<array>`,
		`\t\t<string>${esc(program)}</string>`,
		...args.map((a) => `\t\t<string>${esc(a)}</string>`),
		`\t</array>`,
	];
	if (workingDirectory) {
		lines.push(`\t<key>WorkingDirectory</key>`, `\t<string>${esc(workingDirectory)}</string>`);
	}
	if (stdoutPath) {
		lines.push(`\t<key>StandardOutPath</key>`, `\t<string>${esc(stdoutPath)}</string>`);
	}
	if (stderrPath) {
		lines.push(`\t<key>StandardErrorPath</key>`, `\t<string>${esc(stderrPath)}</string>`);
	}
	if (Object.keys(environment).length) {
		lines.push(`\t<key>EnvironmentVariables</key>`, `\t<dict>`);
		for (const [k, v] of Object.entries(environment)) {
			lines.push(`\t\t<key>${esc(k)}</key>`, `\t\t<string>${esc(v)}</string>`);
		}
		lines.push(`\t</dict>`);
	}
	lines.push(
		`\t<key>KeepAlive</key>`,
		`\t${keepAlive ? "<true/>" : "<false/>"}`,
		`\t<key>RunAtLoad</key>`,
		`\t${runAtLoad ? "<true/>" : "<false/>"}`,
		`\t<key>RestartInterval</key>`,
		`\t<integer>5</integer>`,
		`</dict>`,
		`</plist>`,
		``,
	);
	return lines.join("\n");
}

/**
 * Conventional install path for a per-user LaunchAgent.
 * @param {string} label
 * @param {string} [home]
 */
export function launchAgentPath(label, home = "/Users/PLACEHOLDER") {
	return `${home}/Library/LaunchAgents/${label}.plist`;
}

/**
 * Install/uninstall command sequence for the deployment operator.
 * @param {string} label
 * @param {string} plistPath
 * @param {number} [uid]
 */
export function launchctlCommands(label, plistPath, uid = 501) {
	const bootout = `launchctl bootout gui/${uid}/${label}`;
	return [
		`launchctl bootstrap gui/${uid} ${plistPath}`,
		`launchctl kickstart -k gui/${uid}/${label}`,
		`launchctl print gui/${uid}/${label}`,
		// uninstall after the soak window completes:
		bootout,
	].join("\n");
}
