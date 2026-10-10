/**
 * Media volume readiness service (PORCH-054, Porchlight Server TS 5 —
 * "Configurable media root and volume readiness", Brian Oct 14, 2026).
 *
 * The media root is runtime configuration set at hub setup (default: the
 * hub's data directory) and editable later from the owner console. The
 * root is any mounted POSIX path the family operates — internal volume,
 * DAS, or a NAS mount — the application never distinguishes protocols.
 *
 * Five named checks run before media services start (a configuration that
 * has never served this volume — no history marker) and at every console
 * edit; any failed check refuses with the check's reason named while
 * auth, timelines, and chat stay alive:
 *   1. volume-not-ready          — the path is not a live mounted directory.
 *   2. not-writable              — verified by read-back; a read-only
 *                                  remount or wrong permissions is refused.
 *   3. capacity-not-sane         — statfs absurdly small or near-full volume.
 *   4. filesystem-type-rejected  — FAT32/exFAT (4GB cap, no POSIX perms);
 *                                  cloud impersonation mounts are flagged
 *                                  to the owner (admitted, plainly named).
 *   5. boot-disk-masquerade      — a mount-point-shaped path ( /Volumes,
 *                                  /mnt, /media class) resolving to the
 *                                  system device: the silent-split killer
 *                                  where the share never mounted and the
 *                                  OS left an empty local folder. The
 *                                  default data-directory root stays legal.
 *
 * A root the hub has served before (history marker) entering the not-ready
 * state is a FIRST-CLASS state, not a failure: media ingest and serving
 * pause ready-and-waiting with the state named in the console and health
 * surface, and a short-interval poll [Assumed: 10s, build confirm] resumes
 * media the moment the volume mounts — poll-and-recover, never
 * refuse-and-restart. There is never a silent fallback: writes fail and
 * pause with the state named, never redirect to another location.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Named checks (the exact vocabulary the console and health surface use). */
export const VOLUME_CHECK = {
  NOT_READY: "volume-not-ready",
  NOT_WRITABLE: "not-writable",
  CAPACITY_NOT_SANE: "capacity-not-sane",
  FS_TYPE_REJECTED: "filesystem-type-rejected",
  FS_TYPE_FLAGGED: "filesystem-type-flagged",
  BOOT_DISK_MASQUERADE: "boot-disk-masquerade",
};

const STATE = {
  READY: "ready",
  NOT_READY: "volume-not-ready",
  STARTUP_REFUSED: "startup-refused",
};

/** Capacity-sanity floor [build-tuned]: an archive volume smaller than this
 *  is not a sane home for a family archive at hub scale (2–50 members). */
const MIN_VOLUME_BYTES = 256 * 1024 * 1024;
/** Capacity sanity shares the disk guard's hard threshold: near-full refuses. */
const MAX_USED_RATIO = 0.95;

