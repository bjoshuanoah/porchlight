/**
 * Event service (PORCH-139, PRD 3 / TS 3 of the Porchlight Home initiative).
 * The family event/alert pipeline: the engine's detection stream arrives as
 * normalized DetectedObject facts (PORCH-I-009 TS 3 — label, bbox,
 * confidence, track id, epoch timestamp, camera); this service resolves
 * them through the camera association store into HOME-scoped events and
 * plain-language alerts.
 *
 *   • Dedup of record: key (area, entity/track, time window). Several
 *     contributing cameras/frames to one configured rule resolve as ONE
 *     event and ONE alert — multiple detections never ship as N alerts.
 *   • State machine of record: open → updated → closed. A window that
 *     expires with no further contribution closes the event (sweep).
 *   • Observations vs inferences: what detection SAW rides `observations`
 *     as fact; what interpretation CONCLUDED rides `inferences`, rendered
 *     conditional, never as fact (the factual fallback is law).
 *   • Factual fallback: with the interpreter unavailable the event still
 *     opens with evidence and the factual label; interpretation is
 *     fire-and-forget and can never block capture or factual alerts.
 *
 * Authorization: event surfaces are camera-class surfaces (PRD 2's
 * exclusion law) — every read resolves through the camera service's
 * authorization seam (home membership + separate camera authorization;
 * visit grants refuse with plain language).
 *
 * The interpreter seam (injected; Ollama-class at the deployment, Tier 1):
 *   { name, describe({ event }) → Promise<{ text } | null> }.
 * Interpretation gates on event state transitions — open (creation) and
 * close — never per frame (the PORCH-I-009 gating pattern carries).
 */
import { fail } from "./errors.js";

/** The dedup window of record (seconds): one routine arrival, one event. */
export const EVENT_DEDUP_WINDOW_SEC = 300;

/** Factual alert templates — observation phrasing only, never an invented claim. */
const FACTUAL_LABELS = {
  person: "Someone was seen at the {area}.",
  vehicle: "A vehicle was seen at the {area}.",
  animal: "An animal was seen at the {area}.",
  package: "A package was left, when the footage supports it — someone was seen at the {area}.",
  default: "Activity was seen at the {area}.",
};

export function factualLabel(label, areaName) {
  const template = FACTUAL_LABELS[String(label ?? "")] ?? FACTUAL_LABELS.default;
  return template.replace("{area}", areaName || "property");
}

