// provider.http.js — the HTTP transcription providers of record (PORCH-155;
// TS 13 "Method = provider endpoint + model"). Both methods of the OpenAI
// spec and the local-server class POST WAV-built audio; text comes back as
// the transcript. No speech → { text: null } — the EXPLICIT no-speech
// answer, never an empty string masquerading as a state; endpoint
// references are already RESOLVED by the composition root (never literal
// addresses here). fetch is injectable for tests.

import { ValidationError } from "./types.js";
import { wavOf } from "./wav.js";

/** OpenAI-spec transcription (POST <endpoint>/audio/transcriptions,
 * multipart form: file=audio.wav, model, response_format=json). */
export class OpenAiSpecTranscriptionProvider {
	/**
	 * @param {{
	 *   model: string,
	 *   endpoint: { url: string, key?: string },
	 *   fetch?: typeof globalThis.fetch,
	 *   language?: string,
	 *   log?: (...args: unknown[]) => void,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.model) throw new ValidationError("model: required (the transcription model of record, e.g. whisper-class)");
		if (!opts.endpoint?.url) throw new ValidationError("endpoint.url: required — the resolved endpoint, never a secret reference here");
		this.name = `openai-spec:${opts.model}`;
		this.model = opts.model;
		this.endpoint = opts.endpoint;
		this.language = opts.language;
		this.fetchImpl = opts.fetch ?? globalThis.fetch;
		this.log = opts.log ?? (() => {});
	}

	/**
	 * @param {{camera: string, clipStart: number, clipEnd: number, sampleRate: number, data: Float32Array}} frame
	 * @returns {Promise<{text: string|null, language?: string}>}
	 */
	async transcribe(frame) {
		const body = new FormData();
		body.append("file", new Blob([wavOf(frame.data, frame.sampleRate)], { type: "audio/wav" }), "audio.wav");
		body.append("model", this.model);
		body.append("response_format", "json");
		if (this.language) body.append("language", this.language);
		let res;
		try {
			res = await this.fetchImpl(`${this.endpoint.url.replace(/\/$/, "")}/audio/transcriptions`, {
				method: "POST",
				headers: this.endpoint.key ? { authorization: `Bearer ${this.endpoint.key}` } : {},
				body,
			});
		} catch (err) {
			throw new ValidationError(`${this.name}: transcription endpoint unreachable — ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!res.ok) {
			throw new ValidationError(`${this.name}: transcription failed (${res.status} ${res.statusText || "status"}): ${await safeText(res)}`);
		}
		const doc = await res.json();
		return textOf(doc);
	}

	status() {
		return { engine: "http", providerClass: "openai-spec", model: this.model, state: "configured", endpointResolved: true };
	}
}

/** Local-server transcription (POST <endpoint>/transcribe: JSON
 * {audio: base64 f32le PCM, sampleRate, format:"f32le"}) — the endpoint
 * class of a provisioned local model server; phonon / lfm3-class services
 * speak this shape (Brian's named candidates). */
export class LocalServerTranscriptionProvider {
	/**
	 * @param {{
	 *   model: string,
	 *   endpoint: { url: string, key?: string },
	 *   fetch?: typeof globalThis.fetch,
	 *   language?: string,
	 *   log?: (...args: unknown[]) => void,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.model) throw new ValidationError("model: required");
		if (!opts.endpoint?.url) throw new ValidationError("endpoint.url: required — the resolved endpoint, never a secret reference here");
		this.name = `local-server:${opts.model}`;
		this.model = opts.model;
		this.endpoint = opts.endpoint;
		this.language = opts.language;
		this.fetchImpl = opts.fetch ?? globalThis.fetch;
		this.log = opts.log ?? (() => {});
	}

	/**
	 * @param {{camera: string, clipStart: number, clipEnd: number, sampleRate: number, data: Float32Array}} frame
	 * @returns {Promise<{text: string|null, language?: string}>}
	 */
	async transcribe(frame) {
		let res;
		try {
			res = await this.fetchImpl(`${this.endpoint.url.replace(/\/$/, "")}/transcribe`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.endpoint.key ? { authorization: `Bearer ${this.endpoint.key}` } : {}),
				},
				body: JSON.stringify({
					model: this.model,
					format: "f32le",
					sampleRate: frame.sampleRate,
					audio: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength).toString("base64"),
					...(this.language ? { language: this.language } : {}),
				}),
			});
		} catch (err) {
			throw new ValidationError(`${this.name}: transcription endpoint unreachable — ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!res.ok) {
			throw new ValidationError(`${this.name}: transcription failed (${res.status} ${res.statusText || "status"}): ${await safeText(res)}`);
		}
		return textOf(await res.json());
	}

	status() {
		return { engine: "http", providerClass: "local-server", model: this.model, state: "configured", endpointResolved: true };
	}
}

/** Normalize a response body to { text, language? }: empty/blank text and
 * {results:[…]} segments both read through; blank is the explicit
 * no-speech answer (null, never ""). */
function textOf(doc) {
	const joined = typeof doc?.text === "string"
		? doc.text
		: Array.isArray(doc?.results) ? doc.results.map((s) => s?.text ?? s?.transcription ?? "").join(" ") : "";
	return {
		text: joined.trim() === "" ? null : joined.trim(),
		language: typeof doc?.language === "string" ? doc.language : undefined,
	};
}

async function safeText(res) {
	return res.text().catch(() => "<unreadable body>");
}
