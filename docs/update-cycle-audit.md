# Porchlight owner-run update-cycle composition audit (PORCH-016)

The composition test for the owner-run update cycle (Brian rulings, Oct 13,
2026: npm is the only install surface; unattended updates are deferred out of
V1). Each subsystem of the cycle ships its own unit coverage; nothing else
proves the composition — the subsystems behave coherently as ONE system only
when a staged scenario runs them together, the way an owner's update cycle
actually runs.

## What composes

| Subsystem | Where it lives | Specced source (Porchlight Server) |
| --- | --- | --- |
| npm install surface | `packages/cli` (the `porchlight` package; release tarballs built by `scripts/release/bundle-cli.mjs`) | Home Server Baseline and Bootstrap; Operations |
| Install-time restart (stop + start, or launchd's KeepAlive respawn) | `packages/cli/src/stop.mjs`, `start.mjs`, `service.mjs` | Operations (owner-run update line) |
| Supervisor restart budget + named crash-loop fallback | `packages/cli/src/supervisor.mjs` | Operations; Home Server Baseline (supervision) |
| launchd supervision (KeepAlive) | `packages/cli/src/service.mjs` | Home Server Baseline and Bootstrap |
| Disk-guard hard-stop | `modules/social/src/services/media.service.js` (`#diskGate`, `diskStatus`) | Media Pipeline and Quota Enforcement |
| Owner-console threshold + release status | `modules/social/src/controllers/console.controller.js` (`/console/disk`, `/console/system`), `packages/cli/src/status.mjs` | Media Pipeline; Operations |
| Member content integrity | the identity + social module data paths under the porchlight home | Sovereignty contract |

Deferred out of V1 by ruling (Brian, Oct 13, 2026): unattended apply, the
pre-update snapshot, and automatic rollback machinery (phase-2 candidates).
Rollback in V1 is npm's own semantics: the documented previous-version
reinstall. The docker composition is ruled out on the npm path, so the
scenarios are docker-agnostic by contract.

## Method

`packages/cli/test/update-cycle-composition.test.js`, env-gated behind
`PORCHLIGHT_E2E=1` like the bring-up e2e (real daemon binaries download
~100 MB; the regular `npm run test` matrix stays deterministic without network).

1. **Releases.** `scripts/release/bundle-cli.mjs` builds the real
   self-contained install tarball of the tree (the previous release, 0.1.0).
   Two variants are cut from it: a known-good release (0.3.0 — version bump
   on the CLI and the bundled hub runtime) and a deliberately broken release
   (0.2.0-broken — the hub child exits before serving with a named reason).
2. **Reference home.** One real `porchlight setup` run provisions the
   daemons into a template home; every scenario home copies it. Each scenario
   installs releases with `npm install -g --prefix <stage> <release>.tgz` —
   the npm surface, exactly the README's release-tarball update path — so
   npm's own install semantics (and its rollback on the failed-install case)
   are exercised, not simulated.
3. **Content.** Representative content (owner account, network, member
   admission through the real join flow, two posts, one comment, one
   committed multipart photo upload with the hub-generated rendition set) is
   seeded through the real HTTP surfaces; member-data loss zero is measured
   by content counts across every cycle.
4. **Scenarios** (all checks resolve by name into the evidence report):
   - **A (ac-1)**: owner-run update to the known-good release ends healthy —
     install → restart → post-start verification in order; feed smoke check
     passes; the running release identity matches the installed release.
   - **B (ac-2)**: owner-run update to the broken release fails its
     post-start verification; the failing state is locally diagnosable (the
     named crash-loop fallback, `porchlight status` diagnosis + recovery
     line, named reason in the hub log); the documented previous-version
     reinstall restores serving with member-data loss zero.
   - **C (ac-3 + ac-4)**: the storage volume sits at the hard-stop threshold
     (a small APFS volume mounted for the scenario; the disk guard's own
     live probe sees it through `<home>/media`); the owner-run update runs
     ON that volume — upload admission stays hard-stopped, reads continue,
     the console threshold status stays accurate after the restart cycle,
     the update path never fills the remaining free space, and the cycle
     ends complete.
   - **E (ac-5)**: with launchd supervision installed (`porchlight service
     install`), the restart onto the broken release crash-loops; the
     supervisor exhausts its restart budget and stops the group into the
     named fallback which stays STABLE under launchd KeepAlive (no respawn
     thrash — the idling supervisor is the stable state); the documented
     reinstall re-establishes serving.

## Composed-failure matrix

The evidence test refuses any matrix cell without a resolved check — no
scenario or subsystem is silently skipped. On non-macOS platforms the darwin
legs (small-volume mount, launchd supervision) are recorded as explicitly
named skips (the scenario skip text is the cell resolution), never silent.

The matrix is written with the report (`PORCHLIGHT_UPDATE_CYCLE_REPORT=<path>`,
a JSON file with every scenario's ordered stages, checks, and log excerpts)
and the run's summary is recorded on the task trail.

## Reproduce

```bash
npm run build
PORCHLIGHT_E2E=1 node --test packages/cli/test/update-cycle-composition.test.js
# keep the artifacts for inspection:
PORCHLIGHT_E2E=1 PORCHLIGHT_E2E_KEEP=1 PORCHLIGHT_UPDATE_CYCLE_REPORT=/tmp/report.json node --test packages/cli/test/update-cycle-composition.test.js
```

Deterministic unit coverage for the crash-loop fallback machinery runs in the
default matrix: `packages/cli/test/update-fallback.test.js`.

## Findings resolved on this task

- **Installed-vs-running release gap was invisible.** Between an owner's
  `npm install` and the restart, the running supervisor serves the previous
  release with no surface saying so; a hub child restarted in that window
  could spawn against a deleted install closure silently. Resolved: the
  supervisor journals spawn failures by name (ENOENT on the vanished entry
  counts as a failed start), `start`/`status` diagnose the version gap
  loudly (`release update detected` / `release: UPDATE PENDING`), and the
  crash-loop budget makes the stale-entry case resolve into the named
  fallback instead of an endless silent re-spawn.
- **No exhausted-restart state existed.** The supervisor retried failing
  children forever. Resolved (`supervisor.mjs`): five consecutive starts
  without readiness stop the whole group into `state/fallback.json`
  (crash-loop-fallback, failed attempts, named last error, hub log path),
  `porchlight status` surfaces it with the recovery line, and the
  supervisor stays ALIVE on purpose — under launchd KeepAlive an exited
  supervisor would simply respawn into the same crash-loop.
- **Post-start verification did not exist.** `porchlight start` now probes
  the hub's health surface via the supervisor's readiness probe and journals
  its verification line (`post-start verification passed/failed`) into the
  home logs — the failing check is named for ac-2's diagnosis requirement.