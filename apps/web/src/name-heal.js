// PORCH-034 (second round): devices bound before name resolution stored the
// device label ("Browser") or a local fallback as the identity's name. The
// hub resolves the member's family-facing name on every re-credential
// (social/session/restore), so one quiet sweep at app open re-credentials
// every device-connected identity — no rebind, no manual step — and the
// person never presents as their hardware. Rows that fail (hub unreachable,
// identity without a usable device key) stay untouched and heal on the next
// open. Sweeps never write storage themselves: each successful
// re-credential returns one update row and the caller merges it.
//
// PORCH-061: every opened device session supersedes the stored identity
// token by design (PORCH-028), so the sweep adopts what it mints — returning
// only the healed name used to leave the stored connection presenting the
// very token this sweep superseded, and the identity plane 401'd dead until
// the custody gate allowed the next renewal. Each update carries the minted
// identity session; when the restore answers, the membership tokens and the
// hub-resolved name ride it too. A refused restore limits adoption to the
// identity plane and leaves the stored membership tokens untouched.
export async function resolveStoredNames(rows, { openDeviceSession, request }) {
	const updates = [];
	for (const row of rows || []) {
		if (!row?.identity?.id || !row?.deviceId || !row?.url) continue;
		try {
			const session = await openDeviceSession(row, { did: row.identity.id, deviceId: row.deviceId }, request);
			const update = {
				id: row.identity.id,
				name: row.identity.name,
				identityToken: session.accessToken,
				identityRefreshToken: session.refreshToken,
			};
			try {
				const restored = await request({ url: row.url, token: session.accessToken }, "social/session/restore", {
					method: "POST",
					body: JSON.stringify({ identityAccessToken: session.accessToken, deviceId: row.deviceId }),
				});
				const first = restored?.sessions?.[0];
				if (first) {
					if (first.name) update.name = first.name;
					update.token = first.accessToken;
					update.refreshToken = first.refreshToken;
					update.networkId = first.networkId;
				}
			} catch { /* refused restore: adopt the mint, keep the stored membership tokens */ }
			updates.push(update);
		} catch { /* unreachable hub or unopenable identity: keep the stored row */ }
	}
	return updates;
}
