# Porchlight Launch Audit Report (PORCH-015)

The launch-blocker audit that makes the sovereignty promises verifiable:
zero phone-home, every product claim mapped to an enforcing mechanism, the
membership perimeter meeting the public-audit standard. Audit run 2026-10-09
against the repo at PORCH-009 (`ee11825`) plus the remediation set that this
report documents. Companion: `docs/threat-model.md`.

## 1. No phone-home (ac-1)

**Claim**: the server makes zero outbound connections beyond the expected
app-level egress classes; the guarantee is publicly verifiable, not promised.

### Expected app-level egress classes

Every class below lists the exact call sites found by the static inventory
(`node scripts/audit/egress-audit.mjs --inventory`). Anything outside these
classes fails the audit script — CI-runnable and network-free.

| Class | Purpose | Call sites | Who runs it |
|-------|---------|-----------|-------------|
| `tunnel-egress` | Reachability + member traffic only through the family's own hub URL | `packages/cli/src/httpx.mjs:29` (CLI ⇄ owner hub, tunnel-first w/ local fallback), `bootstrap.mjs`, `status.mjs` (via `hubJson`), `start.mjs` spawns `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate` (`spawnTunnel`); browser client `apps/web/src/api.js:5`, `main.jsx:193`, `member-actions.js:62,89`, `apps/server/src/bootstrap.page.ts` (same-origin only) | owner/member-triggered; background loops are user-session-bound polls of the owner's own hub only (identity session renew 8 min, device check 15 s) |
| `installer-binary-downloads` | Dependency-complete bring-up: runtime daemons + tunnel binary, once per home, verified (Mongo MD5, bottles sha256-in-URL, pinned cloudflared tag) | `packages/cli/src/binaries.mjs` — `fastdl.mongodb.org` (mongod 8.0.12 via `MongoBinaryDownload`), `formulae.brew.sh` + `ghcr.io` + `pkg-containers.githubusercontent.com` (Homebrew bottles + dylib closure), `github.com` pinned cloudflared release | owner-triggered at `porchlight setup`/`start`; never background |
| `owner-run-release-verify` | Owner-run update/verification fetches to npm and the signed-release origin; no background update loop exists anywhere (unattended updates deferred, Brian ruling Oct 13 2026 — `cloudflared` runs `--no-autoupdate`) | `scripts/release/verify-release.mjs:157,168` (`api.github.com`, release assets, cosign → Sigstore/Rekor) | explicit owner command |
| `hub-to-hub-trust` | Cross-hub identity at member direction: second-hub adoption and cross-hub token/handoff key verification | `modules/identity/src/services/account.service.js:28` (member-entered `sourceHubUrl`, `redirect:"error"`), `trust.service.js:16` (JWKS/identity-keys at PINNED issuers, fail-closed kid-set intersection) | member/owner flows only |
| `hub-internal loopback` | Mongo/Redis daemons bound to 127.0.0.1; CLI readiness probes | `apps/server/src/dependencies.ts`, `packages/cli/src/start.mjs` probes, `--bind_ip 127.0.0.1` everywhere | hub runtime |
| — | Push transport | **No push transport exists in V1**: `modules/social` outbound surface is empty; notifications are content-free rows the client polls | n/a |

`zero outbound to driftless or porchlight-operated domains`: the static audit
carries a denylist regex (`driftless`, `porchlight.com`, telemetry vendors —
sentry/posthog/mixpanel/amplitude/datadog/bugsnag/newrelic/segment) and fails
the build on any hit; a repo-wide keyword sweep confirms no analytics/
telemetry dependency or library in any package manifest.

### Capture method (reproducible by an external reviewer)

Two instruments, both committed:

1. **Static source inventory** — `scripts/audit/egress-audit.mjs`: scans all
   application source for outbound constructs (`fetch`, `http(s).get/request`,
   `net/tls.connect`, `dgram`, `WebSocket`, `EventSource`, `sendBeacon`);
   every site must map to a class above (or hub-internal loopback), and
   `modules/social/src` + the server controllers/services enforce
   **zero outbound at all**. Exits nonzero on any unclassified site. This is
   the CI-deterministic form of the audit.
