import { opaqueToken } from "../util/crypto.js";
import { socialModels } from "../models.js";

function typedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/** Plain-language storage-quota failure for member clients. */
export const QUOTA_PLAIN_MESSAGE =
  "This network is full: the owner has set a storage limit and it has been reached. Free up space or ask the owner to raise the limit.";

/**
 * Quota and retention service (PORCH-005, day-one primitive). The hub-owner
 * limits rule is quantity-only: storage ceilings and retention windows,
 * owner-set per network, enforced at upload admission and by the retention
 * sweep. The service never exposes a path into member content — it counts
 * bytes and evicts expired artifact rows; it does not reach into access.
 *
 * Artifacts are the quota-owned usage record: one row per stored original or
 * rendition, written by the media/content path through recordArtifact.
 * Used bytes = sum of live artifact rows (deterministic, no rollup drift).
 */
export class QuotaService {
  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.artifacts
   * @param {import("@porchlight/shared").CollectionLike} deps.networks
   * @param {(action: string, detail?: object) => void} [deps.audit]
   */
  constructor({ artifacts, networks, audit }) {
    this.artifacts = artifacts;
    this.networks = networks;
    this.audit = audit ?? (async () => {});
    this.models = socialModels;
  }

  /** Network storage limits; null ceiling or retention = unset and reported. */
  async limits({ networkId }) {
    const network = await this.networks.findOne({ _id: networkId });
    if (!network) {
      throw typedError("E_NETWORK_NOT_FOUND", `network ${networkId} not found`);
    }
    return this.normalize(network.quota ?? {});
  }

  /**
   * Owner sets the quantity-only limits for a network. Values replace the
   * previous config entirely: null clears a limit (unset), numbers set it.
   */
  async setLimits({ networkId, storageCeilingMb, retentionDays }) {
    const next = this.normalize({ storageCeilingMb, retentionDays });
    assertPositiveOrNull(storageCeilingMb, "storageCeilingMb");
    assertPositiveOrNull(retentionDays, "retentionDays");
    const network = await this.networks.findOne({ _id: networkId });
    if (!network) {
      throw typedError("E_NETWORK_NOT_FOUND", `network ${networkId} not found`);
    }
    await this.networks.updateOne({ _id: networkId }, { $set: { quota: next } });
    return { networkId, quota: next };
  }

  /** Live usage rollup for a network: bytes used against the ceiling. */
  async usage({ networkId }) {
    const rows = await this.artifacts.find({ networkId: String(networkId) });
    const usedBytes = rows.reduce((total, row) => total + (row.bytes ?? 0), 0);
    return { networkId, usedBytes, ceilingMb: null, quota: null };
  }

  /**
   * Upload admission (the enforcement point the media pipeline calls before
   * storing anything). Rejects over-ceiling requests with the plain-language
   * message members see; unset ceilings admit and always report as unset.
   */
  async admitUpload({ networkId, bytes, kind = "original" } = {}) {
    assertByteCount(bytes);
    const network = await this.networks.findOne({ _id: networkId });
    if (!network) {
      throw typedError("E_NETWORK_NOT_FOUND", `network ${networkId} not found`);
    }
    const quota = this.normalize(network.quota ?? {});
    const rows = await this.artifacts.find({ networkId: String(networkId) });
    const usedBytes = rows.reduce((total, row) => total + (row.bytes ?? 0), 0);
    if (quota.storageCeilingMb !== null && usedBytes + bytes > quota.storageCeilingMb * 1024 * 1024) {
      const error = typedError("E_STORAGE_QUOTA_EXCEEDED", QUOTA_PLAIN_MESSAGE, {
        usedBytes,
        ceilingMb: quota.storageCeilingMb,
      });
      throw error;
    }
    void kind;
    return {
      admitted: true,
      usedBytes: usedBytes + bytes,
      ceilingMb: quota.storageCeilingMb,
      unset: quota.storageCeilingMb === null,
    };
  }