/** The mount-point shapes the masquerade check refuses on the boot device. */
const MOUNT_POINT_SHAPES = [/^\/Volumes\//, /^\/mnt\//, /^\/media\//];

/**
 * The default OS-backed filesystem inspector. Returns for one path:
 *   { exists (boolean, live mounted directory), statfsInfo | null,
 *     fsType (string | null — real type when the platform exposes it),
 *     bootDevice (the system device id), sameDeviceAsBoot (boolean) }
 * and performs the write probe family. Linux reads the statfs type magic
 * (FAT 0x4d44, exFAT 0x2011bab0); darwin's f_type is opaque, so the real
 * type comes from `mount` output, and cloud impersonation mounts show as
 * the ~/Library/CloudStorage locations. Tests inject their own inspector.
 */
function defaultFs() {
  const statfsInfo = async (path) => {
    const { statfs } = await import("node:fs/promises");
    const info = await statfs(String(path));
    return {
      totalBytes: Number(info.blocks) * Number(info.bsize),
      freeBytes: Number(info.bavail) * Number(info.bsize),
      type: Number(info.type),
    };
  };
  const magicRejections = new Set([0x4d44, Number(0x2011bab0)]); // FAT32, exFAT
  return {
    async inspect(path) {
      let entry = null;
      try {
        entry = statSync(path, { throwIfNoEntry: false });
      } catch {
        entry = null;
      }
      const exists = Boolean(entry && entry.isDirectory());
      let bootDevice = null;
      try {
        bootDevice = statSync("/").dev;
      } catch {
        bootDevice = null;
      }
      const sameDeviceAsBoot = exists && bootDevice != null && entry.dev === bootDevice;
      let fsType = null;
      let info = null;
      try {
        info = await statfsInfo(path);
        if (process.platform === "linux") {
          fsType = magicRejections.has(info.type) ? (info.type === 0x4d44 ? "fat" : "exfat") : String(info.type);
        }
      } catch {
        fsType = null;
      }
      // darwin: `mount` names the real filesystem type per mount point.
      if (process.platform === "darwin" && exists) {
        try {
          const { execFileSync } = await import("node:child_process");
          const out = execFileSync("mount", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
          const line = out.split("\n").find((row) => row.startsWith(`${path} `) || row.includes(` on ${path} `));
          if (line) {
            const after = line.slice(line.lastIndexOf("(") + 1, line.lastIndexOf(")")).split(",");
            const first = (after[0] ?? "").trim().toLowerCase();
            if (first) fsType = first;
          }
        } catch {
          fsType = fsType ?? null;
        }
      }
      return { exists, statfsInfo: info, fsType, bootDevice, sameDeviceAsBoot, cloudMount: isCloudStoragePath(path) };
    },
    /** Writable probe: write → read back → compare → delete (the read-back contract). */
    async probeWrite(path) {
      const probeName = `.porchlight-write-probe-${randomBytes(6).toString("hex")}`;
      const probePath = join(path, probeName);
      try {
        const bytes = Buffer.from(probeName);
        writeFileSync(probePath, bytes, { flag: "wx" });
        const read = readFileSync(probePath);
        if (!read.equals(bytes)) {
          return { writable: false, reason: "A probe write did not read back identical from the volume." };
        }
        return { writable: true };
      } catch (error) {
        return {
          writable: false,
          reason:
            error.code === "EROFS"
              ? "The volume is mounted read-only."
              : error.code === "EACCES" || error.code === "EPERM"
                ? "The volume's permissions refuse writes to the hub."
                : `A probe write failed (${error.code ?? "unknown error"}).`,
        };
      } finally {
        try {
          const { rmSync } = await import("node:fs");
          rmSync(probePath, { force: true });
        } catch {
          /* the probe file dies with the volume when it cannot be removed */
        }
      }
    },
    statfsInfo,
    mkdir(path) {
      mkdirSync(path, { recursive: true });
    },
  };
}

/** darwin cloud impersonation mounts live under ~/Library/CloudStorage. */
function isCloudStoragePath(path) {
  try {
    return process.platform === "darwin" && String(path).includes("/Library/CloudStorage/");
  } catch {
    return false;
  }
}

function markerId(root) {
  return createHash("sha256").update(String(root)).digest("hex");
}

/**
 * The volume's readiness state machine. Owned by the social module (the
 * media pipeline's domain); apps/server injects the current configured
 * root, the store facade it can re-point, and the persist callback that
 * lands the change in the hub's runtime config file — the config file
 * stays the single source of truth.
 */
export class MediaVolumeService {
  /** The poll timer handle while a paused root waits for recovery. */
  #pollHandle = null;

  /**
   * @param {object} deps
   * @param {import("@porchlight/shared").CollectionLike} deps.markers
   *   The served-root history markers (the "has the hub served this volume
   *   before?" record that distinguishes ready-and-waiting from refusal).
   * @param {import("@porchlight/shared").CollectionLike} deps.uploads
   * @param {{ root: string | null, relocate: (root: string | null) => void,
   *           put: Function, get: Function, has: Function, delete: Function }} deps.blobs
   *   The relocatable store facade (or a test-injected store).
   * @param {object} options
   * @param {string | null} options.root The current configured root.
   * @param {boolean} [options.rootIsDefault] The default data-directory root
   *   is auto-created and stays legal (masquerade wording).
   * @param {((root: string) => void) | null} [options.persistRoot] Hub config
   *   persistence callback (injected by apps/server).
   * @param {number} [options.pollIntervalMs] [Assumed: 10s] readiness poll.
   * @param {object} [options.fs] The filesystem inspector (tests inject).
   * @param {{ setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (id: unknown) => void }} [options.timer]
   *   The poll timer seam (tests drive ticks manually).
   * @param {boolean} [options.relocatable] False when a non-filesystem store
   *   was injected (console edits then refuse, they cannot re-point bytes).
   */
  constructor({ markers, uploads, blobs }, options = {}) {
    this.markers = markers;
    this.uploads = uploads;
    this.blobs = blobs;
    this.root = options.root ?? null;
    this.rootIsDefault = options.rootIsDefault ?? false;
    this.persistRoot = options.persistRoot ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.fs = options.fs ?? defaultFs();
    this.timer = options.timer ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
    // A non-relocatable deployment (injected non-filesystem store) carries
    // no volume states: the memory plane cannot fail a readiness check.
    this.relocatable = options.relocatable ?? false;
    this.state = {
      state: this.root ? "starting" : STATE.READY,
      check: null,
      reason: null,
      flag: null,
      since: this.root ? new Date().toISOString() : null,
    };
    this.#pollHandle = null;
    /** The startup gate settles exactly once; surfaces await this promise. */
    this.gatePromise = this.root ? (options.startupGate !== false ? this.#runStartupGate() : Promise.resolve()) : Promise.resolve();
  }

  /**
   * The startup gate (ac-2). A configuration that has never served this
   * volume runs the five named checks; a failed check refuses media
   * startup with the reason named (the media service surfaces the refusal;
   * everything else in the module is untouched — auth, timelines, chat).
   * A KNOWN-GOOD root that is merely not mounted pauses ready-and-waiting
   * and the poll resumes it (poll-and-recover, never refuse-and-restart).
   */
  async #runStartupGate() {
    // The default data-directory root is the legitimate local install —
    // the hub creates it on first boot (a fresh install has no media
    // directory yet). An owner-configured external root is never created
    // implicitly: creating it under an unmounted mountpoint would mint
    // exactly the masquerade folder the five checks exist to catch.
    if (this.rootIsDefault) {
      const inspect = await this.fs.inspect(this.root);
      if (!inspect.exists) {
        try {
          this.fs.mkdir(this.root);
        } catch (error) {
          this.#settle(STATE.STARTUP_REFUSED, {
            check: VOLUME_CHECK.NOT_READY,
            reason: `The default media root ${this.root} could not be created (${error.code ?? "unknown error"}).`,
          });
          return;
        }
      }
    }
    const marker = await this.#knownGoodMarker(this.root);
    const check = await this.check(this.root);
    if (check.ok) {
      await this.#markServed(this.root);
      this.#settle(STATE.READY, { flag: check.flag });
      return;
    }
    if (check.check === VOLUME_CHECK.NOT_READY && marker) {
      this.#settle(STATE.NOT_READY, { check: check.check, reason: check.reason });
      this.#schedulePoll();
      return;
    }
    this.#settle(STATE.STARTUP_REFUSED, { check: check.check, reason: check.reason });
  }

  /**
   * The five named checks (ac-2, verbatim vocabulary). Returns
   * { ok: true, flag } when the volume may serve, or
   * { ok: false, check, reason } — the exact refusal the console named.
   * A cloud-filesystem impersonation mount is flagged, never refused.
   */
  async check(root) {
    const inspect = await this.fs.inspect(root);
    if (!inspect.exists) {
      return {
        ok: false,
        check: VOLUME_CHECK.NOT_READY,
        reason: `The media root ${root} is not a live mounted directory (volume not ready).`,
      };
    }
    // (5) Boot-disk masquerade: before trusting the directory, refuse a
    // mount-point-shaped path that resolves to the system device — the
    // empty local folder left under the mountpoint where the share never
    // mounted. The default data-directory root stays legal: it does not
    // carry the mount-point shape.
    if (inspect.sameDeviceAsBoot && MOUNT_POINT_SHAPES.some((shape) => shape.test(String(root)))) {
      return {
        ok: false,
        check: VOLUME_CHECK.BOOT_DISK_MASQUERADE,
        reason: `${root} resolves to the system device but is shaped like a network mount point — the share never mounted and an empty local folder stands in its place.`,
      };
    }
    const probe = await this.fs.probeWrite(root);
    if (!probe.writable) {
      return {
        ok: false,
        check: VOLUME_CHECK.NOT_WRITABLE,
        reason: `The media root ${root} is not writable: ${probe.reason}`,
      };
    }
    const statfsInfo = inspect.statfsInfo;
    if (statfsInfo != null) {
      if (statfsInfo.totalBytes < MIN_VOLUME_BYTES) {
        return {
          ok: false,
          check: VOLUME_CHECK.CAPACITY_NOT_SANE,
          reason: `The volume under ${root} reports ${(statfsInfo.totalBytes / (1024 * 1024)).toFixed(0)} MB total — too small to be the family archive volume.`,
        };
      }
      const usedRatio = statfsInfo.totalBytes > 0 ? 1 - statfsInfo.freeBytes / statfsInfo.totalBytes : 1;
      if (usedRatio > MAX_USED_RATIO) {
        return {
          ok: false,
          check: VOLUME_CHECK.CAPACITY_NOT_SANE,
          reason: `The volume under ${root} is near-full (${(usedRatio * 100).toFixed(0)}% used) — free space before the archive moves there.`,
        };
      }
    }
    const t = String(inspect.fsType ?? "").toLowerCase();
    if (t === "fat" || t === "fat32" || t === "vfat" || t === "exfat" || t === "msdos") {
      return {
        ok: false,
        check: VOLUME_CHECK.FS_TYPE_REJECTED,
        reason: `The volume under ${root} is formatted ${inspect.fsType} — 4GB file caps and missing POSIX permissions break long videos and delete the archive's permissions.`,
      };
    }
    let flag = null;
    if (inspect.cloudMount) {
      flag = VOLUME_CHECK.FS_TYPE_FLAGGED;
    }
    if (t && MOUNT_TYPE_IMPERSONATING.has(t)) {
      flag = VOLUME_CHECK.FS_TYPE_FLAGGED;
    }
    return { ok: true, flag };
  }

  /**
   * An owner console edit (ac-4): the proposed root runs the five startup
   * checks — a failing path is REFUSED with the check's reason named. A
   * passing edit never moves existing media (owner-run move and repoint):
   * the store re-points, open upload sessions are abandoned with the
   * reason named, the new root enters the served history, and the runtime
   * config file is persisted through the injected callback.
   */
  async changeRoot(proposedRoot) {
    if (typeof proposedRoot !== "string" || !proposedRoot.trim()) {
      throw typedError("E_MEDIA_ROOT_INVALID", "A media root edit needs the volume's absolute path.");
    }
    if (!isAbsolute(proposedRoot)) {
      throw typedError("E_MEDIA_ROOT_INVALID", `The media root must be an absolute path (got "${proposedRoot}").`);
    }
    if (!this.relocatable) {
      throw typedError(
        "E_MEDIA_ROOT_UNAVAILABLE",
        "This deployment's media store is not filesystem-backed, so the media root cannot be edited here.",
      );
    }
    const check = await this.check(proposedRoot);
    if (!check.ok) {
      // ac-4: the edit is refused with the check's reason named.
      throw typedError("E_MEDIA_ROOT_REFUSED", `The media root edit was refused (${check.check}): ${check.reason}`, {
        check: check.check,
        reason: check.reason,
      });
    }
    const from = this.root;
    if (proposedRoot !== from) {
      // No automatic migration in V1: open upload sessions hold chunks on
      // the OLD root; they are abandoned with the reason named (the member
      // restarts the upload once the move/repoint completes).
      const open = await this.uploads.find({ state: "open" });
      for (const upload of open) {
        await this.uploads.updateOne(
          { _id: upload._id },
          { $set: { state: "abandoned", closedAs: "media-root-changed" } },
        );
      }
      // Config first (it stays the source of truth), then the live re-point.
      await this.persistRoot?.(proposedRoot);
      this.blobs.relocate(proposedRoot);
      this.root = proposedRoot;
    }
    await this.#markServed(this.root);
    this.#settle(STATE.READY, { flag: check.flag, resetReason: true });
    return this.status();
  }

  /**
   * The pause/availability gate for the media service's write and serve
   * paths (ac-3): a not-ready or refused volume throws the typed
   * ready-and-waiting error with the reason named — never a silent
   * fallback, never a redirect to another location.
   */
  async assertReady() {
    await this.gatePromise;
    if (this.state.state === STATE.READY) return;
    const stateLabel =
      this.state.state === STATE.STARTUP_REFUSED
        ? "media startup was refused at the volume gate"
        : "the archive volume is not ready (ready-and-waiting)";
    throw typedError(
      "E_MEDIA_VOLUME_NOT_READY",
      `${stateLabel}: ${this.state.reason ?? "the configured volume is unavailable"}. Media is paused, not moved.`,
      { volumeState: this.state.state, volumeReason: this.state.reason, volumeCheck: this.state.check },
    );
  }

  /**
   * The write-failure capture (ac-3, never a silent fallback): when a put
   * fails at the storage boundary (missing/unwritable root, failed
   * read-back), media pauses in the ready-and-waiting state with the
   * failure named and the readiness poll starts. Returns the typed
   * volume error the caller rethrows.
   */
  noteWriteFailure(error, rootAtWrite) {
    const missingAt = rootAtWrite ?? this.root;
    this.#settle(STATE.NOT_READY, {
      check: VOLUME_CHECK.NOT_READY,
      reason:
        error?.code === "E_BLOB_READBACK"
          ? "Bytes written to the media root failed their read-back verification."
          : `A write to the media root ${missingAt} failed (${error?.code ?? error?.message ?? "unknown error"}): the volume is not ready.`,
    });
    this.#schedulePoll();
    return typedError(
      "E_MEDIA_VOLUME_NOT_READY",
      `The archive volume is not ready: ${this.state.reason} Media is paused ready-and-waiting; nothing moved to another location.`,
      { volumeState: this.state.state, volumeReason: this.state.reason, volumeCheck: this.state.check },
    );
  }

  /**
   * The readiness poll (ac-3) [Assumed: 10s interval, build confirm]: a
   * paused known-good root re-checks live-mounted + writable on the
   * interval; a recovered volume resumes media automatically
   * (poll-and-recover, never a hub restart into the dead volume).
   */
  #schedulePoll() {
    if (this.#pollHandle != null) return;
    this.#pollHandle = this.timer.setTimeout(() => {
      this.#pollHandle = null;
      void this.#pollTick();
    }, this.pollIntervalMs);
    // Never hold the process open for the readiness poll.
    this.#pollHandle?.unref?.();
  }

  async #pollTick() {
    if (this.state.state !== STATE.NOT_READY && this.state.state !== STATE.STARTUP_REFUSED) return;
    const inspect = await this.fs.inspect(this.root);
    if (!inspect.exists) {
      this.#schedulePoll();
      return;
    }
    const probe = await this.fs.probeWrite(this.root);
    if (!probe.writable) {
      this.#schedulePoll();
      return;
    }
    await this.#markServed(this.root);
    this.#settle(STATE.READY, { resetReason: true });
  }

  /** The console + health status surface (ac-1): root + readiness state. */
  async status() {
    await this.gatePromise;
    if (!this.root) {
      return {
        root: null,
        state: STATE.READY,
        check: null,
        reason: null,
        flag: null,
        pollIntervalMs: this.pollIntervalMs,
        servedHistory: null,
      };
    }
    const marker = await this.#knownGoodMarker(this.root);
    const out = {
      root: this.root,
      state: this.state.state,
      check: this.state.check,
      reason: this.state.reason,
      flag: this.state.flag,
      pollIntervalMs: this.pollIntervalMs,
      servedHistory: marker
        ? { firstServedAt: marker.firstServedAt, lastReadyAt: marker.lastReadyAt }
        : null,
    };
    // A ready state re-probes live so the surface never shows a stale
    // readiness (the poll only runs while paused).
    if (out.state === STATE.READY) {
      const inspect = await this.fs.inspect(this.root);
      if (!inspect.exists) {
        return { ...out, state: STATE.NOT_READY, check: VOLUME_CHECK.NOT_READY, reason: `The media root ${this.root} is not a live mounted directory (volume not ready).` };
      }
      const probe = await this.fs.probeWrite(this.root);
      if (!probe.writable) {
        return { ...out, state: STATE.NOT_READY, check: VOLUME_CHECK.NOT_WRITABLE, reason: `The media root ${this.root} is not writable: ${probe.reason}` };
      }
    }
    return out;
  }

  /* Internals */

  async #knownGoodMarker(root) {
    if (!root) return null;
    try {
      return await this.markers.findOne({ _id: markerId(root) });
    } catch {
      return null;
    }
  }

  async #markServed(root) {
    const at = new Date().toISOString();
    await this.markers.updateOne(
      { _id: markerId(root) },
      { $set: { root: String(root), lastReadyAt: at }, upsert: true },
    );
    const marker = await this.markers.findOne({ _id: markerId(root) });
    if (marker && !marker.firstServedAt) {
      await this.markers.updateOne({ _id: marker._id }, { $set: { firstServedAt: at } });
    }
  }

  #settle(state, { check = null, reason = null, flag = undefined, resetReason = false } = {}) {
    this.state = {
      state,
      check: check ?? (resetReason ? null : this.state.check),
      reason: resetReason ? null : (reason ?? this.state.reason),
      flag: flag === undefined ? this.state.flag : flag,
      since: new Date().toISOString(),
    };
  }
}

