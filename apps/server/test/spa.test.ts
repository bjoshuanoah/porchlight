import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, createMemoryStore } from "@porchlight/shared";
import { createServer } from "../src/router.js";
import { BootstrapService } from "../src/services/bootstrap.service.js";

test("hub serves its bundled SPA and client routes without claiming API, discovery, bootstrap or missing assets", async (t) => {
  const webRoot = await mkdtemp(join(tmpdir(), "porchlight-spa-"));
  t.after(() => void rm(webRoot, { recursive: true, force: true }));
  await mkdir(join(webRoot, "assets"));
  const html = "<!doctype html><html><body>Porchlight bundled SPA</body></html>";
  await writeFile(join(webRoot, "index.html"), html);
  await writeFile(join(webRoot, "assets", "app.js"), "window.porchlightSpa = true;");

  const store = createMemoryStore();
  const app = createServer({
    store: null,
    readiness: null,
    config: DEFAULT_CONFIG,
    bootstrap: new BootstrapService(store, DEFAULT_CONFIG, webRoot),
    webRoot,
  });
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  for (const path of ["/", "/timeline", "/groups/family/posts/first", "/profile?tab=albums"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/, path);
    assert.equal(await response.text(), html, path);
  }

  const asset = await fetch(`${base}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /^(?:text|application)\/javascript/, "asset must serve as JavaScript, never the HTML fallback");
  assert.equal(await asset.text(), "window.porchlightSpa = true;");

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { service: string }).service, "porchlight-server");

  const bootstrap = await fetch(`${base}/bootstrap`);
  assert.equal(bootstrap.status, 200);
  assert.notEqual(await bootstrap.text(), html);

  for (const path of ["/api/no-such-route", "/.well-known/no-such-route", "/bootstrap/no-such-route", "/assets/no-such-file.js", "/favicon.ico"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.notEqual(await response.text(), html, path);
  }
});
