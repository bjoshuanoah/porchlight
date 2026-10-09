// Node preload for the egress capture (PORCH-015 ac-1). Loaded via
// NODE_OPTIONS="--require .../egress-preload.mjs": patches the outbound
// primitives (global fetch, http/https requests, net/tls sockets) of every
// node process in the hub tree and appends one JSON line per outbound
// connection ATTEMPT — HOSTNAME-level, app-level by construction — to
// $PORCHLIGHT_EGRESS_LOG. OS-layer traffic never appears: it is not node
// application code. Child processes inherit NODE_OPTIONS automatically.
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const log = process.env.PORCHLIGHT_EGRESS_LOG;
if (!log) throw new Error("PORCHLIGHT_EGRESS_LOG must be set for the egress preload");
function record(host, port, what) {
  try {
    appendFileSync(log, JSON.stringify({ pid: process.pid, host, port: port ?? null, what, at: new Date().toISOString() }) + "\n");
  } catch { /* capture must never break the hub */ }
}

// Node's http(s).get delegates through the module's own request internally,
// so patching `request` covers both. All hub app code uses global fetch.
for (const mod of [http, https]) {
  const originalRequest = mod.request;
  mod.request = function patchedRequest(...callArgs) {
    try {
      const first = callArgs[0];
      const options = typeof first === "string" || first instanceof URL ? new URL(String(first)) : first;
      record(options?.hostname ?? options?.host ?? "", options?.port ?? null, "request");
    } catch { record(String(callArgs[0]), null, "request(unparsed)"); }
    return originalRequest.apply(this, callArgs);
  };
}

function recordConnect(name, args) {
  const first = args[0];
  if (first && typeof first === "object" && !first.path) record(first.host ?? first.servername ?? "", first.port, `${name}.connect`);
  else if (typeof first === "string" && !first.includes("/") && !first.startsWith(".")) record(first, args[1]?.port ?? args[1], `${name}.connect`);
}

for (const mod of [net, tls]) {
  const originalConnect = mod.connect;
  mod.connect = function patchedConnect(...callArgs) {
    recordConnect(mod === net ? "net" : "tls", callArgs);
    return originalConnect.apply(this, callArgs);
  };
}