2. **Runtime capture** — `scripts/audit/egress-capture.mjs` wraps the
   representative-traffic run (the bring-up e2e: real installer downloads,
   daemon bring-up, hub start, resumable bootstrap). Two app-level instruments:
   - a **hostname ledger**: every node process runs `scripts/audit/egress-preload.mjs`
     (via `NODE_OPTIONS --require`, inherited by node children), recording each
     outbound attempt with its hostname — app-level by construction;
   - **socket corroboration** for binary children (cloudflared → tunnel class;
     mongod/redis-server must stay loopback).
   - App-level vs OS-layer separation: OS-layer traffic (NTP, mDNS, launchd)
     is not hub application code — node children inherit the preload, and
     non-node tree processes are classified per process identity — so OS
     traffic cannot enter the claim by construction.

**Launch-run evidence (2026-10-09, this machine**, macOS arm64, Node 26.8.1):** the
bring-up e2e passes (1/1) and the capture reports zero unexpected
destinations. Observed ledger, all inside expected classes:

```
fastdl.mongodb.org               installer-binary-downloads   (mongod fetch)
formulae.brew.sh                 installer-binary-downloads   (redis bottle metadata)
ghcr.io                          installer-binary-downloads   (bottle blobs)
pkg-containers.githubusercontent installer-binary-downloads   (GHCR blob delivery)
github.com / release-assets…     installer + owner-run-release-verify (cloudflared pin / release tooling)
127.0.0.1                        hub-internal loopback        (daemons + hub listener)
```

No driftless, porchlight.com, telemetry-host, or unclassified destination
appeared. The e2e runs `--no-tunnel` (deterministic, no-CDN by test design),
so the tunnel class did not fire in this capture; its presence and behavior
are pinned by the static inventory (`start.mjs` `spawnTunnel`).

## 2. Claim-to-mechanism trace (ac-2)

Every sovereignty/privacy claim rendered to a member or the public, mapped to
its enforcing mechanism. Unbacked or contradicting claims were removed before
launch; the copy audit remains CI-pinned (`apps/web/scripts/audit.mjs`).

| Claim (surface) | Mechanism | Status |
|---|---|---|
| "Posts you hide stay hidden for you on this device" (`apps/web/src/identity.jsx`) | client-local hidden list (`store.js:18-31`), timeline filter (`main.jsx:179-182`), zero network calls, server stores nothing (`routes.js:50-52`, `feed.service.js:27-29`) | backed |
| Local PIN stays on this device (`identity.jsx:251,274`) | PBKDF2 digest + salt in localStorage only; saves make no network request | backed |
| Pairing code single-use, 24h expiry (`identity.jsx`) | one-time row consumption `device.service.js:97-98`; expiry tests `device-continuity.test.js:193-197` | backed |
| Device list is self-scope only (`identity.jsx:375,377`) | did-mismatch → `E_FORBIDDEN` (`device.controller.js:33-38,52,86`) | backed |
| "The archive includes originals available to this membership" (`identity.jsx:392`) | export actually covers **member-authored** content (`export.service.js` streamMemberExport) | **fixed**: copy rewritten to "your authored posts, comments, reactions, and original media" |
| Export capability (`identity.jsx:391`) | device-signed `{scope:"export"}` → `verifyExportRequest` → streamed ZIP, no server staging (`member-actions.js:89`, `export.service.js:59-91`) | backed |
| Group posts stay within the network (`social.jsx:222`) | group member validation (`group.service.js:24-39`), origin containment in interactions, token-scoped group timeline | backed |
| Mentions restricted to origin members (`social.jsx:238`) | `E_MENTION_NOT_MEMBER` validation (`interaction.service.js`) | backed |
| Search scoped to your network (`social.jsx`) | `FeedService.search` scopes to `#originOf(accessToken)` (`feed.service.js:85-107`) | backed |
| Offline caches / posting guard (`main.jsx`, `social.jsx`) | 24h timeline cache; compose blocks upload while offline | backed |
| "Invites and settings are owner-managed from the hub" (CLI bootstrap completion line) | **was contradicted**: console surfaces had no enforcement | **backed after remediation**: `#requireOwner` on every console route (`console.controller.js:42`); finding remediated in this run |
| Hub daemons bind local-only; remote reach only via the tunnel (`state.mjs`, `start.mjs`) | `--bind_ip 127.0.0.1`, `cloudflared --no-autoupdate` only tunnel process | backed |
| Zero external telemetry (internal doc comment + `docs/release-verification.md`) | absence verified both statically and by runtime capture (section 1); health probes ping local daemons only (`health.service.ts`) | backed |
| Vote privacy: votes private, never rendered; no counts cross the wire (routes.js/comments + PRD contract) | per-member vote rows consumed only by the formula module; post views omit vote data (`feed.service.js:75-83`); export omits votes (`export.service.js:24-26`); pinned by `feed.service.test.js:256-278` | backed — note: currently enforced in code but not claimed to members in UI copy |
| Signed releases (docs/release-verification.md) | cosign keyless bundle + SHA256SUMS + npm provenance (`deploy.yml`, `verify-release.mjs`, negative fixtures) | backed |
| Key custody: "private key material is never accepted" (API copy) | `assertPublicJwk` rejects `"d"` at every entry (`device.service.js`, `account.service.js:48-51`); browser keys non-extractable (`device.js`) | backed |
| Source comment "who reacted never leaves this surface" (`main.jsx:185`) | **false**: per-member reaction rows do cross the wire (the client only renders emoji values) | **fixed**: comment rewritten to state the actual behavior |