  /**
   * Record a stored artifact (original or rendition) in the usage ledger:
   * uploads, renditions, and derived artifacts all count against the same
   * quota (quantity-only rule). Retention-days-expired rows get an
   * expiresAt so the sweep can find them; null never expires.
   */
  async recordArtifact({ networkId, kind, bytes, retentionDays = null, sourceId = null, now = () => new Date() } = {}) {
    assertByteCount(bytes);
    if (kind !== "original" && kind !== "rendition") {
      throw typedError("E_ARTIFACT_KIND_REQUIRED", "artifact kind must be original or rendition");
    }
    const createdAt = now().toISOString();
    const expiresAt =
      retentionDays !== null && Number(retentionDays) >= 1
        ? isoPlus(now(), Number(retentionDays) * 24 * 60 * 60)
        : null;
    const artifact = {
      _id: `art_${opaqueToken().slice(0, 12)}`,
      networkId: String(networkId),
      kind,
      bytes,
      sourceId,
      createdAt,
      expiresAt,
    };
    await this.artifacts.insertOne(artifact);
    await this.audit("upload", { networkId: String(networkId), detail: { artifactId: artifact._id, kind, bytes } });
    return artifact;
  }

  /**
   * Remove the artifact rows keyed to one source id (PORCH-044: a rendition
   * regenerated to the current format leaves its old ledger rows behind —
   * the usage ledger counts live renditions only). Returns the removed
   * count/bytes; idempotent when nothing is keyed to the source.
   */
  async removeArtifact(sourceId, { networkId = null } = {}) {
    if (sourceId == null) return { removedRows: 0, removedBytes: 0 };
    const rows = await this.artifacts.find(networkId ? { networkId, sourceId } : { sourceId });
    for (const row of rows) {
      await this.artifacts.deleteOne({ _id: row._id });
    }
    return { removedRows: rows.length, removedBytes: rows.reduce((total, row) => total + row.bytes, 0) };
  }

  /**
   * Artifacts whose retention window has closed at `now`. The OWNER-SET
   * window is a setting, not a per-row snapshot: every live artifact row's
   * effective expiry is evaluated against the network's CURRENT
   * retentionDays, so the next retention pass enforces the window the owner
   * just set (tightening sweeps rows recorded under the old window;
   * widening preserves rows not yet expired). With the window unset, a
   * stamped expiresAt (recorded while a window existed) still stands —
   * clearing the window never resurrects rows already past it — and with
   * neither stamp nor window nothing expires.
   */
  async expiredArtifactRows({ networkId, now = () => new Date() } = {}) {
    const network = await this.networks.findOne({ _id: networkId });
    const retentionDays = network ? this.normalize(network.quota ?? {}).retentionDays : null;
    const rows = await this.artifacts.find({ networkId: String(networkId) });
    const cutoff = now().toISOString();
    return rows.filter((row) => {
      const expiry = this.#expiryAt(row, retentionDays);
      return expiry !== null && expiry !== undefined && expiry <= cutoff;
    });
  }

  /** Effective expiry of one artifact row under a retention window in days. */
  #expiryAt(row, retentionDays) {
    if (retentionDays !== null && Number(retentionDays) >= 1) {
      const created = row.createdAt ? new Date(row.createdAt).getTime() : NaN;
      if (Number.isFinite(created)) {
        return isoPlus(new Date(created), Number(retentionDays) * 24 * 60 * 60);
      }
    }
    return row.expiresAt ?? null;
  }

  /**
   * Retention sweep: remove artifact rows past their retention window and
   * report what left. Reads continue at every threshold; this is the delete
   * path and it audits as a deletion event.
   */
  async sweep({ networkId, now = () => new Date() } = {}) {
    const expired = await this.expiredArtifactRows({ networkId, now });
    const cutoff = now().toISOString();
    let bytesFreed = 0;
    for (const row of expired) {
      await this.artifacts.deleteOne({ _id: row._id });
      bytesFreed += row.bytes ?? 0;
    }
    const removedRows = expired.map((row) => row._id);
    if (expired.length > 0) {
      await this.audit("retention_delete", {
        networkId: String(networkId),
        detail: { removed: expired.length, bytesFreed, removedRows },
      });
    }
    return { swept: expired.length, bytesFreed, at: cutoff };
  }

  /** Fill in unset pieces against the owner-visible unset-and-reported rule. */
  normalize(quota) {
    const resolved = quota ?? {};
    const storage = resolved.storageCeilingMb ?? null;
    const retention = resolved.retentionDays ?? null;
    return { storageCeilingMb: storage === null ? null : Number(storage), retentionDays: retention === null ? null : Number(retention) };
  }
}

function assertByteCount(bytes) {
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw typedError("E_BYTES_REQUIRED", "the upload size in bytes is required to check storage limits");
  }
}

function assertPositiveOrNull(value, name) {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(Number(value)) || Number(value) < 1) {
    throw typedError(
      "E_INVALID_QUOTA",
      `config quota.${name} must be null (unset) or an integer >= 1`,
    );
  }
}

function isoPlus(date, seconds) {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

export default QuotaService;