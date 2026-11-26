// launchd.test.js — headless autostart plist generation (PORCH-127 ac-2).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLaunchAgentPlist, launchAgentPath, launchctlCommands } from "../src/launchd.js";

test("plist carries RunAtLoad + KeepAlive for boot-start and crash relaunch", () => {
	const xml = buildLaunchAgentPlist({
		label: "com.porchlight.recorder",
		program: "/usr/local/bin/node",
		args: ["/opt/recorder/bin/recorder.js", "supervise", "--config", "/etc/rec.yaml"],
		workingDirectory: "/var/porchlight",
		stdoutPath: "/var/porchlight/supervisor.log",
		stderrPath: "/var/porchlight/supervisor.log",
		environment: { TZ: "UTC" },
	});
	assert.ok(xml.startsWith("<?xml version=\"1.0\""));
	assert.ok(xml.includes("<key>Label</key>"));
	assert.ok(xml.includes("<string>com.porchlight.recorder</string>"));
	assert.ok(xml.includes("<string>supervise</string>"));
	assert.ok(xml.includes("<string>--config</string>"));
	assert.ok(xml.includes("<key>RunAtLoad</key>\n\t<true/>"));
	assert.ok(xml.includes("<key>KeepAlive</key>\n\t<true/>"));
	assert.ok(xml.includes("<key>EnvironmentVariables</key>"));
	assert.ok(xml.includes("<key>TZ</key>\n\t\t<string>UTC</string>"));
	assert.ok(!xml.includes("&supervise")); // no escaping accidents
});

test("plist XML-escapes hostile path characters", () => {
	const xml = buildLaunchAgentPlist({
		label: "com.test",
		program: "/opt/a<b>&c>/d",
		args: ["--config", "/x<y>&z"],
	});
	assert.ok(xml.includes("/opt/a&lt;b&gt;&amp;c&gt;/d"));
	assert.ok(xml.includes("--config</string>\n\t\t<string>/x&lt;y&gt;&amp;z</string>"));
});

test("install path + launchctl command card cover the full install/uninstall cycle", () => {
	assert.match(launchAgentPath("com.porchlight.recorder", "/Users/brian"), /\/Users\/brian\/Library\/LaunchAgents\/com\.porchlight\.recorder\.plist$/);
	const cmds = launchctlCommands("com.porchlight.recorder", "/Users/brian/Library/LaunchAgents/com.porchlight.recorder.plist", 501);
	assert.ok(cmds.includes("launchctl bootstrap gui/501"));
	assert.ok(cmds.includes("launchctl bootout gui/501/com.porchlight.recorder"));
});