**Unbacked-claim disposition**: both contradicted/overbroad items were fixed
(exact edits in the PR); no claim remains without a named mechanism. The
README does not yet exist at the repo root — no sovereignty claim surface
exists outside the app copy and `docs/`, so nothing here goes unverified;
creating public-facing claim copy beyond the traced surfaces was out of scope
for this audit (flagged, not silently invented).

## 3. Perimeter public-audit standard (ac-3)

Single access-control module per plane, every member-only route traceable:

- **Social plane**: `MembershipService.verifyAccessToken` (`membership.service.js:200`)
  + `verifyMemberWrite` (:254) are the only permission boundary; every
  content/feed/media/interaction surface funnels through it; console surfaces
  add the owner-role check (`console.controller.js:42` `#requireOwner`, first
  line of all 14 console handlers); export enforcement lives once in
  `export.service.js:59`.
- **Identity plane**: `AuthService.verifyAccessToken` (`auth.service.js:134`)
  via the controllers' `requireSession` (`device.controller.js:18-27`);
  present on device surfaces, and now on handle/profile, OIDC authorize, and
  migration handoff. Cross-hub verification is fail-closed against pinned
  issuers (`trust.service.js`).
- Route-table pinning: `apps/server/test/membership-perimeter.test.ts`
  (anon → 401, member → 403, owner → 200 on console surfaces; era-gate
  closures), `modules/identity/test/perimeter.test.js` (identity route
  table), new `modules/social/test/console-owner.test.js` +
  `bootstrap-era.test.js`, `modules/identity/test/session-bound-writes.test.js`.
- Threat model for external reviewers: `docs/threat-model.md` (trust
  boundaries, actors, assets, residual risks).

## 4. Launch-blocker semantics (ac-4)

Failed findings touching the approved-members perimeter, remediated then
re-run clean with evidence (full details + code anchors in
`docs/threat-model.md`, section "Findings and remediation"):

1. Owner console anonymous (critical) → owner-gated; pinned by
   `apps/server/test/membership-perimeter.test.ts` + `console-owner.test.js`.
2. Identity-plane anonymous writes: handle/profile (critical), migration
   handoff (critical), OIDC authorize impersonation (high) → session-bound;
   pinned by `session-bound-writes.test.js` (11 cases, fail-closed).
3. Bootstrap-era surfaces open forever (medium) → ledger-gated era with
   fail-closed default; pinned by `bootstrap-era.test.js` + server-era tests.
4. Bootstrap continuity vs keys-on-device (critical, pre-existing) → owner
   device binding restored on both bootstrap paths (browser-vault key on the
   served page; owner-local key file for the CLI, public JWK only on the
   wire); pinned by `owner-device.test.js` + the re-pinned bring-up e2e.
5. Inline duplicated export check (structural) → single `verifyExportRequest`.

Re-run status: full matrix green (`npm run test` = turbo test + boundary
check; lint, typecheck, build clean), `node scripts/audit/egress-audit.mjs`
clean, bring-up e2e under egress capture clean with zero unexpected
destinations. No finding remains open; the hub is launch-ready on this
evidence.