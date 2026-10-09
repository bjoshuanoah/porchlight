// Hub HTTP helpers for the CLI: JSON over the tunnel first, local listener as
// fallback. Non-JSON responses (e.g. a tunnel edge block page) are treated as
// unreachable rather than parsed.
import { loadConfig } from "@porchlight/shared";
import { home } from "./state.mjs";

export function loadHomeConfig(args = {}) {
  const paths = home({ PORCHLIGHT_HOME: args.home ?? process.env.PORCHLIGHT_HOME });
  const config = loadConfig(paths.root);
  if (!config) throw new Error(`no runtime config at ${paths.root} — run \`porchlight setup\` first`);
  return { paths, config };
}

export function hubBases(config) {
  const local = `http://127.0.0.1:${config.hub.httpPort}`;
  const remote = config.hub.tunnel.url;
  return remote && remote !== local ? [remote, local] : [local];
}

export function hubUrl(config) {
  return config.hub.tunnel.url ?? `http://127.0.0.1:${config.hub.httpPort}`;
}

export async function hubJson(config, path, init = null) {
  const bases = hubBases(config);
  const failures = [];
  for (const base of bases) {
    try {
      const response = await fetch(new URL(path, base), init ?? {});
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) {
        failures.push(`${base}${path}: non-JSON response (HTTP ${response.status})`);
        continue;
      }
      const body = await response.json();
      return { status: response.status, body, base };
    } catch (error) {
      failures.push(`${base}${path}: ${error.message}`);
    }
  }
  throw new Error(`hub unreachable for ${path} — ${failures.join("; ")}`);
}