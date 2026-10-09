// Update-surface helpers (PORCH-040): the owner console's update card and
// the post-apply wait for the restarted hub. Pure logic + an injectable
// fetch loop so the checks run without a browser.

/**
 * Card model for the update surface. The console shows the current release,
 * the newer release when one exists, and never fetches or applies anything
 * on its own — rendering follows exactly what the owner-initiated check
 * reported (release: { current, latest, updateAvailable, note? }).
 */
export function updateCardModel(release) {
  if (!release || release.current == null && release.latest == null) {
    return { state: "unavailable", lines: [] };
  }
  const current = release.current ?? null;
  if (release.latest == null) {
    return {
      state: "unavailable",
      lines: [`Current release: ${current ? `v${current}` : "unknown"}`],
      note: release.note || "The npm registry could not be reached, so the latest release is unknown. Nothing was fetched or changed.",
    };
  }
  if (!release.updateAvailable) {
    return {
      state: "latest",
      lines: [
        `Current release: v${current}`,
        current ? `porchlight v${current} is the latest release.` : "The npm registry reports no newer release.",
      ],
    };
  }
  return {
    state: "newer",
    lines: [`Current release: v${current}`, `Newer release available: v${release.latest}.`],
    applyTo: release.latest,
  };
}

/**
 * After the apply response arrives, the hub restarts itself; the console
 * waits for the restarted release to answer before refreshing the card, so
 * it reflects the new version served at the same address. The hub's own
 * readiness budget is 90s; this wait covers it and reports plainly if the
 * hub has not come back.
 */
export async function waitUntilHubHealthy(url, { timeoutMs = 150_000, delayMs = 2000, fetchFn = fetch, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const health = new URL("/api/health", url || window.location.origin);
  const startedAt = Date.now();
  for (;;) {
    await delay(delayMs);
    try {
      const response = await fetchFn(health, { headers: { accept: "application/json" } });
      if (response.ok) {
        const body = await response.json();
        if (body?.service === "porchlight-server") return true;
      }
    } catch {
      // still restarting
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("The hub has not come back healthy yet after the update. It may still be restarting — reopen the owner console in a moment, or run porchlight status on the hub machine.");
    }
  }
}