# Local Network bootstrap — the tccutil/MDM path, documented (PORCH-134)

## The field finding

> An unapproved process **silently loses UDP LAN traffic**: no error
> surfaces anywhere — recordings, detections, and discovery just miss.

Since macOS 15 this is not an accident: it is local network privacy
(TN3179). The system drops local network operations from processes whose
Local Network privilege is undetermined or denied, **without logging an
error to the process**. UDP operations that require the privilege include
sending unicast and multicast, connecting a UDP socket, and receiving
multicast/broadcast — i.e., exactly what camera discovery and vendor
adapters do.

## The facts of record (Apple TN3179 + Apple DTS)

| Path                                    | Works for Local Network? |
| --------------------------------------- | ------------------------ |
| `launchd` **daemon** (system domain)    | **Yes — automatically allowed.** "Any daemon started by `launchd`" and "any program running as root" are automatically allowed (TN3179 § macOS considerations). |
| `launchd` agent (GUI domain)            | **No.** The daemon exemption explicitly does not apply to agents. This is the silent-UDP-loss shape. |
| MDM TCC configuration profile           | **No.** "Device managers aren't able to configure local network privacy using MDM" (TN3179); the TCC payload does not support Local Network (Apple DTS, forums #759955). |
| `tccutil reset LocalNetwork <bundle>`   | **No.** The Local Network privilege is not resettable through tccutil (forums #757949). |
| System Settings → Privacy & Security → Local Network | Yes — user-managed toggle (macOS 27.2+ has add/remove buttons). |
| Site-admin allowlist defaults           | Yes — `Allowed{Ethernet,WiFi}LocalNetworkAddresses` in the `com.apple.network.local-network` domain (macOS 15.5+, `sudo defaults write`, **restart required**). Treats the listed networks as non-local for every program. |

Sources: [TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy),
[Apple DTS on the TCC payload](https://developer.apple.com/forums/thread/759955),
[tccutil reset LocalNetwork](https://developer.apple.com/forums/thread/757949).

## What Porchlight Home does with those facts

1. **The engine services run as system-domain LaunchDaemons** — where the
   exemption lives. Boot-time autostart on a headless Mac (no GUI session
   exists) is also only possible from this domain. The first-run bootstrap
   writes `/Library/LaunchDaemons/com.porchlight.home.plist` and registers
   it with `launchctl bootstrap system`.
2. **Anything we later ship that must live in a user session** (e.g. an
   agent-shaped helper) either gets a responsible-code path (`NSLocalNetworkUsageDescription`
   + first-use prompt, confirmed once in System Settings) or rides the
   daemon exemption. It never pretends MDM or tccutil can pre-grant or
   reset Local Network — `src/tcc.js` refuses the `LocalNetwork` reset
   command outright with this explanation.
3. **Site-admin fallback** for constrained fleets (adapter processes that
   must run in a session):

   ```sh
   sudo defaults write com.apple.network.local-network \
     AllowedEthernetLocalNetworkAddresses -array "192.168.0.0/24"
   sudo defaults write com.apple.network.local-network \
     AllowedWiFiLocalNetworkAddresses -array "192.168.0.0/24"
   # restart required — the change applies system-wide at next boot
   ```

   Validate any CIDR first; `siteAdminAllowCommands()` in `src/tcc.js`
   emits validated commands.

## Making the silent loss observable

`porchlight-home verify-network` sends one SSDP M-SEARCH (UDP multicast to
239.255.255.250:1900 — a Local-Network-regulated operation per TN3179) and
counts unicast replies within the window:

- replies > 0 → UDP multicast send works on this network.
- replies == 0 → undetermined: could be an empty segment, **or** the silent
  block. The output names the checks: System Settings toggle, or run the
  process as a launchd daemon.

The probe is a tripwire, not a verdict — it never claims more than the
evidence supports.
