/**
 * Timed TTS dub track for /api/video-translate/long — spans full video duration.
 */

/**
 * @typedef {{ start_ms: number, end_ms: number, text: string, translatedText?: string }} TimedSegment
 */

/**
 * @param {TimedSegment[]} segments
 * @param {number} [maxChars]
 * @returns {TimedSegment[]}
 */
export function mergeSegmentsForTts(segments, maxChars = 350) {
	const out = [];
	let current = null;
	for (const seg of segments) {
		const text = String(seg.text || "").trim();
		if (!text) continue;
		if (
			!current ||
			current.text.length + 1 + text.length > maxChars
		) {
			if (current) out.push(current);
			current = {
				start_ms: seg.start_ms,
				end_ms: seg.end_ms,
				text,
			};
		} else {
			current.text = `${current.text} ${text}`;
			current.end_ms = Math.max(current.end_ms, seg.end_ms);
		}
	}
	if (current) out.push(current);
	return out;
}

/**
 * @param {Buffer} track s16le PCM
 * @param {Buffer} chunk s16le PCM
 * @param {number} startSample
 */
export function overlayPcmS16le(track, chunk, startSample) {
	const byteOffset = Math.max(0, startSample) * 2;
	const max = Math.min(chunk.length, track.length - byteOffset);
	for (let i = 0; i < max; i += 2) {
		const sample = chunk.readInt16LE(i);
		const existing = track.readInt16LE(byteOffset + i);
		const mixed = Math.max(-32768, Math.min(32767, existing + sample));
		track.writeInt16LE(mixed, byteOffset + i);
	}
}

/**
 * @param {number} durationSec
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function createSilentPcmBuffer(durationSec, sampleRate) {
	const samples = Math.max(1, Math.ceil(durationSec * sampleRate));
	return Buffer.alloc(samples * 2);
}