export class EventService {
  /**
   * @param {import("@porchlight/shared").CollectionLike} events
   * @param {import("@porchlight/shared").CollectionLike} cameras — the
   *     association store: engine camera id → { homeId, areaId, name }.
   * @param {import("@porchlight/shared").CollectionLike} areas — area names
   *     for plain-language copy.
   * @param {import("@porchlight/shared").CollectionLike} homeAudit — flag
   *     writes land in the same audit family.
   * @param {object|null} [interpreter] — { name, describe({event}) } | null.
   * @param {{ dedupWindowSec?: number, now?: () => string }} [options]
   */
  constructor(events, cameras, areas, homeAudit, interpreter = null, options = {}) {
    this.events = events;
    this.cameras = cameras;
    this.areas = areas;
    this.audit = homeAudit;
    this.interpreter = interpreter ?? null;
    /** The camera service's authorization seam (camera-class surface law). */
    this.auth = options.auth ?? null;
    this.dedupWindowSec = Math.max(1, Math.floor(options.dedupWindowSec ?? EVENT_DEDUP_WINDOW_SEC));
    this.engine = null;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Ingest one engine detection (DetectedObject shape). Unknown cameras are
   * dropped — an event without a home context has no family surface. The
   * dedup key (area, track, window) resolves ONE event per routine arrival;
   * the first contribution opens the event and its ONE alert.
   *
   * @param {object} detection — { camera, trackId, cls, conf, t, bbox? }
   * @returns {{ event: object | null, created: boolean, ignored: string | null }}
   */
  async ingest(detection = {}) {
    this.sweep(this.now());
    const camera = await this.cameras.findOne({ engineCameraId: String(detection?.camera ?? "") });
    if (!camera) return { event: null, created: false, ignored: "unknown-camera" };
    if (!detection?.cls || !Number.isFinite(Number(detection?.t))) {
      return { event: null, created: false, ignored: "malformed-detection" };
    }
    const atMs = Number(detection.t) * 1000;
    const at = new Date(atMs).toISOString();
    const trackId = String(detection.trackId ?? "untracked");
    const area = camera.areaId ? await this.areas.findOne({ _id: camera.areaId }) : null;
    const areaId = camera.areaId ?? "property";
    const areaName = area?.name ?? "the property";
    const observation = {
      label: String(detection.cls),
      confidence: Number(detection.conf ?? 0),
      cameraId: camera._id,
      cameraName: camera.name,
      trackId,
      at,
    };
    const key = dedupKey({ homeId: camera.homeId, areaId, trackId });

    const open = await this.findOpen(key, atMs);
    if (open) {
      const merged = {
        ...open,
        state: "updated",
        updatedAt: at,
        cameraRefs: uniqueCameras(open.cameraRefs, camera._id),
        observations: [...(open.observations ?? []), observation],
      };
      await this.events.updateOne({ _id: open._id }, {
        $set: {
          state: merged.state,
          updatedAt: merged.updatedAt,
          cameraRefs: merged.cameraRefs,
          observations: merged.observations,
        },
      });
      return { event: this.view({ ...merged, areaName }), created: false, ignored: null };
    }

    // The ONE event and ONE alert for this rule window opens here. Evidence
    // resolves once per event (never per frame): the engine's evidence
    // reference at event time, or the gap reason when footage cannot carry it.
    const event = {
      _id: `evn_${crypto.randomUUID()}`,
      homeId: camera.homeId,
      areaId,
      key,
      state: "open",
      trackId,
      cameraRefs: [camera._id],
      observations: [observation],
      inferences: [],
      evidenceRefs: await this.#evidence(camera, atMs),
      alert: {
        text: factualLabel(detection.cls, areaName),
        interpretive: null,
        kind: "factual",
        at,
      },
      flag: null,
      startedAt: at,
      updatedAt: at,
      closedAt: null,
    };
    await this.events.insertOne(event);
    this.#interpret(event, `open:${event._id}`);
    return { event: this.view({ ...event, areaName }), created: true, ignored: null };
  }

  /** The event an open dedup window resolves into, or null. */
  async findOpen(key, atMs) {
    const rows = await this.events.find({ key, closedAt: null });
    const horizon = atMs - this.dedupWindowSec * 1000;
    return rows
      .filter((event) => Date.parse(event.updatedAt) >= horizon)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;
  }

  /**
   * Close events whose dedup window expired with no further contribution.
   * Called on every ingest and read (lazy, deterministic — no timers); the
   * close transition is the second interpretation gate.
   */
  async sweep(nowIso) {
    const now = Date.parse(String(nowIso ?? this.now()));
    if (!Number.isFinite(now)) return;
    const open = await this.events.find({ closedAt: null });
    for (const event of open) {
      if (now - Date.parse(event.updatedAt) > this.dedupWindowSec * 1000) {
        const closedAt = this.now();
        await this.events.updateOne({ _id: event._id }, { $set: { state: "closed", closedAt } });
        const closed = { ...event, state: "closed", closedAt };
        this.#interpret(closed, `close:${event._id}`);
      }
    }
  }

  async #authorize(accessToken, homeId) {
    if (this.auth) return this.auth.authorizeRead(accessToken, homeId);
    return fail("E_NOT_PERMITTED", "The camera surfaces aren't wired on this hub — camera authorization refuses closed.");
  }

  /**
   * GET /homes/:homeId/events — the alert surface of record: newest first,
   * bounded page (the audit pagination contract carries).
   */
  async list({ accessToken, homeId, limit, offset } = {}) {
    await this.#authorize(accessToken, homeId);
    await this.sweep(this.now());
    const rows = (await this.events.find({ homeId: String(homeId) })).sort(byStartedAtDesc);
    const pageSize = Math.min(Math.max(Math.floor(Number(limit) || 25), 1), 100);
    const start = Math.max(Math.floor(Number(offset) || 0), 0);
    return {
      events: rows.slice(start, start + pageSize).map((event) => this.view(event)),
      total: rows.length,
      limit: pageSize,
      offset: start,
      hasMore: start + pageSize < rows.length,
    };
  }

  /** GET /events/:eventId — the alert opens its event and evidence. */
  async get({ accessToken, eventId } = {}) {
    const event = await this.events.findOne({ _id: String(eventId ?? "") });
    if (!event) return fail("E_EVENT_NOT_FOUND", "That event isn't here anymore — it may have been removed.");
    await this.#authorize(accessToken, event.homeId);
    return { event: this.view(event) };
  }

