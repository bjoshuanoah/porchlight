// daemon.test.js — LaunchDaemon plist contract (PORCH-134 ac-1).

import test from "node:test";
import assert from "node:assert/strict";
import { buildLaunchDaemonPlist, launchDaemonPath, launchctlCommands } from "../src/daemon.js";

const OPTS = {
	label: "com.porchlight.home",
	program: "/Library/Porchlight/bin/runtime/node",
	args: ["/Library/Porchlight/packages/installer/bin/installer.js", "daemon", "--config", "/Library/Porchlight/config/config.yaml"],
	workingDirectory: "/Library/Porchlight",
	stdoutPath: "/Library/Porchlight/logs/daemon.out.log",
	stderrPath: "/Library/Porchlight/logs/daemon.err.log",
	environment: { TZ: "UTC" },
};

test("plist carries boot-time autostart keys (RunAtLoad + KeepAlive) and daemon arguments", () => {
	const plist = buildLaunchDaemonPlist(OPTS);
	assert.match(plist, /<key>Label<\/key>\s*<string>com\.porchlight\.home<\/string>/);
	assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
	assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
	assert.match(plist, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
	assert.match(plist, /<key>RestartInterval<\/key>\s*<integer>5<\/integer>/);
	assert.match(plist, /<key>Program<\/key>\s*<string>\/Library\/Porchlight\/bin\/runtime\/node<\/string>/);
	// daemon entrypoint + config of record in argv
	assert.match(plist, /<string>daemon<\/string>/);
	assert.match(plist, /<string>--config<\/string>/);
	assert.match(plist, /<string>\/Library\/Porchlight\/config\/config\.yaml<\/string>/);
});

test("plist XML-escapes values", () => {
	const plist = buildLaunchDaemonPlist({ ...OPTS, args: ["a&b<c>d"] });
	assert.ok(plist.includes("<string>a&amp;b&lt;c&gt;d</string>"));
	assert.ok(!plist.includes("a&b<c>d</string>"));
});

test("plist writes StandardOut/StandardError and EnvironmentVariables", () => {
	const plist = buildLaunchDaemonPlist(OPTS);
	assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Library\/Porchlight\/logs\/daemon\.out\.log<\/string>/);
	assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/Library\/Porchlight\/logs\/daemon\.err\.log<\/string>/);
	assert.match(plist, /<key>EnvironmentVariables<\/key>/);
	assert.match(plist, /<key>TZ<\/key>\s*<string>UTC<\/string>/);
});

test("plist XML is well-balanced (every open has its close)", () => {
	const plist = buildLaunchDaemonPlist(OPTS);
	const opens = (plist.match(/<(key|string|array|dict|integer|true|false)>/g) ?? []).length;
	const tagRe = /<\/?(key|string|array|dict|integer)>/g;
	const tags = plist.match(tagRe) ?? [];
	const opens2 = tags.filter((t) => !t.startsWith("</")).length;
	const closes = tags.filter((t) => t.startsWith("</")).length;
	assert.ok(opens >= opens2);
	assert.equal(opens2, closes);
	assert.ok(plist.includes("</plist>"));
});

test("optional keys are omitted when absent", () => {
	const minimal = buildLaunchDaemonPlist({ label: "l", program: "p", args: ["a"], keepAlive: false, runAtLoad: false });
	assert.ok(!minimal.includes("StandardOutPath"));
	assert.ok(!minimal.includes("EnvironmentVariables"));
	assert.match(minimal, /<key>KeepAlive<\/key>\s*<false\/>/);
	assert.match(minimal, /<key>RunAtLoad<\/key>\s*<false\/>/);
});

test("missing label/program/args fail loudly", () => {
	assert.throws(() => buildLaunchDaemonPlist({ label: "", program: "p", args: ["a"] }), /required/);
	assert.throws(() => buildLaunchDaemonPlist({ label: "l", program: "", args: ["a"] }), /required/);
	assert.throws(() => buildLaunchDaemonPlist({ label: "l", program: "p", args: "notarray" }), /required/);
});

test("paths and launchctl commands follow the system domain convention", () => {
	assert.equal(launchDaemonPath("com.porchlight.home"), "/Library/LaunchDaemons/com.porchlight.home.plist");
	assert.equal(launchDaemonPath("com.porchlight.home", "/staged/Library"), "/staged/Library/LaunchDaemons/com.porchlight.home.plist");
	const cmds = launchctlCommands("com.porchlight.home", "/Library/LaunchDaemons/com.porchlight.home.plist");
	assert.equal(cmds.bootstrap, "launchctl bootstrap system /Library/LaunchDaemons/com.porchlight.home.plist");
	assert.equal(cmds.bootout, "launchctl bootout system /Library/LaunchDaemons/com.porchlight.home.plist");
	assert.equal(cmds.print, "launchctl print system/com.porchlight.home");
});
