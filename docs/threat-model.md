# Porchlight Hub — Threat Model

Audience: external reviewers auditing the Porchlight sovereignty contract
(Porchlight Server PRD 2). Companion to the launch audit report
(`docs/launch-audit.md`). Everything here is checkable against the public
source; each section names the code that enforces it.

## Scope

One hub deployment on a family machine: identity domain + social domain, a
Cloudflare-class tunnel for reachability, Mongo + Redis as local daemons, one
SPA served by the hub. Phase 1 (self-hosted), no AI surfaces, no hosted tier.

## Trust boundaries

| # | Boundary | Enforcer |
|---|----------|----------|
| 1 | Public internet → hub | Membership tokens issued only at the social admission gate (`modules/social/src/services/membership.service.js:78` `admit`, verified by `verifyAccessToken:200`); device-key challenge sessions in the identity domain (`modules/identity/src/services/auth.service.js:78` `openSession`, `verifyAccessToken:134`). The tunnel grants reachability only; every authorization decision is made server-side against these two verifiers. |
| 2 | Identity plane ⟂ social plane | Zero shared code or models (CI-enforced `scripts/boundary-check.mjs`). The single wired seam is one injected DID-verifier callback (`apps/server/src/router.ts` passes identity's `verifyAccessToken` into social assembly as `verifyMemberIdToken`); it proves who is presenting, never what they may do. |
| 3 | Member device ↔ hub writes | Every state-changing write carries an Ed25519 device signature over the canonicalized payload, verified against the enrolled device key: social `verifyMemberWrite` (`membership.service.js:254`), identity challenge-signature (`auth.service.js:78`). Private keys never leave devices (web: non-extractable `apps/web/src/device.js`; API rejects any JWK carrying `"d"`: `E_PRIVATE_KEY_REJECTED`). |
| 4 | Owner ↔ members | The owner is a special role, proven by identity, never by an invite: the network row records `ownerDid` at creation (`network.service.js:30`) and admission forces role `owner` exactly when the admitted DID is the network owner (`membership.service.js:101`, founder rule). Bootstrap binds the owner directly: network creation seeds the founder's owner-role membership (`bindFounder`, PORCH-018), and a session restore re-binds a founder whose hub predates the binding. Owner-console surfaces require an owner-role membership session (`console.controller.js:42` `#requireOwner`). |
| 5 | Network origin containment | Membership tokens resolve to exactly one network scope (`verifyAccessToken(accessToken, {networkId})`); content routes carry no origin in the URL and services scope every read/write to the token's origin. Cross-origin interaction writes are unaddressable (foreign-origin posts resolve as not-found, `interaction.service.js`). CI boundary test runs on every push. |
| 6 | Bootstrap era ↔ steady state | Bootstrap-era write surfaces (first account, network creation, invite issue/revoke, quota ceilings) are callable only while their ledger step is incomplete; each closes permanently once the hub is bootstrapped (`social-bootstrap.controller.js:32` `#eraOpen`, `apps/server/src/controllers/bootstrap.controller.ts`). Default fail-closed: an unwired ledger gate closes the era. |

## Actors and capabilities

- **Outsider** (network reach, no token): can read public-by-design surfaces
  only — DID documents, well-known discovery, join-link verification (checks
  a code exists, discloses the network name), and hub health/bootstrap state.
  Everything else returns 401/403/404. Cannot read any content, timeline, or
  member data; cannot write anything of consequence during steady state.
- **Member** (membership token + enrolled device key): reads/writes only
  within their origin network; writes carry their device signature; votes are
  recorded but never returned for display; hide/ignore lists are client-local
  (the server stores no per-member hidden state).
- **Delegate**: modeled role (`owner`/`delegate`/`member`), admission grants
  delegate only via owner-issued invites; the V1 owner console is owner-only.
- **Owner**: full console — invites, membership revocation (kills sessions in
  the same write, `revokeMember`), quantity-only limits, retention sweeps,
  audit trail. CANNOT read member content beyond the same rules (access
  checks ride membership, not owner identity; hub-owner limits are
  quantity-only by contract).
- **Hub operator** (the person running the machine): holds the hardware. The
  contract is protocol-grade — device-key signatures, signed export,
  per-origin containment, hashed session/tabular tokens at rest — not any
  runtime isolation from the operator. Documented as an honest limit.

## Assets

- Member originals and derived renditions (media store, origin-scoped).
- Timeline content: posts, comments, reactions, cross-post copies.
- Membership sessions (opaque tokens, SHA-256 at rest, 10-minute access TTL).
- Identity rows + DID documents (public by design), device public keys.
- Owner join-link tokens (secrets embedded in join URLs — revocable, one
  redemption max at issue).

## Findings and remediation (PORCH-015 launch gate)

The 2026-10-09 audit run found these; all were remediated before launch and
are pinned by tests (see `docs/launch-audit.md` for the full evidence table):

1. **Owner console had zero enforcement** (critical). All `/api/social/console/*`
   routes answered anonymous requests (the repo's own perimeter contract test
   asserted 200 without a token). Remediated: `#requireOwner` on every console
   handler; route table re-pinned anonymous→401, member→403, owner→200.
2. **Identity-plane writes were unauthenticated** (critical): handle/profile
   reassignment for any DID; migration handoff re-pointing any identity's
   homing. Remediated: session-bound controllers, did must match the caller.
3. **OIDC authorize impersonation** (high): an auth code could be issued for
   any DID merely holding a live session — caller and subject never had to
   match. Remediated: bearer session required and bound to the subject DID.
4. **Bootstrap-era surfaces stayed open forever** (medium): network creation,
   invite issue/revoke and quota writes were anonymous with no closure.
   Remediated: ledger-gated era closures (fail-closed), post-bootstrap surfaces
   live behind the owner console (owner-only).
5. **Bootstrap continuity vs keys-on-device** (critical, pre-existing):
   first-account creation had been made device-mandatory by the identity core,
   but the CLI bootstrap and the served bootstrap page still created accounts
   without devices — the owner path was broken end to end (and a device-less
   account can never open a session). Remediated: the served page generates a
   non-extractable key in-browser into the SPA's device vault and binds a
   device at account creation; `porchlight bootstrap` provisions the owner's
   server-adjacent device key locally (`packages/cli/src/owner-device.mjs`,
   0600) and presents only the public JWK.
6. **Inline duplicated enforcement** (structural): the media-export route
   verified sessions with its own ad-hoc check while every other surface went
   through the service. Consolidated: a single `verifyExportRequest` owns the
   check (`export.service.js:59`).

## Residual risks (documented, accepted for launch)

- **Bootstrap-era race**: between tunnel bind and owner bootstrap, an attacker
  who learns the tunnel URL could race first-account/network/invite creation.
  Requires knowing the unguessable `*.trycloudflare.com` URL during a window
  of minutes, and the hub URL is shared only with the family. Not a security
  control — but the era closes permanently at bootstrap completion, and every
  post-era path is membership-gated.
- **SPA token custody**: membership tokens persist in `window.localStorage`
  of the SPA origin (one token per hub connection). XSS on the SPA origin can
  steal them across all stored connections. Mitigations that exist: no third
  -party scripts (VITE-bundled MUI only, no CDN), member copy/route audit in
  CI forbids new vocabulary classes. Not mitigated: full CSP hardening —
  carried as follow-up.
- **Invite redemption counter**: invite `maxUses` is enforced by a read-guard
  under the hub's single-writer assumption rather than an atomic conditional
  update; a parallel admission burst across many devices could exceed
  `maxUses`. Impact is bounded to extra admissions of an already-shared link;
  the owner sees and revokes rows in the console. Documented, not fixed in V1.
- **OS-layer traffic**: NTP/mDNS/launchd traffic is OS-managed and outside the
  hub's process tree; the egress audit's claim covers app-level traffic only
  (captured by construction — see `docs/launch-audit.md`).

## How to verify (for reviewers)

```
npm run test          # full matrix + module-boundary check
npm run lint && npm run typecheck
node scripts/audit/egress-audit.mjs          # static egress inventory
PORCHLIGHT_E2E=1 npm run build && \
  PORCHLIGHT_E2E=1 node scripts/audit/egress-capture.mjs \
    -- node --test packages/cli/test/bringup-e2e.test.js
```