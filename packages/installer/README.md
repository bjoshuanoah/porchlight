# @porchlight/installer — signed macOS pkg + first-run headless bootstrap (PORCH-134)

A fresh Apple-Silicon Mac deploys Porchlight Home with **zero GUI
interaction**: install the pkg (manually over SSH or via MDM), the system
reboots headless, all engine services auto-start under their LaunchDaemon,
and the status page reports them healthy.

## What one install does

1. **Payload** lands at `/Library/Porchlight` — the engine packages
   (runtime import graph only: installer, recorder, hal + their runtime
   deps), the `porchlight-home` launcher, and an optionally bundled node
   runtime.
2. **First-run bootstrap** (postinstall, idempotent): directories → **config
   of record** at `/Library/Porchlight/config/config.yaml` (written once;
   never overwritten on reinstall) → **system LaunchDaemon**
   (`/Library/LaunchDaemons/com.porchlight.home.plist`, `RunAtLoad` +
   `KeepAlive`) → `launchctl bootstrap system` → verification (plist lint +
   health endpoints polled until healthy).
3. **Status page** serves at the hub's `statusPort` (default `8970`, all LAN
   interfaces): `GET /` renders the plain-language status HTML, `GET /health`
   the machine-readable aggregate. Zero analytics, zero script tags, nothing
   fetched from the network.

## Headless deploy

```sh
# build (on a Mac with pkgbuild; signing with a Developer ID Installer cert)
bin/installer.js build --out dist/porchlight-home-0.5.3.pkg \
  --sign-identity "Developer ID Installer: …" [--node /path/to/node24]

# deploy to the fresh Mac over SSH — no GUI interaction ever
sudo installer -pkg porchlight-home-0.5.3.pkg -target /
sudo shutdown -r now        # headless reboot: launchd starts the daemon at boot
# verify
porchlight-home status      # /health JSON
porchlight-home verify      # plist lint, config, payload, health
```

Unsigned builds are possible but stated, never silent — the build prints the
Gatekeeper consequence and the CLI reports `UNSIGNED`.

## Local Network / TCC posture (the field finding)

macOS 15+ local network privacy silently drops LAN traffic from unapproved
processes (TN3179). The facts of record, encoded in `src/tcc.js` and
`docs/local-network-bootstrap.md`:

- **Any launchd-started daemon (system domain) is automatically allowed**;
  the exemption does *not* apply to launchd agents. This is why the platform
  runs as a LaunchDaemon, and why the earlier LaunchAgent autostart shape
  (PORCH-127's recorder agent) is superseded for the platform services.
- **MDM cannot configure local network privacy**; **tccutil cannot reset**
  the Local Network privilege. For a user-session program that must reach
  the LAN, the supported knobs are the System Settings toggle and the
  site-admin allowlist defaults (`com.apple.network.local-network`,
  macOS 15.5+, restart required).
- `porchlight-home verify-network` sends a UDP multicast discovery probe —
  a Local-Network-regulated operation — and makes the silent loss
  observable in plain language.

## Layout

```
src/daemon.js       LaunchDaemon plist generator + launchctl commands (domain-neutral XML)
src/config.js       config of record: bootstrap write-once, validate (recorder contract + status fields)
src/bootstrap.js    the first-run sequence + verification (one code path, manual and postinstall)
src/status-page.js  health aggregation + deterministic HTML + /health JSON
src/runtime.js      the daemon composition root: recorder supervisor + status server
src/tcc.js          Local Network posture, site-admin fallback commands, UDP probe
src/signing.js      Developer ID resolution (explicit unsigned builds, never silent)
src/payload.js      payload assembly for pkgbuild (runtime import graph only)
src/pkgspec.js      install scripts + pkg build
bin/installer.js    CLI (daemon | build | bootstrap | launchd | verify | status | verify-network | posture)
```

The recorder supervisor is the engine's headless service of record; with an
empty camera fleet (legal since PORCH-134: property-agnostic fresh install)
it starts idle and the status page renders the awaiting-configuration state.
