// PORCH-034 (second round): devices bound before name resolution stored the
// device label ("Browser") or a local fallback as the identity's name. The
// hub resolves the member's family-facing name on every re-credential
// (social/session/restore), so one quiet sweep at app open re-credentials
// every device-connected identity — no rebind, no manual step — and the
// person never presents as their hardware. Rows that fail (hub unreachable,
// identity without a usable device key) stay untouched and heal on the next
// open; sweeps never write storage themselves.
export async function resolveStoredNames(rows, { openDeviceSession, request }) {
	const updates = [];
	for (const row of rows || []) {
		if (!row?.identity?.id || !row?.deviceId || !row?.url) continue;
		try {
			const session = await openDeviceSession(row, { did: row.identity.id, deviceId: row.deviceId }, request);
			const restored = await request({ url: row.url, token: session.accessToken }, "social/session/restore", {
				method: "POST",
				body: JSON.stringify({ identityAccessToken: session.accessToken, deviceId: row.deviceId }),
			});
			const name = restored?.sessions?.[0]?.name ?? null;
			if (name && name !== row.identity.name) updates.push({ id: row.identity.id, name });
		} catch { /* unreachable hub or unopenable identity: keep the stored name */ }
	}
	return updates;
}