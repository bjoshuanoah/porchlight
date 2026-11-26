// errors.js — the fail-closed error family of the agent runtime (PORCH-147).
//
// AgentIsolationError: a cross-member state access (or a storage-key escape
// attempt) was refused at the storage seam. Every such refusal is logged on
// the runtime's refusal trail before the error is thrown — the error is the
// plain-language verdict, the trail is the audit.

export class AgentIsolationError extends Error {
	/**
	 * @param {string} message   plain-language reason
	 * @param {object} [attempt] what was attempted (member, scope, op, key)
	 */
	constructor(message, attempt = {}) {
		super(message);
		this.name = "AgentIsolationError";
		this.code = "AGENT_ISOLATION_REFUSED";
		this.attempt = attempt;
	}
}
