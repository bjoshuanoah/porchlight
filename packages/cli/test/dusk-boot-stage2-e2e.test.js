// PORCH-119 stage 2 — deployed-hub shape, per the Oct 12 verification
// contract: real daemons (mongo/redis binaries from `porchlight setup`),
// real hub process (the built apps/server boot the supervisor spawns),
// real static SPA serving, real HTTP. The dusk boot's delivered surface,
// exercised as a family member's browser meets it on a deployed hub:
//   GET  /                        (the pre-JS porch-boot canvas: dusk scene)
//   GET  /loader.webp             (the animated asset of record)
//   GET  /loader-still.webp       (the reduced-motion first frame)
//   GET  /assets/index-*.js       (the bundle: the React boot layer + tokens)
//   GET  /api/health              (the hub the boot scene verifies against)
// Run: npm run build && PORCHLIGHT_S2=1 node --test test/dusk-boot-stage2-e2e.test.js
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const BIN = fileURLToPath(new URL("../bin/porchlight.mjs", import.meta.url));

function runStep(name, promise) {
  return promise.then(
    (value) => { console.log(`✓ ${name}`); return value; },
    (error) => { console.error(`✗ ${name}`); console.error(error && (error.message ?? error)); throw error; });
}

const execFileP = (file, args, opts) => new Promise((resolve, reject) =>
  execFile(file, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr }))));

async function waitHealthy(base, timeoutMs = 90_000) {
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`hub not healthy: ${base}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return res.json();
    } catch { /* retry */ }
    await new Promise((wait) => setTimeout(wait, 500));
  }
}

test("dusk boot, deployed-hub stage 2: the loading surface serves the porch-light-at-dusk scene", { skip: process.env.PORCHLIGHT_S2 === "1" ? false : "runs only with PORCHLIGHT_S2=1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "porch119-s2-"));
  const keep = process.env.PORCHLIGHT_S2_KEEP === "1";
  let hub = null;
  try {
    console.log("stage-2 home:", home);
    await runStep("porchlight setup (real daemons downloaded)", execFileP(process.execPath, [BIN, "setup", "--home", home]));

    const seed = 10_000 + (process.pid % 20_000) * 3;
    const httpPort = 20_000 + (seed % 20_000);
    await execFileP(process.execPath, ["-e", `
      const { loadConfig, saveConfig } = await import("@porchlight/shared");
      const config = loadConfig(${JSON.stringify(home)});
      config.daemons.mongoPort = ${30_000 + (seed % 20_000)};
      config.daemons.redisPort = ${30_000 + (seed % 20_000) + 1};
      config.hub.httpPort = ${httpPort};
      saveConfig(${JSON.stringify(home)}, config);
    `], { cwd: process.cwd() });
    const base = `http://127.0.1:${httpPort}`.replace("127.0.1", "127.0.0.1");

    hub = spawn(process.execPath, [BIN, "start", "--foreground", "--no-tunnel", "--home", home], { stdio: ["ignore", "pipe", "pipe"] });
    hub.stdout.on("data", (c) => process.env.PORCHLIGHT_S2_VERBOSE && process.stdout.write(`[hub] ${c}`));
    hub.stderr.on("data", (c) => process.env.PORCHLIGHT_S2_VERBOSE && process.stderr.write(`[hub!] ${c}`));

    await runStep("hub healthy", waitHealthy(base));

    // The served first paint: navy, static app icon, lowercase wordmark,
    // layered lighting, polite announcement, and fixed-height status.
    const page = await runStep("GET /", (async () => {
      const res = await fetch(base);
      assert.equal(res.status, 200, `the SPA shell serves (${res.status})`);
      const html = await res.text();
      assert.match(html, /id="porch-boot"/, "the pre-JS boot canvas serves");
      const boot = html.slice(html.indexOf('id="porch-boot"'), html.indexOf('id="root"'));
      assert.match(boot, /var\(--porch-boot-bg,#0B1622\)/, "deep navy from the boot token");
      assert.match(boot, /class="porch-dusk-halo"/, "the halo layer serves pre-JS");
      assert.match(boot, /class="porch-dusk-glow"/, "the floor-glow layer serves pre-JS");
      assert.match(boot, /class="porch-dusk-particle"/, "the particle layer serves pre-JS");
      assert.match(boot, /class="porch-dusk-mark" src="\/icon-512\.png"/, "the actual still Porchlight icon serves");
      assert.match(boot, />porchlight</, "the wordmark is lowercase on this surface");
      assert.match(boot, /<span class="porch95-announce">Porchlight is loading<\/span>/, "the polite announcement serves");
      assert.match(boot, /class="porch95-statusbox" aria-hidden="true"/, "the fixed-height status box serves");
      assert.match(html, /@keyframes porch-dusk-orbit/, "the orbit keyframes serve with the canvas");
      return html;
    })());

    // The original icon must load as a PNG on the deployed hub.
    await runStep("GET /icon-512.png", (async () => {
      const res = await fetch(base + "/icon-512.png");
      assert.equal(res.status, 200, "the boot icon serves");
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "the boot icon is a PNG");
    })());

    // The bundle: the React boot layer rides the same dusk contract, with
    // the scene paint on the boot tokens (screens carry no literal color).
    await runStep("GET bundle", (async () => {
      const assets = [...page.matchAll(/src="(\/assets\/index-[^"]+\.js)"/g)].map((m) => m[1]);
      assert.ok(assets.length, "the index bundle is referenced");
      const res = await fetch(base + assets[0]);
      assert.equal(res.status, 200, `the bundle serves (${res.status})`);
      const js = await res.text();
      assert.match(js, /porch-boot-dusk-halo/, "the React layer consumes the dusk halo token");
      assert.match(js, /porch-boot-dusk-mote/, "the React layer consumes the particle token");
      assert.match(js, /lighting the porch…/, "the ruled rotation ships");
      assert.match(js, /knocking on the front door…/, "the ruled rotation ships in order");
      assert.match(js, /A family server is unreachable\. Saved moments may be out of date\./, "the failure copy ships verbatim");
      assert.match(js, /swapStatusLine|porch95-status-on/, "the crossfade writer ships");
      assert.doesNotMatch(js, /lottie|gsap|framer-motion/i, "no animation runtime rides the bundle");
    })());

    // The hub the scene verifies with: health stays reachable over the same
    // surface the boot canvas serves from.
    await runStep("GET /api/health", (async () => {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body && typeof body === "object", "the health surface answers");
    })());

    console.log("✓ dusk boot served by the deployed hub");
  } finally {
    if (hub && !hub.killed) hub.kill("SIGTERM");
    if (!keep) await rm(home, { recursive: true, force: true });
  }
});