// tcc.test.js — Local Network posture, fallback commands, reset refusal, probe (PORCH-134).

import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_NETWORK_FACTS, buildResetCommand, renderLocalNetworkPosture, runNetworkProbe, siteAdminAllowCommands } from "../src/tcc.js";

test("the posture of record states the launchd-daemon exemption, the MDM gap, and tccutil limits", () => {
	assert.equal(LOCAL_NETWORK_FACTS.mdmSupported, false);
	assert.equal(LOCAL_NETWORK_FACTS.tccutilSupported, false);
	assert.match(LOCAL_NETWORK_FACTS.daemonExempt, /launchd agents are NOT exempt/);
	const posture = renderLocalNetworkPosture();
	assert.ok(posture.includes("launchd"));
	assert.ok(posture.includes("tccutil"));
	assert.ok(posture.includes("https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy"));
});

test("site-admin fallback emits validated sudo defaults commands", () => {
	const { commands, restartRequired } = siteAdminAllowCommands({ ethernet: ["192.168.0.0/24"], wifi: ["192.168.0.0/24"] });
	const sudoCommands = commands.filter((c) => c.startsWith("sudo "));
	assert.equal(sudoCommands.length, 2);
	assert.equal(restartRequired, true);
	assert.equal(commands.at(-1), "(restart the Mac for the change to take effect)");
	assert.ok(commands[0].includes("AllowedEthernetLocalNetworkAddresses"));
	assert.ok(commands[0].includes("com.apple.network.local-network"));
	assert.ok(commands[0].includes('"192.168.0.0/24"'));
	assert.equal(restartRequired, true);
	// IPv6 accepted; garbage refused
	assert.doesNotThrow(() => siteAdminAllowCommands({ ethernet: ["fd00::/8"], dryRun: true }));
	assert.throws(() => siteAdminAllowCommands({ ethernet: ["not-a-network"] }), /CIDR/);
	assert.throws(() => siteAdminAllowCommands({ ethernet: ["300.0.0.1/24"] }), /CIDR/);
});

test("empty allowlists produce no commands", () => {
	assert.deepEqual(siteAdminAllowCommands({ ethernet: [] }).commands, []);
});

test("tccutil LocalNetwork reset is refused with the authoritative explanation", () => {
	assert.throws(() => buildResetCommand("LocalNetwork", "com.porchlight.home"), /TN3179/);
	assert.equal(buildResetCommand("Camera", "com.acme.app"), "tccutil reset Camera com.acme.app");
	assert.throws(() => buildResetCommand("", "com.acme.app"), /required/);
});

test("the UDP probe counts multiset replies and reports an undetermined zero-reply verdict", async () => {
	// Injected fake dgram — the probe must run its own socket lifecycle.
	const sends = [];
	const handlers = {};
	let closed = false;
	const fakeSocket = {
		on(event, fn) { handlers[event] = fn; },
		once(event, fn) { handlers[event] = fn; },
		bind(fn) { fn(); handlers["fake-bound"] = true; },
		addMembership(group, iface) { sends.push({ addMembership: group, iface }); },
		send(msg, port, host, cb) { sends.push({ msg, port, host }); cb(); cb(); },
		close() { closed = true; },
	};
	const fakeDgram = { createSocket: () => fakeSocket };
	const probeP = runNetworkProbe({ dgram: fakeDgram, timeoutMs: 150, log: () => {} });
	// simulate two device replies from one address + one from another
	await new Promise((r) => setTimeout(r, 30));
	handlers.message?.(Buffer.from("NOTIFY"), { address: "10.0.0.4", port: 1900 });
	handlers.message?.(Buffer.from("NOTIFY"), { address: "10.0.0.4", port: 1900 });
	handlers.message?.(Buffer.from("NOTIFY"), { address: "10.0.0.9", port: 1900 });
	const probe = await probeP;
	assert.equal(probe.sent, true);
	assert.equal(probe.replies, 2, "unique repliers are counted, duplicate datagrams are not");
	assert.equal(probe.verdict, "allow");
	assert.ok(sends.some((s) => s.port === 1900 && s.host === "239.255.255.250"), "probe is UDP multicast to the SSDP group");
	assert.ok(String(sends[0].msg).includes('Man: "ssdp:discover"'));
	assert.equal(closed, true);

	const silentP = runNetworkProbe({ dgram: fakeDgram, timeoutMs: 80, log: () => {} });
	await new Promise((r) => setTimeout(r, 120));
	const silent = await silentP;
	assert.equal(silent.replies, 0);
	assert.equal(silent.verdict, "undetermined");
	assert.match(silent.note, /System Settings/);
});
