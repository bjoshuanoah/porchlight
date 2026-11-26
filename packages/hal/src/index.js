// index.js — the HAL public entry (PORCH-132).
//
// The platform HAL: the thin native integration layer between the pure
// TypeScript/Node engine services and each host OS. Every service asks this
// module what the host provides (hardware decode argv, encode defaults,
// single-frame capture, ML execution providers, Vision helper) — services
// never touch OS frameworks directly. All OS-framework code lives inside
// packages/hal (the Swift Vision helper); this keeps the platform portable by
// design with Apple Silicon as the default-best target.
//
// Resolution: `resolveHal()` picks the backend matching the running host
// (darwin → VideoToolbox/CoreML; linux → the first-cut CPU backend). The
// result is injectable everywhere (`createHal({ backend })`), so the same
// service code runs against any backend — that is the portability contract.

import { DarwinBackend } from "./backend.darwin.js";
import { LinuxBackend } from "./backend.linux.js";

export { DarwinBackend, LinuxBackend };

/**
 * Build a HAL instance from an explicit backend. Services accept an injected
 * instance so host independence is provable without a Linux machine.
 * @param {{ backend?: import("./backend.darwin.js").DarwinBackend
 *           | import("./backend.linux.js").LinuxBackend }} [opts]
 * @returns {DarwinBackend|LinuxBackend}
 */
export function createHal(opts) {
	if (opts?.backend) return opts.backend;
	return resolveHal();
}

/**
 * Resolve the HAL against a host platform (defaults to the running host).
 * @param {{ platform?: NodeJS.Platform }} [opts]
 * @returns {DarwinBackend|LinuxBackend}
 */
export function resolveHal(opts) {
	const platform = opts?.platform ?? process.platform;
	if (platform === "darwin") return new DarwinBackend();
	if (platform === "linux") return new LinuxBackend();
	throw new Error(`resolveHal: no HAL backend for platform ${JSON.stringify(platform)}`);
}
