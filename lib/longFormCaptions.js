/**
 * Caption / transcript sources for long-form video dub (no Gemini video ASR).
 */
import { fetchTranscript } from "youtube-transcript-plus";
import { extractYoutubeVideoId } from "./rapidApiYoutubeDownload.js";

/**
 * @typedef {{ text: string, offset?: number, duration?: number, lang?: string }} CaptionLine
 */

/**
 * @param {CaptionLine[]} lines
 * @returns {string}
 */
export function captionLinesToTranscript(lines) {
	if (!Array.isArray(lines) || !lines.length) return "";
	return lines
		.map((l) => String(l?.text ?? "").trim())
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * @param {string} srt
 * @returns {string}
 */
export function parseSrtToTranscript(srt) {
	const blocks = String(srt || "")
		.replace(/\uFEFF/g, "")
		.split(/\n\s*\n/);
	const lines = [];
	for (const block of blocks) {
		const rows = block.split(/\r?\n/).map((r) => r.trim());
		if (rows.length < 2) continue;
		const textRows = rows.filter(
			(r) => r && !/^\d+$/.test(r) && !/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(r),
		);
		if (textRows.length) lines.push(textRows.join(" "));
	}
	return lines.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * @param {string} videoUrl
 * @returns {Promise<{ transcript: string, sourceLanguage: string | null, source: string }>}
 */
export async function fetchYoutubeCaptionTranscript(videoUrl) {
	const id = extractYoutubeVideoId(videoUrl);
	if (!id) {
		throw new Error("Not a YouTube URL (cannot fetch YouTube captions)");
	}
	const lines = await fetchTranscript(id);
	if (!Array.isArray(lines) || !lines.length) {
		throw new Error("YouTube captions are not available for this video");
	}
	const transcript = captionLinesToTranscript(lines);
	if (!transcript) {
		throw new Error("YouTube captions are empty for this video");
	}
	const sourceLanguage =
		typeof lines[0]?.lang === "string" ? lines[0].lang.trim().slice(0, 2) : null;
	return {
		transcript,
		sourceLanguage,
		source: "youtube_captions",
	};
}

/**
 * @param {CaptionLine[]} lines
 * @returns {{ start_ms: number, end_ms: number, text: string }[]}
 */
export function youtubeLinesToSegments(lines) {
	if (!Array.isArray(lines)) return [];
	return lines
		.map((l) => {
			const startSec = Number(l?.offset) || 0;
			const durSec = Math.max(Number(l?.duration) || 0, 0.05);
			const text = String(l?.text ?? "").trim();
			if (!text) return null;
			return {
				start_ms: Math.floor(startSec * 1000),
				end_ms: Math.floor((startSec + durSec) * 1000),
				text,
			};
		})
		.filter(Boolean);
}

function parseSrtTimestampMs(raw) {
	const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(String(raw || "").trim());
	if (!m) return NaN;
	const hh = Number(m[1]);
	const mm = Number(m[2]);
	const ss = Number(m[3]);
	const ms = Number(String(m[4]).padEnd(3, "0").slice(0, 3));
	return (hh * 3600 + mm * 60 + ss) * 1000 + ms;
}

/**
 * @param {string} srt
 * @returns {{ start_ms: number, end_ms: number, text: string }[]}
 */
export function parseSrtToSegments(srt) {
	const blocks = String(srt || "")
		.replace(/\uFEFF/g, "")
		.split(/\n\s*\n/);
	const segments = [];
	for (const block of blocks) {
		const rows = block.split(/\r?\n/).map((r) => r.trim());
		if (rows.length < 2) continue;
		const timeRow = rows.find((r) => /-->/i.test(r));
		if (!timeRow) continue;
		const [a, b] = timeRow.split(/\s*-->\s*/);
		const start_ms = parseSrtTimestampMs(a);
		const end_ms = parseSrtTimestampMs(b);
		if (!Number.isFinite(start_ms) || !Number.isFinite(end_ms) || end_ms <= start_ms) {
			continue;
		}
		const text = rows
			.filter(
				(r) =>
					r &&
					r !== timeRow &&
					!/^\d+$/.test(r) &&
					!/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(r),
			)
			.join(" ")
			.trim();
		if (!text) continue;
		segments.push({ start_ms, end_ms, text });
	}
	return segments;
}

async function fetchYoutubeCaptionSegments(videoUrl) {
	const id = extractYoutubeVideoId(videoUrl);
	if (!id) return null;
	const lines = await fetchTranscript(id);
	const segments = youtubeLinesToSegments(lines);
	if (!segments.length) return null;
	const sourceLanguage =
		typeof lines[0]?.lang === "string" ? lines[0].lang.trim().slice(0, 2) : null;
	return {
		segments,
		sourceLanguage,
		source: "youtube_captions",
	};
}

/**
 * @param {{ videoUrl: string, videoPath?: string | null, extractEmbeddedSrt?: (videoPath: string) => Promise<string> }} opts
 * @returns {Promise<{ segments: { start_ms: number, end_ms: number, text: string }[], sourceLanguage: string | null, source: string } | null>}
 */
export async function tryResolveLongFormTimedSegments({
	videoUrl,
	videoPath,
	extractEmbeddedSrt,
}) {
	const url = String(videoUrl || "").trim();
	if (extractYoutubeVideoId(url)) {
		try {
			return await fetchYoutubeCaptionSegments(url);
		} catch (e) {
			console.warn(
				`[videoTranslate-long] YouTube timed captions failed: ${e?.message || e}`,
			);
		}
	}

	if (videoPath && typeof extractEmbeddedSrt === "function") {
		try {
			const srt = await extractEmbeddedSrt(videoPath);
			const segments = parseSrtToSegments(srt);
			if (segments.length) {
				return {
					segments,
					sourceLanguage: null,
					source: "embedded_subtitles",
				};
			}
		} catch (e) {
			console.warn(
				`[videoTranslate-long] embedded SRT segments failed: ${e?.message || e}`,
			);
		}
	}

	return null;
}

/**
 * @param {{ videoUrl: string, videoPath?: string | null, extractEmbeddedSrt?: (videoPath: string) => Promise<string> }} opts
 * @returns {Promise<{ transcript: string, sourceLanguage: string | null, source: string } | null>}
 */
export async function tryResolveLongFormCaptionTranscript(opts) {
	const timed = await tryResolveLongFormTimedSegments(opts);
	if (!timed?.segments?.length) return null;
	const transcript = captionLinesToTranscript(
		timed.segments.map((s) => ({ text: s.text })),
	);
	if (!transcript) return null;
	return {
		transcript,
		sourceLanguage: timed.sourceLanguage,
		source: timed.source,
	};
}

/** @deprecated use tryResolveLongFormCaptionTranscript */
export async function resolveLongFormCaptionTranscript(opts) {
	const out = await tryResolveLongFormCaptionTranscript(opts);
	if (!out) {
		throw new Error(
			"No captions found for long-form dub. Use a YouTube URL with captions enabled, or a video file with embedded subtitles.",
		);
	}
	return out;
}
