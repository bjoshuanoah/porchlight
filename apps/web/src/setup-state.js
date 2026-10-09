// Pure setup-wizard helpers (PORCH-020): stage mapping for the two-prompt
// wizard (the network's name, then who you are), name composition, and the
// sanitized resumed-setup copy. The screens own every member-facing word —
// nothing here renders, and no raw server detail ever reaches the viewport.

export const SETUP_STEPS = ["network", "account"];

/**
 * Stage from the hub's setup ledger: what the wizard shows on load.
 * - nothing complete ("fresh or mid-name") → the network-name prompt;
 * - network complete but the owner's names missing → the who-you-are prompt;
 * - both complete → land straight in the network (never a detached console).
 */
export function setupStage(hubState) {
  const done = (step) => hubState?.steps?.[step]?.status === "complete";
  if (done("account") && done("network")) return "landed";
  if (done("network")) return "account";
  return "network";
}

/** First and last names compose the family-facing display name. */
export function fullName(first = "", last = "") {
  return [String(first).trim(), String(last).trim()].filter(Boolean).join(" ");
}

/**
 * Resumed-setup banner copy. Old ledgers could embed a raw settings object
 * in a failure detail; the banner must name the state only — never a data
 * dump in the viewport.
 */
export function resumedDetail(detail) {
  const text = String(detail ?? "").trim();
  if (!text) return "";
  return /\{/.test(text)
    ? "Setup paused here earlier. Nothing was lost — continue below."
    : `Setup paused here earlier: ${text}. Continue below — nothing was lost.`;
}