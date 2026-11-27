# @porchlight/wyze — Porchlight vendor adapter: Wyze DTLS P2P (PORCH-131)

The Wyze DTLS P2P camera source producer: a contract-tested `CameraStreamSource`
adapter that talks the reverse-engineered Wyze P2P protocol directly —
reference: go2rtc's wyze module (URL scheme
`wyze://<ip>?uid=&enr=&mac=&model=&dtls=true`). It runs natively on the host
(the DTLS handshake breaks through containerized UDP paths — field-validated);
confirmed models of record: **Wyze Video Doorbell v2 (HL_DB2)** and
**Wyze Cam v3 (WYZE_CAKP2JFUS)** — the camera fleet is a deployment input.

## What this package owns

- **The wire protocol, in-repo.** The IOTC session0 layer (discovery on UDP
  32761, session bind, keep-alive, the "Charlie" datagram obfuscation), the
  DTLS-PSK handshake engine (pion-compatible flights, PSK derived from the
  ENR with the TUTK C-string truncation, the two suites of record:
  `TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256` (IANA 0xCCAC, the suite the
  camera of record negotiates) plus the plain-PSK CBC fallbacks), frame
  reassembly (the extended 40-byte FRAMEINFO trailer, per-channel
  multi-packet AV reassembly — a lost packet resets the frame instead of
  emitting corruption), and the AV control plane (AV login, the HL K-auth
  challenge K10000–K10003 keyed by the ENR status class, video/audio channel
  opens, the 100 ms ACK cadence).
- **One upstream connection per camera (the stream-manager law).** The
  `createWyzeStreamFactory` seam plugs into `@porchlight/stream`'s
  `StreamManager` opts.factory: `wyze://` cameras ride
  `WyzePumpHandle` (ONE session + ONE ffmpeg pump child fed over pipes;
  the manager's four lanes of record — mpegts copy/rgb/jpeg/pcm — are the
  exact byte destinations `buildStreamArgs` uses for url cameras), and every
  other camera falls through to the stream package's default factory.
  Camera drops re-open through the manager's backoff ladder (bounded
  reconnect storm, zero manual intervention).

## Dependencies of record

- **ffmpeg is spawned by the pump** for lane demuxing (hardware decode
  choices come from `@porchlight/hal`), never by the protocol layer.
- **No native DTLS dependency**: Node has no DTLS client; the engine speaks
  the handshake itself (the pion-compatible flights the reference client
  rides), exercised end to end against real `openssl` peers in the tests.

## The URL contract

```
wyze://<ip>[:32761]?uid=<P2PID>&enr=<ENR>&mac=<MAC>&model=<MODEL>&dtls=true[&subtype=hd|sd]
```

`enr` is the DTLS secret (the PSK derives from it), `mac` keys the discovery
auth code, `model` selects the resolution path (the 2K set includes the
confirmed models above), `subtype` picks HD/SD. The camera config of record
also carries the stream `width`/`height` (the manager refuses to demux a
camera without its frame dimensions — never a silent guess).

## Tests

- `test/contract.test.js` — byte-for-byte vectors against the reference
  (crypto, IOTC wire shapes, challenge responses), the DTLS handshake
  round-tripped over both suites, the CC51-refusal contract, the URL
  contract, and the full connect → DTLS → K-auth → channel opens → frames
  flow against the fake camera (test/helpers).
- `test/source.test.js` — the stream-manager factory seam + the pump's lane
  wiring with the ffmpeg child injected.
- `test/manager.test.js` — the adapter inside `StreamManager`: exactly one
  upstream connection with N consumers attached, byte-identical relay
  fan-out, and the lanes fanned in-process.
- **Live-camera e2e** (env-gated, needs a real deployment camera):
  `PORCHLIGHT_WYZE_LIVE=1 PORCHLIGHT_WYZE_URL="wyze://…&dtls=true" node --test test/live-camera.test.js`
  — the AC-2 contract suite asserted against the real camera fleet.
