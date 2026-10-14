# porchlight changelog

Released versions of the porchlight package, newest first. Every cut's entry
under its `## v` heading is the line of record the release workflow copies
into that release's notes (the npm-publish workflow fails loudly if the
heading is missing).

## v0.2.0 — 2026-10-14

- Carries PORCH-067: the bundled tarball's sharp closure is platform-complete — the platform binaries and their libvips trees for darwin-arm64, darwin-x64, linux-x64 (glibc), linuxmusl-x64, and win32-x64 ride the closure (win32 embeds libvips statically, the others carry the split trees), fetched by exact version at pack time so the tarball never depends on the packer runner's OS. v0.1.1 shipped the packer-runner platform only: non-linux hubs started fine but image media operations failed with a platform error. The first v0.2.0 pack (186.1 MB) failed the npm registry publish cap with 413 Payload Too Large (v0.1.1's known-good registry copy sat at 168.2 MB — the effective PUT ceiling is below 186 MB); the closure is now pruned to the media-necessary set of record: the ten sharp trees (ten of sharp's 26 optional-dep packages; the linux/win32 arches outside the supported set, freebsd, and webcontainers excluded; sharp-wasm32 is sharp's universal fallback, v0.1.1 already carried it) plus zero out-of-support binaries — ffprobe-static's ia32 binary trees (81.2 MB unpacked) pruned from the bundle. Packed tarball: 153.8 MB — 22.6 MB below v0.1.1's 176.4 MB release asset (−14.4 MB vs the 168.2 MB v0.1.1 registry copy) and 32.3 MB below the unpruned first pack; the growth mechanism is only the ten sharp trees, and the ffprobe prune more than pays for them.
- Carries PORCH-064: device notifications opt-in default — absent or freshly created settings rows resolve enabled=false, the send pipeline enforces the master switch first (no send attempt for any event without an explicit enable through the settings route), subscription lifecycle gates on the switch, and no backfill flips members who enabled earlier.
- Carries PORCH-065: address change owner re-auth — a hub moved to a new URL re-binds the owner through the device-link grant: the console's register-the-domain path verifies the new origin before any mutation, re-points every self-reference, and redirects to the self-grant consume route; `porchlight reauth link` / `reauth status` carry the machine-local CLI path.
- Carries PORCH-066: the owner console's hub address panel — one field, one submit; the pre-commit verification refuses an unreachable or foreign origin in plain language before any re-point, redirect auto-consumes the self-grant at the new origin, and the arrival lands the owner bound at the new address with no manual grant handling.

## v0.1.1 — 2026-10-13

- First tagged release cut: published to registry.npmjs.org by the npm-publish workflow via OIDC trusted publishing (github.com/bjoshuanoah/porchlight + npm-publish.yml binding under Brian's npm account) — zero long-lived NPM_TOKEN in repository or CI secrets, provenance attestation on the publish.
- Carries PORCH-063: notification opt-in default — off-by-default settings rows and the walked enable flow.
- Carries PORCH-061: fresh owner bootstrap lands usable — every re-credential ceremony adopts the session it mints, and recovery re-credentials past the freshness gate.

## v0.1.0 — 2026-10-13

- First public publish of porchlight on registry.npmjs.org, cut from Brian's local machine (released history, pre-OIDC): reserved the `porchlight` namespace; hub binary with the bundled runtime closure (npm brings the binary and runtime dependencies; the runtime setup provisions Mongo and Redis).