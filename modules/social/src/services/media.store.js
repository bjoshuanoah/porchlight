/**
 * Media blob store (PORCH-008). Content-addressed byte storage for the
 * media pipeline: the key IS the sha256 hex hash of the bytes, which makes
 * originals immutable-by-construction — a key exists only for the exact
 * bytes that first created it, and a second put of the same key must carry
 * the identical bytes or it is rejected.
 *
 * The store is injected into the media service (assembleSocialModule
 * wires a filesystem store for the hub runtime; tests use the memory
 * store). Both implementations expose the same four-operation contract:
 *   put(key, buffer) → key (throws E_BLOB_IMMUTABLE on a hash collision
 *     with different content), get(key) → Buffer (null when absent),
 *     has(key) → boolean, delete(key) → boolean.
 *
 * Keys are restricted to the safe charset the pipeline generates
 * ([A-Za-z0-9_-] plus at most one "/" segment per chunk key), so no path
 * traversal exists on the filesystem-backed store.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Valid blob key: hex content hash, or `upl_<id>/<index>` chunk keys. */
export function assertBlobKey(key) {
  if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) && !/^upl_[a-f0-9-]+\/\d+$/.test(key)) {
    throw new Error(`invalid media blob key: ${String(key).slice(0, 40)}`);
  }
  return key;
}

/** In-memory store: the deterministic substitute for tests and daemon-less runs. */
export function createMemoryMediaStore() {
  const blobs = new Map();
  return {
    async put(key, buffer) {
      assertBlobKey(key);
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const existing = blobs.get(key);
      if (existing) {
        if (!existing.equals(bytes)) {
          throw Object.assign(new Error("media blob key already holds different bytes (originals are immutable)"), {
            code: "E_BLOB_IMMUTABLE",
          });
        }
        return key;
      }
      blobs.set(key, bytes);
      return key;
    },
    async get(key) {
      assertBlobKey(key);
      return blobs.get(key) ?? null;
    },
    async has(key) {
      return blobs.has(key);
    },
    async delete(key) {
      return blobs.delete(key);
    },
  };
}

/**
 * Filesystem store: one file per blob under <root>/blobs/<first2>/<key>
 * for content hashes, <root>/chunks/<uploadId>/<index> for chunk keys.
 * First puts are create-only (the wx flag mirrors blob immutability); an
 * existing key whose bytes differ is an E_BLOB_IMMUTABLE error.
 */
export function createFileMediaStore(root) {
  const absolute = resolve(String(root));
  if (!isAbsolute(String(root))) {
    throw new Error("media store root must be an absolute path");
  }
  const pathFor = (key) =>
    assertBlobKey(key).startsWith("upl_")
      ? join(absolute, "chunks", ...key.replace("upl_", "").split("/", 2))
      : join(absolute, "blobs", key.slice(0, 2), key);

  return {
    async put(key, buffer) {
      assertBlobKey(key);
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const path = pathFor(key);
      mkdirSync(join(path, ".."), { recursive: true });
      if (statSync(path, { throwIfNoEntry: false })) {
        const existing = readFileSync(path);
        if (!existing.equals(bytes)) {
          throw Object.assign(new Error("media blob key already holds different bytes (originals are immutable)"), {
            code: "E_BLOB_IMMUTABLE",
          });
        }
        return key;
      }
      writeFileSync(path, bytes, { flag: "wx" });
      return key;
    },
    async get(key) {
      const stat = statSync(pathFor(key), { throwIfNoEntry: false });
      return stat ? readFileSync(pathFor(key)) : null;
    },
    async has(key) {
      return Boolean(statSync(pathFor(key), { throwIfNoEntry: false }));
    },
    async delete(key) {
      try {
        rmSync(pathFor(key));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
  };
}

/**
 * Disk probe over node:fs statfs — the hard-disk-guard input. Returns
 * { totalBytes, freeBytes } for the filesystem holding `path`; reads and
 * deletes never consult this probe, only new-upload admission does.
 */
export async function nodeDiskProbe(path) {
  const { statfs } = await import("node:fs/promises");
  const info = await statfs(String(path));
  return {
    totalBytes: Number(info.blocks) * Number(info.bsize),
    freeBytes: Number(info.bavail) * Number(info.bsize),
  };
}