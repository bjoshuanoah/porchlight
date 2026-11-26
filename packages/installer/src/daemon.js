// daemon.js — system LaunchDaemon autostart for the fresh deployment Mac
// (PORCH-134 ac-1).
//
// The deployment Mac boots headless: no GUI session ever opens, so a
// LaunchAgent (RunAtLoad in the user's GUI domain) never runs at boot. The
// platform therefore installs a **system-domain LaunchDaemon**: launchd
// starts it at boot before any login, KeepAlive relaunches it after a
// power loss or crash, and — per TN3179 (macOS considerations) — "any
// daemon started by launchd" is automatically allowed local network
// access, which closes the field finding (an unapproved user-session
// process silently loses UDP LAN traffic). The plist is domain-neutral by
// construction; the domain comes from where it is installed
// (launchDaemonPath → /Library/LaunchDaemons).

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
export function buildLaunchDaemonPlist(opts) {
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
	if (!label || !program || !Array.isArray(args)) {
		throw new Error("buildLaunchDaemonPlist: label, program and args[] are required");
	}
	const esc = (s) => s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	const stringArg = (v) => `		<string>${esc(String(v))}</string>`;
	const lines = [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
		`<plist version="1.0">`,
		`<dict>`,
		`	<key>Label</key>`,
		`	<string>${esc(label)}</string>`,
		`	<key>Program</key>`,
		`	<string>${esc(program)}</string>`,
		`	<key>ProgramArguments</key>`,
		`	<array>`,
		`		<string>${esc(program)}</string>`,
		...args.map(stringArg),
		`	</array>`,
		`	<key>ProcessType</key>`,
		`	<string>Background</string>`,
	];
	if (workingDirectory) {
		lines.push(`	<key>WorkingDirectory</key>`, `	<string>${esc(workingDirectory)}</string>`);
	}
	if (stdoutPath) {
		lines.push(`	<key>StandardOutPath</key>`, `	<string>${esc(stdoutPath)}</string>`);
	}
	if (stderrPath) {
		lines.push(`	<key>StandardErrorPath</key>`, `	<string>${esc(stderrPath)}</string>`);
	}
	if (Object.keys(environment).length) {
		lines.push(
			`	<key>EnvironmentVariables</key>`,
			`	<dict>`,
			...Object.entries(environment).flatMap(([k, v]) => [
				`		<key>${esc(k)}</key>`,
				`		<string>${esc(v)}</string>`,
			]),
			`	</dict>`,
		);
	}
	lines.push(
		`	<key>KeepAlive</key>`,
		`	${keepAlive ? "<true/>" : "<false/>"}`,
		`	<key>RunAtLoad</key>`,
		`	${runAtLoad ? "<true/>" : "<false/>"}`,
		`	<key>RestartInterval</key>`,
		`	<integer>5</integer>`,
		`</dict>`,
		`</plist>`,
		``,
	);
	return lines.join("\n");
}

/**
 * Conventional install path for the system-domain daemon plist.
 * @param {string} label
 * @param {string} [root] /Volumes-root override (staged installs/tests).
 */
export function launchDaemonPath(label, root = "/Library") {
	return `${root}/LaunchDaemons/${label}.plist`;
}

/**
 * launchctl command sequence for the deployment operator (system domain).
 * The bootstrap flow runs these itself; they are exported so the docs and
 * the manual path use literally the same commands.
 * @param {string} label
 * @param {string} plistPath
 * @param {{"system"|"gui"}} [domain]
 * @returns {{print: string, bootout: string, bootstrap: string}}
 */
export function launchctlCommands(label, plistPath, domain = "system") {
	return {
		print: `launchctl print ${domain}/${label}`,
		bootout: `launchctl bootout ${domain} ${plistPath}`,
		bootstrap: `launchctl bootstrap ${domain} ${plistPath}`,
	};
}
