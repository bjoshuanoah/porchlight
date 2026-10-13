# porchlight changelog

Released versions of the porchlight package, newest first. Every cut's entry
under its `## v` heading is the line of record the release workflow copies
into that release's notes (the npm-publish workflow fails loudly if the
heading is missing).

## v0.1.1 — 2026-10-13

- First tagged release cut: published to registry.npmjs.org by the npm-publish workflow via OIDC trusted publishing (github.com/bjoshuanoah/porchlight + npm-publish.yml binding under Brian's npm account) — zero long-lived NPM_TOKEN in repository or CI secrets, provenance attestation on the publish.
- Carries PORCH-063: notification opt-in default — off-by-default settings rows and the walked enable flow.
- Carries PORCH-061: fresh owner bootstrap lands usable — every re-credential ceremony adopts the session it mints, and recovery re-credentials past the freshness gate.

## v0.1.0 — 2026-10-13

- First public publish of porchlight on registry.npmjs.org, cut from Brian's local machine (released history, pre-OIDC): reserved the `porchlight` namespace; hub binary with the bundled runtime closure (npm brings the binary and runtime dependencies; the runtime setup provisions Mongo and Redis).