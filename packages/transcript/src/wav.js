// wav.js — WAV container for 16 kHz mono PCM (PORCH-155). The
// transcription providers of record ingest a WAV-built from the decoded
// f32le PCM lane: whisper-class local binaries and OpenAI-spec (whisper
// API family) both take standard containers, and building the container
// HERE keeps the provider seams dumb.
//
// Sample-rate note: the pcm lane of record is mono f32le 16 kHz
// (packages/stream PCM_SAMPLE_RATE); frames arriving at other rates are
// the caller's problem (the stream manager's lane law pins 16 kHz).

/** Wrap mono f32le PCM samples in a 16-bit PCM WAV container.
 * @param {Float32Array} data
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function wavOf(data, sampleRate) {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new Error("wavOf: sampleRate must be a positive number");
	}
	const pcm = new Int16Array(data.length);
	for (let i = 0; i < data.length; i++) {
		const s = Math.max(-1, Math.min(1, data[i]));
		pcm[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
	}
	const bytesPerSample = 2;
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length * bytesPerSample, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16); // fmt chunk size
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * bytesPerSample, 28);
	header.writeUInt16LE(bytesPerSample, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length * bytesPerSample, 40);
	return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}
