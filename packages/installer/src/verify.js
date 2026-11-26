// verify.js — health-plane verification for the installed platform
// (PORCH-134 ac-1). Bounded polling of the status page's /health JSON plus
// the HTML status page itself; every failure names what was tried.

/**
 * @param {{
 *   statusPort: number,
 *   statusHost?: string,
 *   timeoutMs?: number,
 *   root?: string,
 *   fetchImpl?: typeof fetch,
 * }} [opts]
 * @returns {Promise<{ok: boolean, detail: string, aggregate?: object}>}
 */
export async function verifyHealth({
	statusPort,
	statusHost = "127.0.0.1",
	timeoutMs = 45_000,
	root = "/Library/Porchlight",
	fetchImpl = globalThis.fetch,
} = {}) {
	// 0.0.0.0/IPv6-any are bind addresses, not dial addresses.
	if (statusHost === "0.0.0.0" || statusHost === "::" || statusHost === "ALL") {
		statusHost = "127.0.0.1";
	}
	const base = `http://${statusHost}:${statusPort}`;
	const deadline = Date.now() + timeoutMs;
	/** @type {string[]} */
	const attempts = [];
	let aggregate = null;
	while (Date.now() < deadline) {
		try {
			const res = await fetchImpl(`${base}/health`);
			if (res.ok) {
				aggregate = await res.json();
				const page = await fetchImpl(base);
				const html = await page.text();
				if (page.ok && html.includes("<!DOCTYPE html>")) {
					return {
						ok: aggregate.status === "healthy",
						detail: aggregate.status === "healthy"
							? `${base}/health reports healthy; status page served`
							: `${base}/health reports ${aggregate.status} — see ${root}/logs/daemon.err.log`,
						aggregate,
					};
				}
				attempts.push(`page ${page.status} (no DOCTYPE)`);
			} else {
				attempts.push(`health ${res.status}`);
			}
		} catch (err) {
			attempts.push(String(/** @type {Error} */ (err).cause ?? err.message ?? err));
		}
		await sleep(500);
	}
	const tail = attempts.slice(-3).join("; ");
	return {
		ok: false,
		detail: `${base}/health unhealthy after ${Math.round(timeoutMs / 1000)}s (${tail}) — see ${root}/logs/daemon.err.log`,
		aggregate,
	};
}

/** @param {number} ms */
export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