  /**
   * POST /events/:eventId/flag — the user marks an incorrect event (plain
   * language refusal when the event is gone). Feeds the association
   * correction loop; one flag of record per event.
   */
  async flag({ accessToken, eventId, did } = {}) {
    const event = await this.events.findOne({ _id: String(eventId ?? "") });
    if (!event) return fail("E_EVENT_NOT_FOUND", "That event isn't here anymore — it may have been removed.");
    await this.#authorize(accessToken, event.homeId);
    if (event.flag) {
      return { event: this.view(event) };
    }
    const flag = { by: typeof did === "string" && did ? did : null, at: this.now() };
    await this.events.updateOne({ _id: event._id }, { $set: { flag } });
    await this.audit.record({
      type: "event-flag",
      homeId: event.homeId,
      actorIdentityRef: flag.by,
      deviceId: null,
      detail: { eventId: event._id, alertText: event.alert?.text ?? null },
      outcome: "confirmed",
    });
    return { event: this.view({ ...event, flag }) };
  }

  // --- internals ----------------------------------------------------------------

  /** Fire-and-forget interpretation on the open/close transitions ONLY. */
  #interpret(event, gate) {
    const interpreter = this.interpreter;
    if (!interpreter || typeof interpreter.describe !== "function") return;
    // Never block capture: the describe call runs detached; a failure only
    // means the interpretive copy stays unrendered — the factual alert stands.
    void Promise.resolve()
      .then(() => interpreter.describe({ event: this.view(event), gate }))
      .then(async (result) => {
        if (!result?.text) return;
        // Read-modify-write (the store's $set is flat): the alert copy stays
        // factual at its label; the inference renders interpretive — "when
        // the footage supports it" — never as fact.
        const current = await this.events.findOne({ _id: event._id });
        if (!current) return;
        const entry = { text: String(result.text), source: interpreter.name ?? "interpreter", at: this.now(), gate };
        await this.events.updateOne({ _id: current._id }, {
          $set: {
            inferences: [...(current.inferences ?? []), entry],
            alert: { ...(current.alert ?? {}), interpretive: String(result.text), kind: "interpretive" },
          },
        });
      })
      .catch(() => {});
  }

  /** The event-time evidence: a segment/clip/still ref, or the gap reason. */
  async #evidence(camera, atMs) {
    const engineAttached = this.#engineOf(camera);
    if (!engineAttached) {
      return [{ kind: "gap", reason: "unavailable" }];
    }
    try {
      const result = await engineAttached.evidenceAt({
        cameraId: camera.engineCameraId,
        at: Math.floor(atMs / 1000),
      });
      if (result?.gap) return [{ kind: "gap", reason: String(result.gap) }];
      return [{
        kind: result.kind ?? "segment",
        ref: String(result.ref ?? ""),
        path: result.path ? String(result.path) : null,
      }];
    } catch {
      return [{ kind: "gap", reason: "unavailable" }];
    }
  }

  /**
   * The engine seam rides the camera service's adapter. Injected here as a
   * setter from assembly — the event service never builds engine transport
   * itself (the engine is consumed, never built in this module).
   */
  setEngine(engine) {
    this.engine = engine ?? null;
  }

  #engineOf(_camera) {
    return this.engine ?? null;
  }

  /** View projection: the alert fact rides next to its conditional inference. */
  view(event) {
    return {
      _id: event._id,
      homeId: event.homeId,
      areaId: event.areaId ?? null,
      state: event.state,
      cameraRefs: event.cameraRefs ?? [],
      observations: event.observations ?? [],
      inferences: event.inferences ?? [],
      evidenceRefs: event.evidenceRefs ?? [],
      alert: event.alert ?? null,
      flag: event.flag ?? null,
      startedAt: event.startedAt,
      updatedAt: event.updatedAt,
      closedAt: event.closedAt ?? null,
    };
  }
}

function dedupKey({ homeId, areaId, trackId }) {
  return `${homeId}:${areaId}:${trackId}`;
}

function uniqueCameras(refs, cameraId) {
  return Array.isArray(refs) && refs.includes(cameraId) ? refs : [...(refs ?? []), cameraId];
}

function byStartedAtDesc(a, b) {
  return String(b.startedAt).localeCompare(String(a.startedAt)) || String(b._id).localeCompare(String(a._id));
}
