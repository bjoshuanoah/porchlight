# Porchlight

Porchlight is a private social hub for a family: photo sharing, a timeline, albums, comments, and reactions, running on your own machine and reachable from your own web or mobile web browser by approved members. No algorithmic feed, no advertising, no analytics, no content on anyone else's servers.

[License: MIT](LICENSE)

---

## Prerequisites

| Requirement | Details |
| --- | --- |
| A computer that stays on | A home machine (Mac, Windows, or Linux box). |
| Node.js **24 or newer** | [Download Node.js](https://nodejs.org). Check with `node --version`. Porchlight will not install on older Node versions. |
| Nothing else | No database to install, no Docker, no port forwarding. `porchlight setup` brings its own databases (Mongo and Redis) and tunnel software at first run — you never install these by hand. |

## Install from npm (recommended)

One command:

```bash
npm install -g porchlight
```

This installs the `porchlight` command globally — the hub runtime and all of its runtime dependencies come with it. When the command finishes, the binary already works; there is no further registration step:

```bash
porchlight --version   # prints e.g. "porchlight v0.1.0"
porchlight             # prints the command help
```

## Install from GitHub

If you want the artifacts straight from the repository instead of the npm registry, there are two ways. Both register the `porchlight` command without installing anything from the registry.

### Option A — signed release tarball (release binaries)

Every release publishes a self-contained `porchlight-<version>.tgz` tarball and a signed `SHA256SUMS` manifest — see the [releases page](https://github.com/bjoshuanoah/porchlight/releases). Full verification instructions live in [`docs/release-verification.md`](docs/release-verification.md); the short path:

```bash
export PORCHLIGHT_VERSION=0.1.0

# 1. download the tarball and its signed checksum manifest
curl -LO https://github.com/bjoshuanoah/porchlight/releases/download/v$PORCHLIGHT_VERSION/porchlight-$PORCHLIGHT_VERSION.tgz
curl -LO https://github.com/bjoshuanoah/porchlight/releases/download/v$PORCHLIGHT_VERSION/SHA256SUMS
curl -LO https://github.com/bjoshuanoah/porchlight/releases/download/v$PORCHLIGHT_VERSION/SHA256SUMS.bundle

# 2. verify (needs shasum; signature check additionally needs cosign — see docs/release-verification.md)
shasum -a 256 -c SHA256SUMS porchlight-$PORCHLIGHT_VERSION.tgz
cosign verify-blob SHA256SUMS --bundle SHA256SUMS.bundle \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/bjoshuanoah/porchlight/\.github/workflows/deploy\.yml@'

# 3. install from the verified file — the tarball carries its whole runtime closure,
#    so this works fully offline of the npm registry, from a local file
npm install -g ./porchlight-$PORCHLIGHT_VERSION.tgz

# the porchlight binary now runs from PATH
porchlight --version
```

### Option B — from source (run from your checkout)

The tarball method is the supported way to run the released hub. If you already have the code cloned and want the command from your checkout instead:

```bash
# 1. get the code
git clone https://github.com/bjoshuanoah/porchlight.git
cd porchlight

# 2. build from source
npm install
npm run build

# 3. register the binary from your checkout — `npm link` puts a `porchlight`
#    entry in your global bin directory pointing at packages/cli
(cd packages/cli && npm link)

# 4. verify the namespace
which porchlight && porchlight --version
```

To unregister a linked checkout later: `(cd packages/cli && npm unlink -g)`. If you installed from a tarball and later want the npm-registry version instead, uninstall first with `npm uninstall -g porchlight`, then run `npm install -g porchlight`.

## First run

Two commands bring the hub up; both are safe to re-run:

```bash
porchlight setup   # one-time prep: config, directories, Mongo + Redis + tunnel binaries
porchlight start   # starts the hub (databases, server, tunnel) and prints the hub URL
```

After `start`:

1. Open the printed hub URL on **any device** — the prompt works from a phone outside your home network, not just from the server machine.
2. Follow the bootstrap prompts: create the owner account (first and last name required) and name your first network; you become the network's owner in the same step.
3. From there, you are inside the hub: create members, issue invites, and set quotas in the owner settings.

If bootstrap is interrupted, it is resumable: run `porchlight bootstrap` again and it continues from the last completed step instead of starting over. Diagnostics at any time: `porchlight status`.

### A stable address for your hub

The first `porchlight start` works with no Cloudflare account at all: it mints a **temporary** address (`something.trycloudflare.com`) that works immediately but changes every restart. Any invite or join link shared under it stops resolving at the next boot.

To pin a permanent address you need a domain whose DNS lives on Cloudflare, then run one set of steps:

```bash
porchlight stop                                 # mint refuses to run while the hub is up
cloudflared tunnel login                        # one-time, browser auth
porchlight tunnel mint --hostname hub.example.com
porchlight start                                # same hostname on this boot and every boot after
```

- `mint` reuses the account's `porchlight` tunnel when one exists and creates it on first use; the credentials persist under your porchlight home, and every later `porchlight start` re-binds the same tunnel — the URL never churns again.
- One hostname serves the machine that runs the tunnel child. To move the hub to a new machine: `porchlight stop` on the old one, then set up the new machine and run the same `login` + `mint` steps there — `mint` reuses the same named tunnel and the hostname follows whichever machine runs it.
- `porchlight tunnel status` shows the stored identity and last bound URL; `porchlight tunnel reset` wipes it and the next `start` provisions anew (fresh mint, or fall back to the temporary address). Invite links minted under an earlier address must be re-shared after a hostname change.

### Command reference

| Command | What it does |
| --- | --- |
| `porchlight setup` | One-time bring-up prep (re-runnable; downloads nothing you must manage). |
| `porchlight start` | Start the hub process group (daemons, server, tunnel). |
| `porchlight stop` | Stop the hub process group. |
| `porchlight status` | Supervision, daemon, and bootstrap diagnostics (stays on your machine). |
| `porchlight bootstrap` | Drive remaining bootstrap steps over your hub URL (remote-friendly, resumable). |
| `porchlight service` | Install/uninstall auto-restart-on-boot supervision for the hub. |
| `porchlight tunnel` | Tunnel identity status; `mint [--hostname <host>]` and `reset` for a persistent address. |

## Updating

Updates are run by you, on your schedule:

```bash
npm install -g porchlight   # pulls the newer version (or repeat your release-tarball step)
porchlight stop
porchlight start
```

During the window between the install and the restart, the hub keeps serving the previous release — the restart applies the update. If the running release differs from the installed one, `porchlight start` and `porchlight status` say so loudly (`release update detected: ... — restart applies it`); a mixed state is never silent.

A failed install is covered by npm's own rollback semantics; your data directory is not touched by an update. If an updated release cannot start (the hub child fails to reach readiness or exits on every boot), the supervisor exhausts its automatic restart attempts after five consecutive failed starts and stops the whole process group into a **named fallback state**: `porchlight status` shows `hub fallback: crash-loop-fallback` with the diagnosis (the failing start's error and the hub log path) and the recovery line, and no half-running hub is left serving. Recovery is the documented previous-version reinstall:

```bash
npm install -g porchlight@<previous>   # the release that worked
porchlight stop
porchlight start
```

## Privacy, in one paragraph

Porchlight stores your content on your machine and serves it only to members you approve. It has no telemetry of any kind, and because the code is open source, you do not have to take that on faith: read the source or ask it from your own logs — everything it does stays local except the traffic you deliberately send through your own tunnel. Any member can export their complete authored history at any time.

## License

[MIT](LICENSE)