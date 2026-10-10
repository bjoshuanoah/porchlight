// Fallback-mode media blob cache (PORCH-044): feed reads arrive on a
// cadence, so the loader must answer a repeat request for the same
// content identity from memory — same object URL, no refetch, no
// revoke. The cache is a pure module: pinned as a contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mediaBlobKey,
  readMediaBlob,
  putMediaBlob,
  clearMediaBlobs,
  mediaBlobCount,
} from "../src/media-blob.js";

const identity = { origin: "http://hub.lan", mediaId: "med_1", kind: "original", version: null };
const blobA = Buffer.from("one");
const blobB = Buffer.from("two");

test("the same content identity answers from memory with the same object URL", () => {
  clearMediaBlobs();
  const key = mediaBlobKey(identity);
  const first = putMediaBlob(key, { url: "blob:url-1", blob: blobA, shape: { width: 1600, height: 1067 } });
  const hit = readMediaBlob(key);
  assert.equal(hit.url, first.url);
  assert.equal(hit.blob, blobA);
  assert.deepEqual(hit.shape, { width: 1600, height: 1067 });

  // The cadence-driven repeat (next render) neither refetches nor swaps
  // the URL: the media element never remounts.
  const again = readMediaBlob(key);
  assert.equal(again.url, first.url);
});

test("a different identity is a different entry — rendition upgrade gets its own URL", () => {
  clearMediaBlobs();
  const key = mediaBlobKey(identity);
  putMediaBlob(key, { url: "blob:url-1", blob: blobA });
  const sharper = mediaBlobKey({ ...identity, version: "cc".repeat(32) });
  putMediaBlob(sharper, { url: "blob:url-2", blob: blobB });
  assert.equal(readMediaBlob(key).url, "blob:url-1");
  assert.equal(readMediaBlob(sharper).url, "blob:url-2");
});

test("replacing an identity revokes only the replaced URL", () => {
  clearMediaBlobs();
  const key = mediaBlobKey(identity);
  const revoked = [];
  const originalRevoke = globalThis.URL.revokeObjectURL;
  globalThis.URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    putMediaBlob(key, { url: "blob:url-1", blob: blobA });
    putMediaBlob(key, { url: "blob:url-2", blob: blobB });
    assert.deepEqual(revoked, ["blob:url-1"], "the old URL dies; the new one lives");
    assert.equal(readMediaBlob(key).url, "blob:url-2");
  } finally {
    globalThis.URL.revokeObjectURL = originalRevoke;
  }
  clearMediaBlobs();
});

test("the cache stays bounded without evicting on-screen-fresh media", () => {
  clearMediaBlobs();
  for (let index = 0; index < 220; index += 1) {
    putMediaBlob(mediaBlobKey({ origin: "https://hub", mediaId: `med_${index}`, kind: "feed-thumb", version: `${index}` }), {
      url: `blob:${index}`,
      blob: Buffer.from(String(index)),
    });
  }
  assert.equal(mediaBlobCount(), 220, "fresh entries are never evicted — every current URL serves");
  // Age one entry past the eviction window, then push another: that entry
  // is the one the cache trades away.
  const staleKey = mediaBlobKey({ origin: "https://hub", mediaId: "med_0", kind: "feed-thumb", version: "0" });
  readMediaBlob(staleKey).at = Date.now() - 10 * 60 * 1000;
  putMediaBlob(mediaBlobKey({ origin: "https://hub", mediaId: "med_newcomer", kind: "feed-thumb", version: "n" }), {
    url: "blob:newcomer",
    blob: blobA,
  });
  assert.equal(readMediaBlob(staleKey), null, "the stale tail is collectible");
  assert.equal(readMediaBlob("https://hub|med_1|feed-thumb|1").url, "blob:1");
  clearMediaBlobs();
});