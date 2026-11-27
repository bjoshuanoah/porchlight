// service.js — the TranscriptionService (PORCH-155; PORCH-I-009 PRD 13 /
// TS 13). A consumer of the engine's stream manager: it feeds from the
// decoded PCM lane each camera already produces — NOTHING opens a second
// camera connection (stream-manager law).
//
// Regimes of record:
//   - rolling (submitRollingAudio): aligned ~1-minute windows, gated by the
//     per-camera transcription enablement knob (off by default, like the
//     audio plane — analysis runs only where the deployment turned it on).
//     Cadence of record: a window transcribes in well under its wall-clock
//     length; the built-in budget is ROLLING_CADENCE_BUDGET_MS and every
//     overrun is counted and stated, never silent (the benchmark run on the
//     M4 Pro host of record gates before any capacity number commits).
//   - event (submitEventSpan): full-span event audio end to end, split into
//     sequential chunks when the span exceeds one window, text joined; the
//     record carries the FULL span or an EXPLICIT partiality state — never
//     a silent truncation.
//
// Text lands in the transcript store of record and embeds AT WRITE TIME
// into the local vector store of record with the TS 13 payload refs —
// never lazily, never async eventually: a written text chunk has its
// vector before the write path returns. Absence of text is ALWAYS an
// explicit state ("no-speech"), never a missing field. Event records obey
// the desc-and-transcript law (the store enforces: description and
// transcript together or neither).
//
// Method selection (three scopes, camera → recording type → global, the
// resolved layer always visible) rides resolve.js; the provider INSTANCE
// per method is resolved through the caller's seam, with the exported
// createProviderResolver wiring model + endpoint refs from the compute
// posture (PRD 5 / TS 5 InferenceProvider — the transcription stage plan).

import { ROLLING_CADENCE_BUDGET_MS, ROLLING_WINDOW_MS, EVENT_CHUNK_MS, ValidationError, eventRefOf } from "./types.js";
import { RollingWindower } from "./windower.js";
import { resolveTranscriptionMethod, validateMethodDoc, BUILTIN_METHOD } from "./resolve.js";
import { OpenAiSpecTranscriptionProvider, LocalServerTranscriptionProvider } from "./provider.http.js";
import { WhisperLocalProvider } from "./provider.local.js";

/**
 * The default provider seam per method class (TS 13 method classes). The
 * plan carries the compute posture values {model, endpoint} — the
 * transcription stage's plan of record (model + resolved endpoint); a
 * method's provider is built fresh per re-point, never mutated in place.
 *
 * @param {"whisper-local"|"openai-spec"|"local-server"} method
 * @param {{ model: string|null, endpoint: {url: string, key?: string}|null, language?: string }} plan
 * @param {{ log?: (...args: unknown[]) => void }} [deps]
 * @returns {import("./types.js").TranscriptionProvider}
 */
export function createMethodProvider(method, plan, deps = {}) {
	const language = plan.language;
	switch (method) {
		case "whisper-local":
			if (!plan.model) throw new ValidationError("whisper-local: the transcription stage has no model of record — re-point it on the Models/Compute surface");
			return /** @type {any} */ (new WhisperLocalProvider({ bin: plan.bin ?? defaultBin(), model: plan.model, language, log: deps.log }));
		case "openai-spec":
			if (!plan.endpoint) throw new ValidationError("openai-spec: the transcription stage has no endpoint of record — re-point it on the Models/Compute surface");
			if (!plan.model) throw new ValidationError("openai-spec: the transcription stage has no model of record — re-point it on the Models/Compute surface");
			return new OpenAiSpecTranscriptionProvider({ model: plan.model, endpoint: plan.endpoint, language, log: deps.log });
		case "local-server":
			if (!plan.endpoint) throw new ValidationError("local-server: the transcription stage has no endpoint of record — re-point it on the Models/Compute surface");
			if (!plan.model) throw new ValidationError("local-server: the transcription stage has no model of record — re-point it on the Models/Compute surface");
			return new LocalServerTranscriptionProvider({ model: plan.model, endpoint: plan.endpoint, language, log: deps.log });
		default:
			throw new ValidationError(`method "${method}" has no provider class of record`);
	}
}

