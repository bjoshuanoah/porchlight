// tcc.js — Local Network / TCC posture for the platform (PORCH-134).
//
// The field finding (task description): an unapproved process silently
// loses UDP LAN traffic — no error surfaces, recordings/detections just
// miss. macOS 15+ enforces local network privacy (TN3179), and the facts
// of record for a headless deployment are:
//
//   1. "Any daemon started by launchd" and "any program running as root"
//      are automatically allowed local network access. The exception does
//      NOT apply to launchd agents. (TN3179 § macOS considerations.)
//   2. "Device managers aren't able to configure local network privacy
//      using MDM." (TN3179.) The TCC configuration profile payload does
//      not support Local Network either (Apple DTS, forums/759955).
//   3. tccutil cannot reset the Local Network privilege (forums/757949).
//
// Consequence, encoded here: the platform runs its services as system-
// domain LaunchDaemons (see daemon.js) — that is the tccutil/MDM path,
// by running where the exemption lives. For user-session programs that
// the deployment must also reach the LAN (vendor adapters, agent-shaped
// helpers), the supported knobs are the System Settings toggle and the
// site-admin network allowlist defaults (macOS 15.5+). This module emits
// the truth, the commands, and a UDP probe that makes the silent loss
// observable instead of silent.

/** Machine-readable facts of record, with citations. */
export const LOCAL_NETWORK_FACTS = {
	daemonExempt: "Any launchd-started daemon (system domain) is automatically allowed local network access; launchd agents are NOT exempt.",
	mdmSupported: false,
	mdmNote: "Device managers cannot configure local network privacy using MDM (TN3179); the TCC configuration profile does not support Local Network (Apple DTS).",
	tccutilSupported: false,
	tccutilNote: "tccutil cannot reset the Local Network privilege; manage the state in System Settings → Privacy & Security → Local Network.",
	siteAdminFallback: "ALLOWED*LOCALNETWORKADDRESSES defaults in the com.apple.network.local-network domain (macOS 15.5+, restart required).",
	references: [
		"https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy",
	],
};

/** Plain-language posture for the CLI. */
export function renderLocalNetworkPosture() {
	return [
		"Porchlight Home — Local Network posture",
		"",
		`  Engine services run as system LaunchDaemons, so launchd starts them at boot and TN3179 exempts them:`,
		`  ${LOCAL_NETWORK_FACTS.daemonExempt}`,
		"",
		`  MDM: ${LOCAL_NETWORK_FACTS.mdmNote}`,
		`  tccutil: ${LOCAL_NETWORK_FACTS.tccutilNote}`,
		`  Site-admin fallback: ${LOCAL_NETWORK_FACTS.siteAdminFallback}`,
		`    Example (treat 169.254/16 as non-local on both link types, then restart):`,
		`    ${siteAdminAllowCommands({ ethernet: ["169.254.0.0/16"], wifi: ["169.254.0.0/16"] }).commands.join("\n    ")}`,
		"",
		"  Verify: run `porchlight-home verify-network` — it sends a UDP multicast discovery probe",
		"  (send requires Local Network access per TN3179) and shows whether anything answered.",
		"",
		`  References: ${LOCAL_NETWORK_FACTS.references.join(" ")}`,
	].join("\n");
}

/**
 * @param {string} cidr
 * @returns {boolean}
 */
function validCidr(cidr) {
	const slash = cidr.lastIndexOf("/");
	if (slash < 1) return false;
	const addr = cidr.slice(0, slash);
	const bits = cidr.slice(slash + 1);
	if (!/^\d{1,3}$/.test(bits)) return false;
	if (addr.includes(":")) {
		// loose IPv6 check: hex groups separated by colons
		return /^[0-9a-fA-F:]+$/.test(addr) && Number(bits) <= 128;
	}
	const octets = addr.split(".");
	if (octets.length !== 4) return false;
	return octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255) && Number(bits) <= 32;
}

/**
 * Site-admin allowlist commands for the supported defaults (TN3179).
 * The written networks are treated as non-local by the system: every
 * program reaches them regardless of privilege state.
 * @param {{ethernet?: string[], wifi?: string[], dryRun?: boolean}} opts
 * @returns {{commands: string[], restartRequired: boolean}}
 */
