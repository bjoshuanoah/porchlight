// provider.local.js — the whisper-class local binary transcription provider
// (PORCH-155; TS 13: "Method = provider endpoint + model: whisper-class
// local binary"). The binary and its model file are PROVISIONED BY THE
// PRODUCT'S OWN SETUP (green-field law) — the provider never assumes an
// install; a missing binary is the stage's explained state, never a silent
// failure. Audio rides stdin as WAV; the transcript comes off stdout as
// JSON ({transcription: [{text…}]} — whisper.cpp class) or plain text.
//
// The spawn seam is injectable so the test matrix runs without a binary;
// production composition passes child_process.spawn.

import { spawn as nodeSpawn } from "node:child_process";
import fsDefault from "node:fs";
import { ValidationError } from "./types.js";
import { wavOf } from "./wav.js";

export class WhisperLocalProvider {
	/**
	 * @param {{
	 *   bin: string,                  // provisioned whisper-class binary
	 *   model: string,                // provisioned model file path
	 *   args?: string[],              // extra CLI args of record
	 *   spawn?: (cmd: string, args: string[]) => {
	 *     stdin: { write(b: Buffer|string): void, end(): void },
	 *     stdout: AsyncIterable<Buffer>|Iterable<Buffer>,
	 *     stderr: AsyncIterable<Buffer>|Iterable<Buffer>|(Buffer|string)[],
	 *     onExit?: (fn: (code: number|null) => void) => void,
	 *   },
	 *   fs?: typeof fsDefault,
	 *   language?: string,
	 *   log?: (...args: unknown[]) => void,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts.bin || typeof opts.bin !== "string") throw new ValidationError("bin: required (the provisioned whisper-class binary path)");
		if (!opts.model || typeof opts.model !== "string") throw new ValidationError("model: required (the provisioned model file path)");
		this.name = `whisper-local:${opts.model.split("/").pop()}`;
		this.bin = opts.bin;
		this.model = opts.model;
		this.args = opts.args ?? [];
		this.language = opts.language;
		this.spawnImpl = opts.spawn ?? nodeSpawn;
		this.fs = opts.fs ?? fsDefault;
		this.log = opts.log ?? (() => {});
	}

	/**
	 * @param {{camera: string, clipStart: number, clipEnd: number, sampleRate: number, data: Float32Array}} frame
	 * @returns {Promise<{text: string|null, language?: string}>}
	 */
	async transcribe(frame) {
		if (!this.spawnImpl) {
			throw new ValidationError(`${this.name}: no spawn seam available on this host — the local binary method needs the node child_process spawn`);
		}
		const child = this.spawnImpl(this.bin, ["-m", this.model, "-f", "-", ...(this.language ? ["-l", this.language] : []), ...this.args]);
		/** @type {Error|null} */
		let spawnError = null;
		// A missing/unrunnable binary surfaces on 'error' (ENOENT class) — the
		// provisioning failure of record, stated in plain language and thrown
		// immediately; the stage never hangs on streams that will never open.
		let onSpawnError;
		const failed = new Promise((_, reject) => {
			onSpawnError = (err) => {
				spawnError = /** @type {Error} */ (err);
				reject(new ValidationError(`${this.name}: the whisper-class binary could not run (${spawnError.message}) — run setup to provision it`));
			};
			child.on?.("error", onSpawnError);
		});
		try {
			child.stdin.write(wavOf(frame.data, frame.sampleRate));
			child.stdin.end();
		} catch (err) {
			// EPIPE-class stdin failures ride the same provisioning posture.
			throw new ValidationError(`${this.name}: the whisper-class binary could not run (${err instanceof Error ? err.message : String(err)}) — run setup to provision it`);
		}
		const [stdout, stderr] = await Promise.race([
			Promise.all([collect(child.stdout), collect(child.stderr)]),
			failed,
		]);
		if (spawnError) throw new ValidationError(`${this.name}: the whisper-class binary could not run (${spawnError.message}) — run setup to provision it`);
		if (child.onExit) {
			await new Promise((resolve) => child.onExit(() => resolve(undefined)));
		}
		return textFrom(stdout, stderr);
	}

	status() {
		return this.fs.existsSync(this.bin)
			? { engine: "spawn", providerClass: "native-mlx", model: this.model, state: "configured" }
			: { engine: "spawn", providerClass: "native-mlx", model: this.model, state: "degraded", reason: "the provisioned whisper-class binary is not present — run setup to provision it" };
	}
}

/** Collect a stdout/stderr stream (async-iterable or array shape). */
async function collect(stream) {
	if (!stream) return "";
	const chunks = [];
	if (Array.isArray(stream)) {
		// Injected seams deliver arrays; each entry is a Buffer/string chunk.
		let idx = 0;
		while (idx < stream.length) {
			chunks.push(typeof stream[idx] === "string" ? stream[idx] : stream[idx].toString("utf8"));
			idx += 1;
		}
		return chunks.join("");
	}
	for await (const c of /** @type {AsyncIterable<Buffer>} */ (stream)) {
		chunks.push(typeof c === "string" ? c : c.toString("utf8"));
	}
	return chunks.join("");
}

/** Parse stdout/stderr to { text, language? }: JSON (whisper.cpp class)
 * joins transcription segments; plain stdout reads as the transcript;
 * empty output is the EXPLICIT no-speech answer (null, never ""). */
function textFrom(stdout, stderr) {
	const raw = stdout.trim();
	if (raw === "") {
		if (stderr.includes("No such file") || stderr.includes("not found") || stderr.includes("ENOENT")) {
			throw new ValidationError("the whisper-class binary is missing — run setup to provision it");
		}
		return { text: null };
	}
	try {
		const doc = JSON.parse(raw);
		const segments = doc.transcription ?? doc.segments ?? [];
		const joined = segments.map((s) => s?.text ?? s?.transcription ?? "").join(" ").trim();
		if (joined !== "") return { text: joined, language: doc.result?.language ?? doc.language };
		return { text: null, language: doc.result?.language ?? doc.language };
	} catch {
		// Plain text stdout (the binary's --output-txt class).
		return raw === "" ? { text: null } : { text: raw };
	}
}