function defaultBin() {
	// Provisioned-by-setup install path of record (green-field law); absent
	// binary is the provider's own degraded status, never a silent guess.
	return "/Library/Porchlight/bin/whisper.cpp";
}

/**
 * A provider resolver that rebuilds per METHOD (the three-scope selection
 * drives which provider a camera's transcription rides).
 * @param {Partial<Record<string, {model: string|null, endpoint: {url: string, key?: string}|null, bin?: string, language?: string}>>} plans
 *   method class → its compute posture plan (model + RESOLVED endpoint —
 *   never a secret reference here; the composition root resolves refs)
 * @param {{ log?: (...args: unknown[]) => void }} [deps]
 */
export function createProviderResolver(plans, deps = {}) {
	return (method) => createMethodProvider(method, plans[method] ?? { model: null, endpoint: null }, deps);
}

export class TranscriptionService {
	/**
	 * @param {{
	 *   store: import("./store.js").TranscriptStore,
	 *   vectorStore: import("./vector.js").LocalVectorStore,
	 *   resolveProvider: (method: string) => import("./types.js").TranscriptionProvider,
	 *   embedder?: import("./types.js").Embedder,
	 *   methods?: unknown,                             // method doc of record (validateMethodDoc shape)
	 *   enabledFor?: (cameraId: string) => Promise<boolean|{value: boolean, source: string}>|boolean|{value: boolean, source: string},
	 *   eventReader?: (span: {cameraId: string, from: number, to: number}) => Promise<{data: Float32Array, sampleRate: number}|null>,
	 *   resolveTimeline?: (timeline: {cameraId: string, sourceType: string, sourceRef: string, startOffset: number}) => {path: string, label: string},
	 *   windowMs?: number,
	 *   now?: () => number,                            // epoch ms (Date.now class)
	 *   log?: (...args: unknown[]) => void,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.store) throw new TypeError("TranscriptionService: store is required (the transcript store of record)");
		if (!opts.vectorStore) throw new TypeError("TranscriptionService: vectorStore is required (the local vector store of record)");
		if (typeof opts.resolveProvider !== "function") throw new TypeError("TranscriptionService: resolveProvider is required (method → provider seam)");
		if (!opts.now || typeof opts.now !== "function") throw new TypeError("TranscriptionService: now is required");
		if (!opts.log || typeof opts.log !== "function") throw new TypeError("TranscriptionService: log is required");
		this.store = opts.store;
		this.vectorStore = opts.vectorStore;
		this.resolveProviderFn = opts.resolveProvider;
		this.embedder = opts.embedder ?? null;
		this.enabledFor = opts.enabledFor ?? (() => false);
		this.eventReader = opts.eventReader ?? null;
		this.resolveTimelineFn = opts.resolveTimeline ?? defaultTimelineResolver;
		this.now = opts.now;
		this.log = opts.log;
		this.windower = new RollingWindower({ windowMs: opts.windowMs ?? ROLLING_WINDOW_MS });
		this.methods = validateMethodDoc(opts.methods ?? null);
		/** @type {Map<string, import("./types.js").TranscriptionProvider>} */
		this.providerCache = new Map();
		// Cadence counters of record (benchmark-gated: AC-1's observables).
		this.cadence = {
			windowsStarted: 0,
			windowsCompleted: 0,
			lastWindowRef: null,
			lastWindowMs: null,
			budgetMs: ROLLING_CADENCE_BUDGET_MS,
			budgetOverruns: 0,
		};
		this.counters = { chunks: 0, refused: 0, recordsWritten: 0, vectorsWritten: 0, eventSpans: 0 };
		/** @type {Map<string, Promise<unknown>>} */
		this.queues = new Map();
		/** @type {{reason: string|null}} */
		this.stopped = { reason: null };
		/** @type {Set<Promise<unknown>>} */
		this.inFlight = new Set();
	}

	/** The method doc of record (normalized). */
	methodDoc() {
		return structuredClone(this.methods);
	}

	/** Replace the method doc of record (admin surface, live). */
	setMethodDoc(value) {
		this.methods = validateMethodDoc(value);
		this.providerCache.clear(); // scopes changed — next build resolves fresh
		return this.methodDoc();
	}

	/**
	 * Inspect one camera/type's effective method WITH its source layer (the
	 * layer-visibility pattern; AC-4's scope inspection).
	 * @param {string} cameraId
	 * @param {"rolling"|"event"} sourceType
	 */
	inspectMethod(cameraId, sourceType) {
		const resolved = resolveTranscriptionMethod(this.methods, cameraId, sourceType);
		return {
			...resolved,
			layers: {
				camera: this.methods.cameras[cameraId] ?? null,
				recordingTypes: structuredClone(this.methods.recordingTypes),
				global: this.methods.global,
				builtIn: BUILTIN_METHOD,
			},
		};
	}

	/**
	 * The live provider per METHOD (rebuilt when the compute posture
	 * re-points it through {@link repoint}).
	 * @param {string} method
	 * @returns {import("./types.js").TranscriptionProvider}
	 */
	providerFor(method) {
		let provider = this.providerCache.get(method);
		if (!provider) {
			provider = this.resolveProviderFn(method);
			this.providerCache.set(method, provider);
			this.log(`[transcript] provider bound for method "${method}": ${provider.name}`);
		}
		return provider;
	}

	/**
	 * Compute re-point seam (wireComputeRepoints applier target): rebuild the
	 * provider for the affected scope. `value` is the stage plan change —
	 * the resolver seam reads it; the cache clears so every method rebuilds
	 * from the posture of record. Never restarts anything (live apply).
	 */
	repoint() {
		this.providerCache.clear();
		this.log(`[transcript] compute re-point applied — providers rebuild on next use (generation ${this.generation()})`);
	}

	generation() {
		return this.providerCache.size;
	}

	/**
	 * Enablement gate — never silent. A disabled camera is REFUSED with the
	 * reason; no provider call, nothing retained (zero analysis).
	 * @returns {Promise<{value: boolean, source: string}|{refused: string}>}
	 */
	async enabled(cameraId) {
		if (this.stopped.reason) return { refused: this.stopped.reason };
		const answer = await this.enabledFor(cameraId);
		if (typeof answer === "boolean") return answer ? { value: true, source: "injected" } : { refused: `transcription is off for camera "${cameraId}"` };
		if (answer && typeof answer.value === "boolean" && typeof answer.source === "string") {
			return answer.value ? { value: answer.value, source: answer.source } : { refused: `transcription is off for camera "${cameraId}" (source layer "${answer.source}")` };
		}
		throw new TypeError('transcription enablement must be boolean or { value: boolean, source: string }');
	}

	/**
	 * The rolling regime: one decoded chunk in, completed windows out to
	 * transcription — per-camera serialized so windows transcribe IN ORDER
	 * without blocking the feed. Cadence is measured per window
	 * (close → text-landed) and stated in status(); an overrun counts.
	 *
	 * @param {{camera: string, t: number, sampleRate: number, data: Float32Array}} chunk
	 * @returns {Promise<{queued: number, refused: string|null}>}
	 */
	async submitRollingAudio(chunk) {
		this.counters.chunks += 1;
		const gate = await this.enabled(chunk.camera);
		if ("refused" in gate && gate.refused) {
			this.counters.refused += 1;
			return { queued: 0, refused: gate.refused };
		}
		const windows = this.windower.push(chunk);
		if (windows.length === 0) return { queued: 0, refused: null };
		const camera = chunk.camera;
		const previous = this.queues.get(camera) ?? Promise.resolve();
		const run = previous
			.catch((err) => this.log(`[transcript] previous window chain for "${camera}" failed (continuing): ${/** @type {Error} */ (err).message}`))
			.then(() => this.transcribeWindows(windows));
		this.queues.set(camera, run);
		this.inFlight.add(run);
		run.finally(() => {
			this.inFlight.delete(run);
			if (this.queues.get(camera) === run) this.queues.delete(camera);
		});
		return { queued: windows.length, refused: null };
	}

	/**
	 * Resolve when every in-flight window/event transcription has settled —
	 * the e2e cadence assertions settle here before reading counters.
	 */
	async settled() {
		while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
	}

	/**
	 * Transcribe completed windows in order; each window's cadence is
	 * measured close → text-landed and every budget overrun counts.
	 * @param {Array<{camera: string, ref: string, clipStart: number, clipEnd: number, sampleRate: number, data: Float32Array}>} windows
	 */
	async transcribeWindows(windows) {
		for (const window of windows) {
			const started = this.now();
			this.cadence.windowsStarted += 1;
			/** @type {string|null} */
			let text = null;
			/** @type {string|null} */
			let failed = null;
			let providerName = "unknown";
			try {
				const method = resolveTranscriptionMethod(this.methods, window.camera, "rolling").method;
				const provider = this.providerFor(method);
				providerName = provider.name;
				const result = await provider.transcribe({ camera: window.camera, clipStart: window.clipStart, clipEnd: window.clipEnd, sampleRate: window.sampleRate, data: window.data });
				text = normalizeText(result?.text);
			} catch (err) {
				// A failing provider degrades to an EXPLICIT partial record —
				// never a silent gap between windows.
				failed = `window transcription failed: ${err instanceof Error ? err.message : String(err)}`;
			}
			const took = this.now() - started;
			this.cadence.lastWindowMs = took;
			this.cadence.lastWindowRef = window.ref;
			if (took > this.cadence.budgetMs) {
				this.cadence.budgetOverruns += 1;
				this.log(`[transcript] cadence overrun on ${window.ref}: ${Math.round(took)}ms exceeds the ${this.cadence.budgetMs}ms budget (stated, benchmark-gated)`);
			}
			await this.writeRecordWithVectors({
				cameraId: window.camera,
				sourceType: "rolling",
				sourceRef: window.ref,
				startOffset: window.clipStart,
				endOffset: window.clipEnd,
				text: failed ? null : text,
				state: failed ? "partial" : text === null ? "no-speech" : "text",
				...(failed ? { partial: { completedChunks: 0, totalChunks: 1, reason: failed } } : {}),
				transcribedAt: started / 1000,
				provider: failed ? "unavailable" : providerName,
			});
			this.cadence.windowsCompleted += 1;
		}
	}

	/**
	 * The event regime: full-span event audio end to end (TS 13 "Event
	 * spans"). Reads the span through the injected eventReader, splits into
	 * sequential chunks (EVENT_CHUNK_MS), joins the text, and records either
	 * the FULL span or an EXPLICIT partiality state. Requires a description
	 * — the desc-and-transcript law refuses one-sided event records.
	 *
	 * @param {{cameraId: string, eventId: string, description: string, startedAt: number, endedAt: number}} span
	 * @returns {Promise<{record: import("./types.js").TranscriptRecord|null, error?: string}>}
	 */
	async submitEventSpan(span) {
		this.counters.eventSpans += 1;
		const gate = await this.enabled(span.cameraId);
		if ("refused" in gate && gate.refused) {
			this.counters.refused += 1;
			return { record: null, error: gate.refused };
		}
		if (typeof span.eventId !== "string" || span.eventId.trim() === "") throw new ValidationError("eventId: required");
		if (typeof span.description !== "string" || span.description.trim() === "") {
			throw new ValidationError("description: required — the desc-and-transcript law renders description and transcript together or neither, so an event transcript is never written one-sided");
		}
		if (!this.eventReader) throw new ValidationError("eventReader: not wired — the event regime reads audio through the composition root's reader seam");
		const method = resolveTranscriptionMethod(this.methods, span.cameraId, "event").method;
		const provider = this.providerFor(method);
		const totalSec = Math.max(0, span.endedAt - span.startedAt);
		const totalChunks = Math.max(1, Math.ceil(totalSec / (EVENT_CHUNK_MS / 1000)));
		/** @type {Array<{startOffset: number, endOffset: number, text: string|null, state: "text"|"no-speech"|"partial", reason?: string}>} */
		const chunks = [];
		/** @type {string|null} */
		let failedReason = null;
		for (let i = 0; i < totalChunks; i++) {
			const from = span.startedAt + i * (EVENT_CHUNK_MS / 1000);
			const to = Math.min(span.endedAt, from + EVENT_CHUNK_MS / 1000);
			/** @type {{data: Float32Array, sampleRate: number}|null} */
			let audio = null;
			try {
				audio = await this.eventReader({ cameraId: span.cameraId, from, to });
			} catch (err) {
				failedReason ??= `event audio read failed: ${err instanceof Error ? err.message : String(err)}`;
			}
			if (!audio || audio.data.length === 0) {
				if (!failedReason) failedReason ??= `event audio unavailable for chunk ${i + 1}/${totalChunks} — the span stays explicit, never truncated`;
				chunkPush(chunks, from, to, null, "partial", failedReason);
				continue;
			}
			try {
				const result = await provider.transcribe({ camera: span.cameraId, clipStart: from, clipEnd: to, sampleRate: audio.sampleRate, data: audio.data });
				const text = normalizeText(result?.text);
				chunkPush(chunks, from, to, text, text === null ? "no-speech" : "text");
			} catch (err) {
				failedReason ??= `chunk ${i + 1}/${totalChunks} transcription failed: ${err instanceof Error ? err.message : String(err)}`;
				chunkPush(chunks, from, to, null, "partial", failedReason);
			}
		}
		const spoken = chunks.filter((c) => c.state === "text");
		const completed = chunks.filter((c) => c.state !== "partial").length;
		const state = completed < totalChunks ? "partial" : spoken.length === 0 ? "no-speech" : "text";
		const record = /** @type {import("./types.js").TranscriptRecord} */ ({
			cameraId: span.cameraId,
			sourceType: "event",
			sourceRef: eventRefOf(span.cameraId, span.eventId),
			startOffset: span.startedAt,
			endOffset: span.endedAt,
			text: state === "no-speech" ? null : spoken.map((c) => c.text).join(" ").trim() || null,
			state,
			...(state === "partial" ? { partial: { completedChunks: completed, totalChunks, reason: failedReason ?? "the span is incomplete" } } : {}),
			chunks: totalChunks > 1 ? chunks : undefined,
			transcribedAt: this.now() / 1000,
			provider: provider.name,
			description: span.description,
		});
		await this.writeRecordWithVectors(record);
		return { record };
	}

	/**
	 * THE WRITE PATH (never lazy): the record lands in the store of record,
	 * then every text chunk embeds into the vector store of record with the
	 * TS 13 payload refs — a written text chunk holds its vector BEFORE this
	 * returns. Embedding failure never destroys the text: the record keeps
	 * it and the failure is stated in the log + status, never silent.
	 * @returns {Promise<void>}
	 */
	async writeRecordWithVectors(record) {
		this.store.put(record);
		this.counters.recordsWritten += 1;
		let embedder = this.embedder;
		if (!embedder) {
			// Never-silent embedding posture: text with no embedder of record is
			// stated in status() and the search surface refuses with plain
			// language — the record still lands (text is the primary data).
			return;
		}
		const chunks = record.chunks?.length
			? record.chunks.filter((c) => c.state === "text")
			: record.state === "text"
				? [{ startOffset: record.startOffset, endOffset: record.endOffset, text: record.text, state: "text" }]
				: [];
		for (const chunk of chunks) {
			try {
				const { data } = await embedder.embed(/** @type {string} */ (chunk.text));
				this.vectorStore.put({ data }, {
					cameraId: record.cameraId,
					sourceType: record.sourceType,
					sourceRef: record.sourceRef,
					startOffset: chunk.startOffset,
					endOffset: chunk.endOffset,
					text: /** @type {string} */ (chunk.text),
				});
				this.counters.vectorsWritten += 1;
			} catch (err) {
				this.log(`[transcript] write-time embedding failed for ${record.sourceRef} (stated, record keeps its text): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/**
	 * Flush every camera's pending remainder (consumer stop: analyzed audio
	 * never loses its tail) and await their transcription.
	 */
	async flushAll() {
		const cameras = [...this.windower.buckets.keys()];
		const flushed = cameras.map((cam) => { const w = this.windower.flush(cam); return w; }).filter(Boolean);
		await this.transcribeWindows(/** @type {any[]} */ (flushed));
		await this.settled();
	}

	/**
	 * Semantic audio search: embed the query, rank the collection, resolve
	 * every result's source ref to its timeline path. Works across BOTH
	 * store families (rolling windows and events).
	 *
	 * @param {string} query
	 * @param {{k?: number, sourceType?: "rolling"|"event", cameraId?: string}} [opts]
	 */
	async search(query, opts = {}) {
		if (!this.embedder) {
			throw new ValidationError("semantic search is unavailable: the embedding stage has no provider of record — re-point it on the Models/Compute surface");
		}
		if (typeof query !== "string" || query.trim() === "") throw new ValidationError("query: required (a spoken phrase or its paraphrase)");
		const { data } = await this.embedder.embed(query);
		const hits = this.vectorStore.search({ data }, { k: opts.k ?? 10, sourceType: opts.sourceType, cameraId: opts.cameraId });
		return hits.map((hit) => ({
			score: hit.score,
			...hit.payload,
			timeline: this.resolveTimelineFn({
				cameraId: hit.payload.cameraId,
				sourceType: hit.payload.sourceType,
				sourceRef: hit.payload.sourceRef,
				startOffset: hit.payload.startOffset,
			}),
		}));
	}

	/**
	 * Source refs resolve to timeline paths of record (AC-3): a rolling
	 * window seeks the recorder timeline at its start; an event opens the
	 * event page.
	 * @param {{cameraId: string, sourceType: string, sourceRef: string, startOffset: number}} t
	 */
	resolveTimeline(t) {
		return this.resolveTimelineFn(t);
	}

	/**
	 * Full never-silent posture of the stage (the compute plane registers
	 * this reporter for "transcription").
	 */
	status() {
		const method = (cam, type) => this.inspectMethod(cam, type).method;
		return {
			stage: "transcription",
			state: this.stopped.reason ? "failed" : "native",
			reason: this.stopped.reason ?? undefined,
			methods: {
				global: this.methods.global ?? `${BUILTIN_METHOD} (built-in)`,
				recordingTypes: this.methods.recordingTypes,
				cameraOverrides: Object.keys(this.methods.cameras),
				effective: { rolling: method("any-camera", "rolling"), event: method("any-camera", "event") },
			},
			provider: [...this.providerCache.entries()].map(([m, p]) => ({ method: m, name: p.name, ...(p.status?.() ?? {}) })),
			embedder: this.embedder?.status?.() ?? { state: "not-provisioned", reason: "no embedder of record is wired — write-time embedding and search state it plainly" },
			cadence: structuredClone(this.cadence),
			counters: structuredClone(this.counters),
			retained: this.windower.retained(),
			stopped: this.stopped.reason,
		};
	}

	/** The compute status the config plane registers (compute.js law). */
	computeStatus() {
		const s = this.status();
		return {
			stage: "transcription",
			...s.provider[0], // the resolved method's provider posture
			state: s.stopped ? "failed" : s.provider[0]?.state ?? "native",
			refused: s.counters.refused,
		};
	}

	/**
	 * Consumer-loss law (TS 8 pattern): stop marks the consumer stopped with
	 * an explained reason — chunks refuse, nothing transcription-side dies
	 * silently; recording and visual detection continue.
	 * @param {string} reason
	 */
	stop(reason) {
		const detail = typeof reason === "string" && reason.trim() !== "" ? reason : "the transcription consumer stopped";
		this.stopped = {
			reason: `transcript analysis stopped (${detail}) — speech is no longer transcribed; recording and visual detection continue.`,
		};
		this.log(`[transcript] ${this.stopped.reason}`);
	}

	restart() {
		this.stopped = { reason: null };
	}

	/** Close providers (close errors logged, never fatal). */
	async close() {
		this.windower.buckets.clear(); // unanalyzed remainder dropped with the consumer
		for (const provider of this.providerCache.values()) {
			try {
				await provider.close?.();
			} catch (err) {
				this.log(`[transcript] provider close failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		this.providerCache.clear();
	}
}

function chunkPush(chunks, from, to, text, state, reason) {
	chunks.push({ startOffset: from, endOffset: to, text, state, ...(reason ? { reason } : {}) });
}

/** Blank text is the no-speech answer; a string renders trimmed. */
function normalizeText(text) {
	if (typeof text !== "string") return null;
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * The default timeline resolution of record (AC-3): rolling → seek target;
 * event → event page.
 * @param {{cameraId: string, sourceType: string, sourceRef: string, startOffset: number}} t
 */
export function defaultTimelineResolver(t) {
	if (t.sourceType === "event") {
		const eventId = t.sourceRef.slice(`event-${t.cameraId}-`.length);
		return { path: `/events/${encodeURIComponent(t.cameraId)}/${encodeURIComponent(eventId)}`, label: "event" };
	}
	const at = new Date(t.startOffset * 1000).toISOString();
	return { path: `/timeline/${encodeURIComponent(t.cameraId)}?at=${encodeURIComponent(at)}`, label: "rolling window" };
}
