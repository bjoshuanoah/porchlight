/**
 * Owner-console address panel model (PORCH-066). Pure mapping between the
 * reauth status surface (PORCH-065) and the console's register-the-new-domain
 * screen, so the panel's read rows, pre-submit draft guard, and named-
 * consequence guidance stay deterministic and unit-testable without a DOM.
 * The screens own the rendering; this module owns the state shape.
 */

/**
 * The panel's read rows: the hub's address (name + URL) and the last
 * self-reference re-point, exactly as `porchlight reauth status` reports
 * (the panel reads the same surface the CLI reads). `reauth === null`
 * renders the plain unavailability fallback; `server.url` — the origin
 * this browser session actually speaks to — stands in when the hub runs
 * the pre-065 shape.
 */
export function addressPanelModel({ reauth, server, networkName } = {}) {
  return {
    name: networkName ?? null,
    url: reauth?.servingOrigin || server?.url || null,
    lastRepoint: reauth?.lastRepoint || null,
    residue: reauth?.residue || [],
  };
}

/**
 * Pre-submit guard on the owner's typed draft: the field takes the hostname
 * only (like `porch.love`), never a scheme, path, or user info. This is a
 * convenience guard only — the server's pre-commit verification owns the
 * decision (reachable, serving this hub's instance identity); this guard
 * merely keeps the owner's own typos out of the request.
 */
export function draftHost(value) {
  const text = String(value ?? '').trim();
  if (!text) return { host: '', error: 'Enter the new address first.' };
  const stripped = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (!stripped || /\s|\/|@/.test(stripped)) {
    return { host: '', error: 'Enter just the address, like porch.love — nothing before or after it.' };
  }
  return { host: stripped, error: '' };
}

/**
 * The move-time consequence guidance (ac-4): four named consequences, in
 * family language — dead join links, notification subscriptions that
 * re-establish on their own, fresh client-local state, and revocable
 * orphaned registrations. `kind` is the test-facing name; `line` renders.
 * The copy audit is the family-language gate.
 */
export const addressConsequences = [
	{ kind: 'joinLinks', line: 'Join links made before the move stop working — fresh ones take seconds to make.' },
	{ kind: 'notifications', line: 'Where a member turned notifications on, they reconnect at the new address on their own.' },
	{ kind: 'clientState', line: 'Each device keeps its own small choices — display style, hidden posts, the optional screen PIN — at the address, so these start fresh.' },
	{ kind: 'orphanedDevices', line: 'Devices left behind at the old address can be removed from the Members tab for tidiness.' },
];

/** The consequence kinds the guidance must cover, in render order (ac-4). */
export const addressConsequenceNames = addressConsequences.map((item) => item.kind);

/** The move-time headline above the guidance list. */
export const addressIntro = 'Your family\'s moments and accounts stay put — this changes only the address the hub is known by.';

/** The re-run sentence (ac-2): a dropped redirect re-runs safely. */
export const addressRerunNote = 'If the browser closed before the move finished, submitting the same address again is safe — the change never applies twice, and a fresh one-time link is made.';

/** The arrival beat (ac-3): brief, then the timeline. */
export const arrivalBeatCopy = 'Opening your hub at the new address';

/**
 * The action's success mapping: the SPA leaves this origin for the redirect
 * the server minted — never a constructed URL, never the typed draft.
 */
export function redirectTarget(result) {
  return result?.redirectUrl || null;
}