export function siteAdminAllowCommands({ ethernet = [], wifi = [], dryRun = false } = {}) {
	/** @type {string[]} */
	const commands = [];
	for (const [list, key] of [[ethernet, "AllowedEthernetLocalNetworkAddresses"], [wifi, "AllowedWiFiLocalNetworkAddresses"]]) {
		if (!list.length) continue;
		for (const cidr of list) {
			if (!validCidr(cidr)) {
				throw new Error(`invalid network ${JSON.stringify(cidr)} — an IPv4/IPv6 CIDR range is required`);
			}
		}
		const args = list.map((c) => `"${c}"`).join(" ");
		commands.push(`sudo defaults write com.apple.network.local-network ${key} -array ${args}`);
	}
	if (!dryRun && commands.length) {
		commands.push("(restart the Mac for the change to take effect)");
	}
	return { commands, restartRequired: commands.length > 0 };
}

/**
 * Build a tccutil reset command for a supported TCC service. Local Network
 * is deliberately REFUSED: tccutil cannot reset the Local Network privilege
 * (TN3179 / Apple DTS) — pretending it could would repeat the silent-loss
 * failure with false confidence.
 * @param {string} service e.g. "Microphone", "ScreenCapture", "AppleEvents"
 * @param {string} bundleId
 */
export function buildResetCommand(service, bundleId) {
	if (/localnetwork/i.test(service)) {
		throw new Error(
			"tccutil cannot reset the Local Network privilege (TN3179; tccutil reset LocalNetwork fails). " +
			"Manage it in System Settings → Privacy & Security → Local Network, or run the service as a launchd daemon, where the privilege does not apply.",
		);
	}
	if (!service || !bundleId) {
		throw new Error(`buildResetCommand: service and bundleId are required (got ${JSON.stringify(service)}, ${JSON.stringify(bundleId)})`);
	}
	return `tccutil reset ${service} ${bundleId}`;
}

const SSDP_MSEARCH = [
	"M-SEARCH * HTTP/1.1",
	"Host: 239.255.255.250:1900",
	'Man: "ssdp:discover"',
	"ST: ssdp:all",
	"MX: 2",
	"",
	"",
].join("\r\n");

/**
 * UDP discovery probe: sending UDP multicast requires Local Network access
 * (TN3179 local-network-operations table), so a zero-reply result on a LAN
 * that should have devices is the observable signature of the silent-loss
 * finding. It is a tripwire, not a verdict: zero replies can also mean an
 * empty segment — the result says so in plain language.
 * Expects a dgram-like module (injected for tests).
 * @param {{dgram?: typeof import("node:dgram"), timeoutMs?: number, log?: (s: string) => void,
 *          interfaceAddress?: string}} [opts]
 */
export async function runNetworkProbe({ dgram, timeoutMs = 4000, log = console.log, interfaceAddress } = {}) {
	dgram = dgram ?? (await import("node:dgram")).default;
	const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
	/** @type {string[]} */
	const repliers = [];
	socket.on("message", (msg, rinfo) => {
		const key = `${rinfo.address}:${rinfo.port}`;
		if (!repliers.includes(key)) repliers.push(key);
	});
	socket.on("error", (err) => {
		log(`probe socket error: ${err.message}`);
	});
	await new Promise((resolve, reject) => {
		socket.bind(() => resolve());
		socket.once("error", reject);
	});
	if (interfaceAddress) {
		try {
			socket.addMembership("239.255.255.250", interfaceAddress);
		} catch {
			// no membership on a non-multicast interface — sending still counts as the probed operation
		}
	}
	socket.send(SSDP_MSEARCH, 1900, "239.255.255.250", (err) => {
		if (err) log(`probe send failed: ${err.message}`);
	});
	await new Promise((resolve) => setTimeout(resolve, timeoutMs));
	socket.close();
	return {
		sent: true,
		message: "SSDP M-SEARCH to 239.255.255.250:1900 (UDP multicast — a Local-Network-regulated operation)",
		replies: repliers.length,
		replier: repliers.slice(0, 10),
		verdict: repliers.length > 0 ? "allow" : "undetermined",
		note: repliers.length > 0
			? "Device(s) answered: UDP multicast send works on this network."
			: "No device answered. Empty segment? Nothing to discover? Or the silent Local-Network block: check System Settings → Privacy & Security → Local Network, or run the process as a launchd daemon (TN3179 exemption).",
	};
}