/** darwin cloud impersonation types surfaced by `mount`. */
const MOUNT_TYPE_IMPERSONATING = new Set(["icloud", "cloudfs", "dropbox", "onedrive"]);

function typedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * The inert volume (the no-filesystem-root deployment): memory-backed
 * stores in tests and daemon-less runs. Always ready; it cannot pause,
 * cannot refuse, and its console edit refuses (there are no files to
 * re-point). This keeps every pre-existing media path byte-identical for
 * deployments with no configured root.
 */
export function createInertVolume() {
  return {
    gatePromise: Promise.resolve(),
    root: null,
    async assertReady() {},
    async status() {
      return { root: null, state: "ready", check: null, reason: null, flag: null, pollIntervalMs: null, servedHistory: null };
    },
    noteWriteFailure(error) {
      return typedError(
        "E_MEDIA_VOLUME_NOT_READY",
        `The media write failed and media is paused: ${error?.code ?? error?.message ?? "unknown error"}.`,
        { volumeState: "volume-not-ready", volumeReason: error?.message ?? null, volumeCheck: null },
      );
    },
    async changeRoot() {
      throw typedError(
        "E_MEDIA_ROOT_UNAVAILABLE",
        "This deployment's media store is not filesystem-backed, so the media root cannot be edited here.",
      );
    },
  };
}

export default MediaVolumeService;