
import { v4 as uuidv4 } from "uuid";
import { execFile } from "child_process";
import { existsSync } from "node:fs";
import youtubedl, { create as createYoutubeDl } from "youtube-dl-exec";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";
import { UTApi, UTFile } from "uploadthing/server";
import { VIDEO_TRANSLATE_TARGET_LANGUAGES } from "./videoTranslateLanguages.js";
import {
	mergeOpenRouterUsage,
	normalizeOpenRouterUsage,
	buildUsageResponseFields,
	publicTranslateUsageFromDoc,
} from "./openRouterUsage.js";
import { resolveTranslateLlmModel } from "./translateLlmModels.js";
import { translateTextWithNllb, isNllbRuntimeReady } from "./nllbTranslate.js";
import { piperSynthesizeWav, isPiperConfigured } from "./piperTts.js";
import { refineTranslationGlossaryOpenRouter } from "./translationRefineGlossary.js";
import { getFfmpegBin, getFfprobeBin } from "./ffmpegBin.js";
import {
	targetLanguageLabelToNllb,
	looseIsoToNllbSource,
	whisperIsoToNllbSource,
} from "./nmtLanguages.js";
import {
	buildYtDlpProxyUrl,
	buildYtDlpProxyExecOptions,
	getVideoTranslateProxyManager,
	getVideoTranslateProxyMaxRotations,
	isProxyAuthError,
	isProxyIpBlacklistedError,
	preferDirectYtDlpWhenCookiesConfigured,
	proxyPoolKey,
	shouldUseVideoTranslateProxies,
} from "./proxyManager.js";
import {
	resolveOpenRouterTtsVoice,
	voiceForOpenAiChatTts,
} from "./openRouterTtsVoices.js";
import {
	isYoutubeVideoUrl,
	normalizeYoutubeVideoUrl,
	resolveYoutubeRapidApiMedia,
	assertValidVideoBuffer,
	logRapidApiYoutubeAtStartup,
} from "./rapidApiYoutubeDownload.js";
import {
	createSilentPcmBuffer,
	mergeSegmentsForTts,
	overlayPcmS16le,
} from "./longFormTimedDub.js";
import { tryResolveLongFormTimedSegments } from "./longFormCaptions.js";
import {
	longFormTranscriptSchema,
	longFormTranslationSchema,
	parseLongFormModelResponse,
} from "./longFormModelSchemas.js";
import { extractMessageText } from "./parseModelJson.js";

export { logRapidApiYoutubeAtStartup };

export { VIDEO_TRANSLATE_TARGET_LANGUAGES };
export { getOpenRouterTtsVoicesResponse } from "./openRouterTtsVoices.js";
export { getOpenRouterTtsVoicesWithPreviews } from "./openRouterTtsVoicePreviews.js";

const OPENROUTER_GLOSSARY_REFINE_MODEL =
	process.env.OPENROUTER_GLOSSARY_REFINE_MODEL?.trim() ||
	"openai/gpt-4o-mini";

const JOBS_COLL = "videoTranslateJobs";
const OPENROUTER_API_V1 =
	process.env.OPENROUTER_API_BASE?.trim() || "https://openrouter.ai/api/v1";
const OPENROUTER_CHAT = `${OPENROUTER_API_V1}/chat/completions`;
/** OpenAI-compatible speech endpoint (Gemini TTS, etc.); see OpenRouter TTS docs */
const OPENROUTER_AUDIO_SPEECH =
	process.env.OPENROUTER_AUDIO_SPEECH_URL?.trim() ||
	`${OPENROUTER_API_V1}/audio/speech`;

/** Max completion tokens for Gemini video JSON (reduces truncated / unterminated JSON). */
const OPENROUTER_VIDEO_GEMINI_MAX_TOKENS =
	Number.parseInt(process.env.OPENROUTER_VIDEO_GEMINI_MAX_TOKENS || "", 10) ||
	12288;

/** Default when `OPENROUTER_VIDEO_TTS_MODEL` unset: Gemini Flash TTS on OpenRouter (cheaper than gpt-audio for many clips). */
const DEFAULT_OPENROUTER_TTS_MODEL = "google/gemini-3.1-flash-tts-preview";

/** Max time an SSE client may wait for caption readiness (Firestore snapshot + terminal event). */
export const VIDEO_TRANSLATE_CAPTION_SSE_MAX_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_CAPTION_SSE_MAX_MS || "", 10) ||
	30 * 60 * 1000;

const utapi = new UTApi({ token: process.env.UPLOADTHING_TOKEN });

/** Read at call time so `.env` is loaded before caps are used (imports run before `dotenv.config()` in index.js). */
export function getMaxVideoBytes() {
	return (
		Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES || "", 10) ||
		200 * 1024 * 1024
	);
}

/** @deprecated use getMaxVideoBytes() — may be stale if read before dotenv loads */
export const MAX_VIDEO_BYTES = getMaxVideoBytes();
const OPENROUTER_VIDEO_TIMEOUT_MS =
	Number.parseInt(process.env.OPENROUTER_VIDEO_TIMEOUT_MS || "", 10) || 600_000;
const LONG_VIDEO_TRANSLATE_TIMEOUT_MS =
	Number.parseInt(process.env.LONG_VIDEO_TRANSLATE_TIMEOUT_MS || "", 10) ||
	90 * 60 * 1000;
/** Chunk length for /long ffmpeg split (seconds). Keep short — video Gemini is expensive. */
const LONG_VIDEO_CHUNK_SEC =
	Number.parseInt(process.env.LONG_VIDEO_CHUNK_SEC || "", 10) || 60;
/** How many chunk dubs to run at once inside a long job. */
const LONG_VIDEO_CHUNK_CONCURRENCY =
	Number.parseInt(process.env.LONG_VIDEO_CHUNK_CONCURRENCY || "", 10) || 2;
/**
 * Extra retries per chunk. Default 0 — retries re-bill OpenRouter on the same payload.
 * Provider 5xx / Internal Server Error is never retried.
 */
const LONG_VIDEO_CHUNK_RETRIES =
	Number.parseInt(process.env.LONG_VIDEO_CHUNK_RETRIES || "", 10) || 0;
/** How many SRT cues to translate per text LLM request. */
const LONG_VIDEO_TRANSLATE_BATCH_SIZE =
	Number.parseInt(process.env.LONG_VIDEO_TRANSLATE_BATCH_SIZE || "", 10) || 12;
/** Parallel TTS calls while building the full-length dub track. */
const LONG_VIDEO_TTS_CONCURRENCY =
	Number.parseInt(process.env.LONG_VIDEO_TTS_CONCURRENCY || "", 10) || 3;
/** Max chars when merging caption cues before TTS. */
const LONG_VIDEO_TTS_MERGE_CHARS =
	Number.parseInt(process.env.LONG_VIDEO_TTS_MERGE_CHARS || "", 10) || 480;
const LONG_ASR_AUDIO_MAX_BYTES =
	Number.parseInt(process.env.LONG_VIDEO_TRANSLATE_ASR_AUDIO_MAX_BYTES || "", 10) ||
	25 * 1024 * 1024;
const LONG_ASR_CHUNK_SEC =
	Number.parseInt(process.env.LONG_VIDEO_TRANSLATE_ASR_CHUNK_SEC || "", 10) ||
	120;

/** Subprocess timeout for yt-dlp (YouTube downloads can be slow). */
const YTDLP_TIMEOUT_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_YTDLP_TIMEOUT_MS || "", 10) ||
	20 * 60 * 1000;
const YTDLP_DEFAULT_USER_AGENT =
	process.env.VIDEO_TRANSLATE_YTDLP_USER_AGENT?.trim() ||
	process.env.VIDEO_TRANSLATE_DOWNLOAD_USER_AGENT?.trim() ||
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** @type {string | null} */
let cachedYtDlpCookiesPath = process.env.VIDEO_TRANSLATE_YTDLP_COOKIES?.trim() || null;
const FFPROBE_TIMEOUT_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_FFPROBE_TIMEOUT_MS || "", 10) ||
	30_000;
const TMP_SPACE_BASE_BUFFER_BYTES =
	Number.parseInt(process.env.VIDEO_TRANSLATE_TMP_SPACE_BUFFER_BYTES || "", 10) ||
	256 * 1024 * 1024;
const TMP_SPACE_MULTIPLIER =
	Number.parseFloat(process.env.VIDEO_TRANSLATE_TMP_SPACE_MULTIPLIER || "") || 3;
const TMP_SPACE_WAIT_TIMEOUT_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_TMP_SPACE_WAIT_TIMEOUT_MS || "", 10) ||
	120_000;
const TMP_SPACE_WAIT_POLL_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_TMP_SPACE_WAIT_POLL_MS || "", 10) ||
	3_000;
const VIDEO_TRANSLATE_MAX_CONCURRENT_JOBS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_CONCURRENT_JOBS || "", 10) || 2;

function getPlanCaps() {
	const defaultBytes = getMaxVideoBytes();
	return {
		free: {
			maxVideoBytes:
				Number.parseInt(
					process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES_FREE || "",
					10,
				) || defaultBytes,
			maxMinutes:
				Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_MINUTES_FREE || "", 10) ||
				10,
		},
		pro: {
			maxVideoBytes:
				Number.parseInt(
					process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES_PRO || "",
					10,
				) || defaultBytes,
			maxMinutes:
				Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_MINUTES_PRO || "", 10) ||
				30,
		},
		enterprise: {
			maxVideoBytes:
				Number.parseInt(
					process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES_ENTERPRISE || "",
					10,
				) || 1024 * 1024 * 1024,
			maxMinutes:
				Number.parseInt(
					process.env.VIDEO_TRANSLATE_MAX_MINUTES_ENTERPRISE || "",
					10,
				) || 120,
		},
	};
}

/** Raw PCM16 from OpenAI streaming TTS; default matches OpenAI docs (24 kHz mono). */
const TTS_PCM_SAMPLE_RATE =
	Number.parseInt(process.env.OPENROUTER_TTS_PCM_SAMPLE_RATE || "", 10) || 24000;
const TTS_PCM_CHANNELS =
	Number.parseInt(process.env.OPENROUTER_TTS_PCM_CHANNELS || "", 10) || 1;

/**
 * Wrap raw little-endian PCM16 audio in a WAV container (e.g. for UploadThing / browsers).
 */
export function pcm16ToWavBuffer(
	pcmBuffer,
	sampleRate = TTS_PCM_SAMPLE_RATE,
	numChannels = TTS_PCM_CHANNELS,
) {
	const bitsPerSample = 16;
	const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
	const blockAlign = (numChannels * bitsPerSample) / 8;
	const dataSize = pcmBuffer.length;
	const out = Buffer.alloc(44 + dataSize);
	out.write("RIFF", 0);
	out.writeUInt32LE(36 + dataSize, 4);
	out.write("WAVE", 8);
	out.write("fmt ", 12);
	out.writeUInt32LE(16, 16);
	out.writeUInt16LE(1, 20);
	out.writeUInt16LE(numChannels, 22);
	out.writeUInt32LE(sampleRate, 24);
	out.writeUInt32LE(byteRate, 28);
	out.writeUInt16LE(blockAlign, 32);
	out.writeUInt16LE(bitsPerSample, 34);
	out.write("data", 36);
	out.writeUInt32LE(dataSize, 40);
	pcmBuffer.copy(out, 44);
	return out;
}

/** Retries for source video fetch when CDN returns 429/502/503/504. */
const VIDEO_DOWNLOAD_MAX_ATTEMPTS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_DOWNLOAD_RETRIES || "", 10) || 5;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Truncate URL for logs/errors (no query secrets). */
function shortUrlForLog(url) {
	try {
		const u = new URL(String(url || ""));
		const path = u.pathname.length > 48 ? `${u.pathname.slice(0, 48)}…` : u.pathname;
		return `${u.host}${path}`;
	} catch {
		const s = String(url || "");
		return s.length > 80 ? `${s.slice(0, 80)}…` : s;
	}
}

/**
 * Tracks per-step / per-chunk status for /long jobs (console + throttled Firestore).
 * Frequent per-TTS flushes exhaust Firestore free-tier quota; keep writes sparse.
 */
function createLongStepTracker(jobId) {
	/** @type {Array<{ id: string, stage: string, index: number|null, status: string, error: string|null, detail: string|null, at: string }>} */
	const steps = [];
	let flushTimer = null;
	let dirty = false;
	let lastFlushAt = 0;
	const FLUSH_DEBOUNCE_MS = 5_000;
	const MIN_FLUSH_GAP_MS = 4_000;

	function snapshot() {
		// Cap payload size: keep stage summaries + all failures + last 20 rows.
		const failures = steps.filter((s) => s.status === "failed");
		const stages = ["download", "captions", "asr", "translate", "tts", "mux", "upload", "job"];
		const stageRows = stages
			.map((stage) => [...steps].reverse().find((s) => s.stage === stage && s.index == null))
			.filter(Boolean);
		const recent = steps.slice(-20);
		const byId = new Map();
		for (const s of [...stageRows, ...failures, ...recent]) {
			byId.set(s.id, s);
		}
		return [...byId.values()];
	}

	async function flush(extra = {}, { force = false } = {}) {
		dirty = false;
		flushTimer = null;
		const now = Date.now();
		if (!force && now - lastFlushAt < MIN_FLUSH_GAP_MS && Object.keys(extra).length === 0) {
			dirty = true;
			scheduleFlush();
			return false;
		}
		lastFlushAt = now;
		const payload = {
			step_results: snapshot(),
			chunk_results: snapshot().map((s, i) => ({
				index: s.index != null ? s.index : i,
				stage: s.stage,
				status: s.status,
				url: null,
				dubbed: s.status === "success" && s.stage === "tts",
				error: s.error,
				transcript: null,
				translation: null,
				detail: s.detail,
			})),
			...extra,
			updatedAt: FieldValue.serverTimestamp(),
		};
		const ok = await patchJobSafe(jobId, payload);
		if (!ok && extra?.status === "success") {
			// Minimal success write so the job doesn't stay "running" forever.
			const minimal = {
				status: "success",
				phase: "done",
				translated_video_url: extra.translated_video_url || null,
				final_video_url: extra.final_video_url || null,
				caption_url: extra.caption_url ?? null,
				caption_text: extra.caption_text ?? null,
				translated_transcript: extra.translated_transcript ?? null,
				transcript_original: extra.transcript_original ?? null,
				error: null,
				status_message:
					"Completed (Firestore quota limited; step_results truncated)",
				updatedAt: FieldValue.serverTimestamp(),
			};
			const ok2 = await patchJobSafe(jobId, minimal);
			if (!ok2) {
				console.error(
					`[videoTranslate-long] job ${jobId} CRITICAL: could not persist success to Firestore. Video URL: ${extra.translated_video_url || "unknown"}`,
				);
			}
			return ok2;
		}
		return ok;
	}

	function scheduleFlush() {
		dirty = true;
		if (flushTimer) return;
		flushTimer = setTimeout(() => {
			if (dirty) flush().catch(() => {});
		}, FLUSH_DEBOUNCE_MS);
	}

	/**
	 * @param {{ id: string, stage: string, index?: number|null, status: string, error?: string|null, detail?: string|null, persist?: boolean }} entry
	 */
	function upsert(entry) {
		const id = String(entry.id);
		const row = {
			id,
			stage: entry.stage,
			index: entry.index != null ? entry.index : null,
			status: entry.status,
			error: entry.error || null,
			detail: entry.detail || null,
			at: new Date().toISOString(),
		};
		const existing = steps.findIndex((s) => s.id === id);
		if (existing >= 0) steps[existing] = row;
		else steps.push(row);

		const tag = `[videoTranslate-long] job ${jobId} [${row.stage}${row.index != null ? `#${row.index}` : ""}] ${row.status}`;
		if (row.status === "failed") {
			console.error(`${tag} error=${row.error || "unknown"}${row.detail ? ` detail=${row.detail}` : ""}`);
		} else {
			console.log(`${tag}${row.detail ? ` — ${row.detail}` : ""}`);
		}

		// Persist stage-level rows and failures; skip noisy per-index success spam.
		const persist =
			entry.persist === true ||
			row.index == null ||
			row.status === "failed" ||
			row.status === "running" && row.index == null;
		if (persist) scheduleFlush();
		return row;
	}

	return {
		upsert,
		snapshot,
		flush: (extra) => flush(extra || {}, { force: true }),
		failCount: () => steps.filter((s) => s.status === "failed").length,
		successCount: () => steps.filter((s) => s.status === "success").length,
	};
}

function isFirestoreQuotaError(err) {
	const msg = String(err?.message || err || "");
	const code = err?.code;
	return (
		code === 8 ||
		code === "RESOURCE_EXHAUSTED" ||
		/RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg)
	);
}

/** Firestore update with short backoff on quota; never throws. */
async function patchJobSafe(docId, data) {
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			await patchJob(docId, data);
			return true;
		} catch (e) {
			const quota = isFirestoreQuotaError(e);
			console.warn(
				`[videoTranslate] patchJob ${docId} failed (attempt ${attempt + 1}/4): ${e?.message || e}`,
			);
			if (!quota || attempt === 3) return false;
			await sleep(1_500 * 2 ** attempt);
		}
	}
	return false;
}

/** Parse Retry-After header (seconds or HTTP-date). */
function parseRetryAfterMs(headers) {
	const raw = headers.get("retry-after");
	if (!raw) return null;
	const sec = Number.parseInt(raw, 10);
	if (!Number.isNaN(sec)) return sec * 1000;
	const t = Date.parse(raw);
	if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
	return null;
}

/**
 * Fetch video bytes with retries. CDNs (e.g. UploadThing) often return 429 when
 * many server-side fetches hit the same URL without backoff.
 */
async function fetchVideoBufferWithRetries(url, signal, maxVideoBytes) {
	const ua =
		process.env.VIDEO_TRANSLATE_DOWNLOAD_USER_AGENT?.trim() ||
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

	let lastStatus = 0;
	for (let attempt = 1; attempt <= VIDEO_DOWNLOAD_MAX_ATTEMPTS; attempt++) {
		if (signal?.aborted) {
			const e = new Error("Download aborted");
			e.name = "AbortError";
			throw e;
		}

		const res = await fetch(url, {
			signal,
			redirect: "follow",
			headers: {
				"User-Agent": ua,
				Accept: "video/mp4,video/*,*/*;q=0.8",
			},
		});

		if (res.ok) {
			const len = res.headers.get("content-length");
			if (len && Number(len) > maxVideoBytes) {
				throw new Error("Video file too large (content-length)");
			}
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length > maxVideoBytes) {
				throw new Error(`Video exceeds plan byte limit (${maxVideoBytes} bytes)`);
			}
			return buf;
		}

		lastStatus = res.status;
		try {
			await res.arrayBuffer();
		} catch {
			/* ignore drain errors */
		}

		const retryable =
			res.status === 429 ||
			res.status === 502 ||
			res.status === 503 ||
			res.status === 504;
		if (!retryable || attempt === VIDEO_DOWNLOAD_MAX_ATTEMPTS) {
			const hint = shortUrlForLog(url);
			console.error(
				`[videoTranslate] download failed HTTP ${res.status} after ${attempt} attempt(s) url=${hint}`,
			);
			throw new Error(
				`Failed to download video: HTTP ${res.status} (${hint})`,
			);
		}

		const serverWait = parseRetryAfterMs(res.headers);
		const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1));
		const waitMs =
			serverWait != null ? Math.min(serverWait, 60_000) : backoff;
		const jitter = Math.floor(Math.random() * 400);
		await sleep(waitMs + jitter);
	}

	throw new Error(`Failed to download video: HTTP ${lastStatus}`);
}

function normalizePlanKey(raw) {
	const s = String(raw || "")
		.trim()
		.toLowerCase();
	if (!s) return "free";
	if (["pro", "paid", "plus", "premium"].includes(s)) return "pro";
	if (["enterprise", "team", "business"].includes(s)) return "enterprise";
	return "free";
}

export function resolvePlanCaps(rawPlan) {
	const plan = normalizePlanKey(rawPlan);
	const caps = getPlanCaps()[plan] || getPlanCaps().free;
	return {
		plan,
		maxVideoBytes: caps.maxVideoBytes,
		maxMinutes: caps.maxMinutes,
	};
}

async function getTmpFreeBytes() {
	try {
		if (typeof fsp.statfs !== "function") return null;
		const stat = await fsp.statfs(os.tmpdir());
		return Number(stat.bavail) * Number(stat.bsize);
	} catch {
		return null;
	}
}

async function ensureTmpHasSpace(requiredBytes, stageLabel) {
	const freeBytes = await getTmpFreeBytes();
	if (freeBytes == null) return;
	if (freeBytes < requiredBytes) {
		throw new Error(
			`Insufficient temp disk space in ${os.tmpdir()} for ${stageLabel}. Required ${requiredBytes} bytes, available ${freeBytes} bytes.`,
		);
	}
}

export async function waitForTmpSpace(requiredBytes, stageLabel, signal) {
	const deadline = Date.now() + Math.max(0, TMP_SPACE_WAIT_TIMEOUT_MS);
	for (;;) {
		if (signal?.aborted) {
			const e = new Error("Temp-space wait aborted");
			e.name = "AbortError";
			throw e;
		}
		const freeBytes = await getTmpFreeBytes();
		if (freeBytes == null || freeBytes >= requiredBytes) return;
		if (Date.now() >= deadline) {
			throw new Error(
				`Insufficient temp disk space in ${os.tmpdir()} for ${stageLabel}. Required ${requiredBytes} bytes, available ${freeBytes} bytes.`,
			);
		}
		await sleep(Math.max(250, TMP_SPACE_WAIT_POLL_MS));
	}
}

let activeVideoJobs = 0;
const videoJobWaiters = [];

export async function acquireVideoJobSlot(signal) {
	if (activeVideoJobs < VIDEO_TRANSLATE_MAX_CONCURRENT_JOBS) {
		activeVideoJobs += 1;
		return;
	}
	await new Promise((resolve, reject) => {
		const waiter = { resolve, reject };
		videoJobWaiters.push(waiter);
		const abort = () => {
			const i = videoJobWaiters.indexOf(waiter);
			if (i >= 0) videoJobWaiters.splice(i, 1);
			const e = new Error("Video job queue wait aborted");
			e.name = "AbortError";
			reject(e);
		};
		if (signal) {
			if (signal.aborted) return abort();
			signal.addEventListener("abort", abort, { once: true });
		}
	});
	activeVideoJobs += 1;
}

export function releaseVideoJobSlot() {
	activeVideoJobs = Math.max(0, activeVideoJobs - 1);
	const next = videoJobWaiters.shift();
	if (next) next.resolve();
}

async function getMediaDurationSeconds(filePath) {
	const ffprobe = getFfprobeBin();
	try {
		const out = await new Promise((resolve, reject) => {
			execFile(
				ffprobe,
				[
					"-v",
					"error",
					"-show_entries",
					"format=duration",
					"-of",
					"json",
					filePath,
				],
				{ timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
				(err, stdout) => {
					if (err) return reject(err);
					resolve(stdout);
				},
			);
		});
		const parsed = JSON.parse(String(out || "{}"));
		const dur = Number(parsed?.format?.duration);
		if (Number.isFinite(dur) && dur > 0) return dur;
	} catch {
		// Fallback below.
	}

	// Fallback: parse ffmpeg stderr "Duration: HH:MM:SS.xx"
	const ffmpeg = getFfmpegBin();
	const stderr = await new Promise((resolve, reject) => {
		execFile(
			ffmpeg,
			["-i", filePath],
			{ timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
			(_err, _stdout, se) => {
				resolve(String(se || ""));
			},
		);
	}).catch(() => "");
	const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
	if (!m) return null;
	const hh = Number(m[1]);
	const mm = Number(m[2]);
	const ss = Number(m[3]);
	if (!Number.isFinite(hh + mm + ss)) return null;
	return hh * 3600 + mm * 60 + ss;
}

async function enforceDurationLimit(videoPath, maxMinutes, knownDurationSec) {
	if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) return;
	let secs = await getMediaDurationSeconds(videoPath);
	if (
		(secs == null || !Number.isFinite(secs) || secs <= 0) &&
		Number.isFinite(knownDurationSec) &&
		knownDurationSec > 0
	) {
		secs = knownDurationSec;
		console.log(
			`[videoTranslate] using RapidAPI duration ${Math.ceil(secs)}s (ffprobe/ffmpeg unavailable)`,
		);
	}
	if (secs == null || !Number.isFinite(secs) || secs <= 0) {
		throw new Error(
			"Unable to determine video duration for plan validation (ffprobe/ffmpeg metadata unavailable).",
		);
	}
	const maxSecs = maxMinutes * 60;
	if (secs > maxSecs) {
		throw new Error(
			`Video duration exceeds plan limit: ${Math.ceil(secs)}s > ${maxSecs}s (${maxMinutes} min).`,
		);
	}
}

/**
 * URLs that point at a browser page / player, not a raw media file — plain HTTP fetch would get HTML.
 * YouTube uses RapidAPI; X/Twitter still use yt-dlp.
 */
function isYtDlpPageVideoUrl(url) {
	if (!url || typeof url !== "string") return false;
	const u = url.trim();
	if (isYoutubeVideoUrl(u)) return false;
	let host = "";
	try {
		host = new URL(u).hostname.replace(/^www\./i, "").toLowerCase();
	} catch {
		return false;
	}
	const ytDlpHosts = new Set([
		"x.com",
		"twitter.com",
		"mobile.twitter.com",
	]);
	return ytDlpHosts.has(host);
}

async function pickLargestVideoFileInDir(dir) {
	const names = await fsp.readdir(dir);
	let bestPath = null;
	let bestSize = 0;
	for (const name of names) {
		if (!/\.(mp4|webm|mkv|mov|m4v)$/i.test(name)) continue;
		const p = path.join(dir, name);
		const st = await fsp.stat(p);
		if (!st.isFile()) continue;
		if (st.size > bestSize) {
			bestSize = st.size;
			bestPath = p;
		}
	}
	if (!bestPath) {
		throw new Error(
			"yt-dlp did not produce a video file (check URL, format, or VIDEO_TRANSLATE_YTDLP_FORMAT)",
		);
	}
	return bestPath;
}

function resolveYtDlpBinary() {
	const customBin = process.env.VIDEO_TRANSLATE_YTDLP_BINARY?.trim();
	if (customBin) {
		if (existsSync(customBin)) return customBin;
		console.warn(
			`[yt-dlp] VIDEO_TRANSLATE_YTDLP_BINARY not found at ${customBin}; trying system paths`,
		);
	}
	for (const p of [
		"/usr/bin/yt-dlp",
		"/usr/local/bin/yt-dlp",
		"/opt/homebrew/bin/yt-dlp",
	]) {
		if (existsSync(p)) return p;
	}
	return null;
}

function parseYtDlpPlayerClients(forCookies = false) {
	const raw = process.env.VIDEO_TRANSLATE_YTDLP_PLAYER_CLIENTS?.trim();
	if (raw) {
		return raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	if (forCookies) {
		return ["web", "mweb", "ios", "android"];
	}
	return ["android", "tv_embedded", "web", "mweb", "ios"];
}

function isYtDlpBotOrSignInError(stderr) {
	return /not a bot|sign in to confirm|confirm you.?re not a bot/i.test(
		String(stderr || ""),
	);
}

async function resolveYtDlpCookiesPath() {
	const filePath = process.env.VIDEO_TRANSLATE_YTDLP_COOKIES?.trim();
	if (filePath && existsSync(filePath)) return filePath;

	const b64Raw = process.env.VIDEO_TRANSLATE_YTDLP_COOKIES_B64?.trim();
	if (!b64Raw) return null;

	if (cachedYtDlpCookiesPath && existsSync(cachedYtDlpCookiesPath)) {
		return cachedYtDlpCookiesPath;
	}

	try {
		/** Fly secrets paste may include newlines — strip before decode. */
		const b64 = b64Raw.replace(/\s/g, "");
		const buf = Buffer.from(b64, "base64");
		const text = buf.toString("utf8");
		if (!text.includes(".youtube.com") && !text.includes("youtube.com")) {
			console.error(
				"[yt-dlp] VIDEO_TRANSLATE_YTDLP_COOKIES_B64 decoded but contains no youtube.com cookies — re-encode yt-cookies.txt",
			);
			return null;
		}
		const entryCount = text
			.split("\n")
			.filter((line) => line.trim() && !line.startsWith("#")).length;
		if (entryCount === 0) {
			console.error(
				"[yt-dlp] VIDEO_TRANSLATE_YTDLP_COOKIES_B64 decoded empty — re-export cookies.txt",
			);
			return null;
		}
		const hasSession = /\t(SID|LOGIN_INFO|__Secure-1PSID)\t/i.test(text);
		if (!hasSession) {
			console.warn(
				"[yt-dlp] cookies file missing SID/LOGIN_INFO — export while logged into YouTube in browser",
			);
		}
		const dest = path.join(os.tmpdir(), "aantra-yt-dlp-cookies.txt");
		await fsp.writeFile(dest, text, { mode: 0o600, encoding: "utf8" });
		cachedYtDlpCookiesPath = dest;
		console.log(
			`[yt-dlp] loaded cookies from VIDEO_TRANSLATE_YTDLP_COOKIES_B64 → ${dest} (${entryCount} entries, session=${hasSession ? "yes" : "no"})`,
		);
		return dest;
	} catch (e) {
		console.error(
			"[yt-dlp] invalid VIDEO_TRANSLATE_YTDLP_COOKIES_B64:",
			e?.message || e,
		);
		return null;
	}
}

/** Log cookie readiness at server startup (Fly: confirms B64 secret decoded). */
export async function logYtDlpCookiesAtStartup() {
	const cookiesPath = await resolveYtDlpCookiesPath();
	if (cookiesPath) {
		console.log(`[yt-dlp] startup: YouTube cookies ready at ${cookiesPath}`);
	} else if (
		process.env.VIDEO_TRANSLATE_YTDLP_COOKIES_B64?.trim() ||
		process.env.VIDEO_TRANSLATE_YTDLP_COOKIES?.trim()
	) {
		console.error(
			"[yt-dlp] startup: VIDEO_TRANSLATE_YTDLP_COOKIES* is set but cookies failed to load — check base64 encoding",
		);
	}
}

async function removePartialVideoDownloadsInDir(dir) {
	try {
		const names = await fsp.readdir(dir);
		await Promise.all(
			names
				.filter((n) => /\.(mp4|webm|mkv|mov|m4v|part|ytdl)$/i.test(n))
				.map((n) => fsp.unlink(path.join(dir, n)).catch(() => {})),
		);
	} catch {
		/* ignore */
	}
}

function formatYtDlpDownloadError(
	e,
	{ hadCookies, triedClients, usedProxy, triedCookiesDirect, proxyAuthFailed },
) {
	const tail = e?.stderr ? String(e.stderr).slice(-2500) : "";
	const base = tail || e?.message || String(e);
	if (proxyAuthFailed && triedCookiesDirect) {
		return new Error(
			`Video download failed (yt-dlp). Browser cookies did not succeed and Bright Data proxy auth failed (407). ` +
				`Re-export VIDEO_TRANSLATE_YTDLP_COOKIES_B64 on Fly, or fix BRIGHTDATA_PROXY_PASSWORD, or set VIDEO_TRANSLATE_PROXY_ENABLED=0 to use cookies only. ` +
				`Original: ${base.slice(-600)}`,
		);
	}
	if (usedProxy && isProxyIpBlacklistedError(base)) {
		return new Error(
			`Video download failed (yt-dlp). Bright Data rejected this IP (ip_blacklisted). Original: ${base.slice(-600)}`,
		);
	}
	if (usedProxy && isProxyAuthError(base)) {
		return new Error(
			`Video download failed (yt-dlp). Bright Data proxy authentication failed (407). ` +
				`Verify BRIGHTDATA_PROXY_PASSWORD (zone password) and BRIGHTDATA_PROXY_USERNAME on Fly, or set VIDEO_TRANSLATE_PROXY_ENABLED=0 when using cookies. ` +
				`Original: ${base.slice(-600)}`,
		);
	}
	if (hadCookies && triedCookiesDirect && !usedProxy && isYtDlpBotOrSignInError(base)) {
		return new Error(
			`Video download failed (yt-dlp). YouTube bot check on Fly datacenter IP — browser cookies alone cannot fix this ` +
				`(cookies are tied to your home IP, not Fly). Use a working Bright Data residential proxy with ` +
				`VIDEO_TRANSLATE_PROXY_FALLBACK=1 (default) and fix BRIGHTDATA_PROXY_PASSWORD on Fly, or upload the video file directly. ` +
				`Original: ${base.slice(-600)}`,
		);
	}
	if (hadCookies && triedCookiesDirect && !usedProxy) {
		return new Error(
			`Video download failed (yt-dlp) with browser cookies (direct, no proxy). ` +
				`Original: ${base.slice(-600)}`,
		);
	}
	if (isYtDlpBotOrSignInError(base) && !hadCookies && !usedProxy) {
		return new Error(
			`Video download failed (yt-dlp). YouTube blocked the server IP (bot check). ` +
				`Tried player clients: ${(triedClients || []).join(", ")}. ` +
				`Set VIDEO_TRANSLATE_YTDLP_COOKIES_B64 or BRIGHTDATA_PROXY_* on Fly. Original: ${base.slice(-800)}`,
		);
	}
	return new Error(`Video download failed (yt-dlp). ${base.slice(-800)}`);
}

/** Ordered download phases: cookies+direct, then cookies+proxy, then proxy-only. */
function buildYtDlpDownloadPhases(cookiesPath, useProxyPool, proxyManager, envProxy) {
	const phases = [];
	const hasCookies = Boolean(cookiesPath);
	const cookiesPreferDirect = preferDirectYtDlpWhenCookiesConfigured(hasCookies);

	if (cookiesPreferDirect) {
		phases.push({ type: "direct", id: "cookies-direct", useCookies: true });
	}

	const fallbackFlag = String(
		process.env.VIDEO_TRANSLATE_PROXY_FALLBACK || "",
	)
		.trim()
		.toLowerCase();
	/** Proxy fallback after cookies is ON by default when a pool exists. Set VIDEO_TRANSLATE_PROXY_FALLBACK=0 to disable. */
	const allowProxyFallback =
		!cookiesPreferDirect ||
		!(fallbackFlag === "0" || fallbackFlag === "false" || fallbackFlag === "no");

	const hasProxyPool = useProxyPool && proxyManager.hasProxies();

	if (allowProxyFallback && hasProxyPool) {
		phases.push({
			type: "pool",
			id: "cookies-proxy",
			useCookies: true,
		});
		phases.push({
			type: "pool",
			id: "proxy-only",
			useCookies: false,
		});
	} else if (allowProxyFallback && useProxyPool && envProxy) {
		phases.push({ type: "env", id: "cookies-env-proxy", useCookies: true, proxyUrl: envProxy });
		phases.push({ type: "env", id: "proxy-only-env", useCookies: false, proxyUrl: envProxy });
	} else if (!cookiesPreferDirect && hasProxyPool) {
		const poolRotations = getVideoTranslateProxyMaxRotations(proxyManager.count);
		for (let i = 0; i < poolRotations; i++) {
			phases.push({ type: "pool", id: `proxy-pool-${i + 1}`, useCookies: hasCookies });
		}
	}

	if (phases.length === 0) {
		phases.push({ type: "direct", id: "direct", useCookies: hasCookies });
	}

	return phases;
}

function shouldRotateProxyAfterYtDlpError(stderr) {
	const s = String(stderr || "");
	return (
		isProxyAuthError(s) ||
		isYtDlpBotOrSignInError(s) ||
		/unable to extract|player response|403|429|blocked|proxy/i.test(s)
	);
}

/**
 * Download via yt-dlp for page URLs (YouTube, X/Twitter, etc.).
 * Rotates Bright Data / VIDEO_TRANSLATE_PROXIES_JSON pool when configured.
 */
async function downloadViaYtDlp(url, signal, tmpDir, maxVideoBytes) {
	const ytDlpBin = resolveYtDlpBinary();
	const dl = ytDlpBin ? createYoutubeDl(ytDlpBin) : youtubedl;

	const format =
		process.env.VIDEO_TRANSLATE_YTDLP_FORMAT?.trim() ||
		"bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[ext=mp4]/best[height<=720]";

	const maxMb = Math.max(1, Math.floor(maxVideoBytes / (1024 * 1024)));
	const cookiesPath = await resolveYtDlpCookiesPath();
	const trimmedUrl = url.trim();
	const isYoutube = isYoutubeVideoUrl(trimmedUrl);
	const playerClientsDefault = isYoutube ? parseYtDlpPlayerClients(false) : [null];
	const playerClientsWithCookies = isYoutube ? parseYtDlpPlayerClients(true) : [null];

	const useProxyPool = shouldUseVideoTranslateProxies();
	const envProxy =
		useProxyPool && process.env.VIDEO_TRANSLATE_YTDLP_PROXY?.trim()
			? process.env.VIDEO_TRANSLATE_YTDLP_PROXY.trim()
			: null;
	const proxyManager = getVideoTranslateProxyManager();
	const phases = buildYtDlpDownloadPhases(
		cookiesPath,
		useProxyPool,
		proxyManager,
		envProxy,
	);

	if (cookiesPath && preferDirectYtDlpWhenCookiesConfigured(true)) {
		const proxyFallbackOff = ["0", "false", "no"].includes(
			String(process.env.VIDEO_TRANSLATE_PROXY_FALLBACK || "")
				.trim()
				.toLowerCase(),
		);
		const hasProxy = useProxyPool && proxyManager.hasProxies();
		console.log(
			`[yt-dlp] browser cookies loaded — phases: ${phases.map((p) => p.id).join(" → ")}` +
				(hasProxy && !proxyFallbackOff
					? ""
					: hasProxy
						? " (proxy fallback disabled via VIDEO_TRANSLATE_PROXY_FALLBACK=0)"
						: " (no Bright Data pool — cookies-only on datacenter IP often fails bot check)"),
		);
	} else if (!useProxyPool && proxyManager.hasProxies()) {
		console.log(
			"[yt-dlp] Bright Data pool configured but skipped locally — direct download (set VIDEO_TRANSLATE_PROXY_ENABLED=1 to force proxy)",
		);
	}

	const baseExecOpts = {
		output: path.join(tmpDir, "input.%(ext)s"),
		format,
		mergeOutputFormat: "mp4",
		noPlaylist: true,
		noWarnings: true,
		maxFilesize: `${maxMb}M`,
		userAgent: YTDLP_DEFAULT_USER_AGENT,
	};

	let lastErr = null;
	let usedProxy = false;
	let triedCookiesDirect = false;
	let proxyAuthFailed = false;
	let succeeded = false;

	for (let phaseIdx = 0; phaseIdx < phases.length && !succeeded; phaseIdx++) {
		const phase = phases[phaseIdx];
		let proxy = null;
		let proxyUrl = null;
		const phaseUseCookies =
			phase.useCookies !== false && Boolean(cookiesPath);
		const playerClients =
			phaseUseCookies && isYoutube
				? playerClientsWithCookies
				: playerClientsDefault;

		if (phase.type === "direct") {
			if (phase.id === "cookies-direct") triedCookiesDirect = true;
		} else if (phase.type === "pool") {
			proxy = proxyManager.getNextProxy();
			proxyUrl = proxy ? buildYtDlpProxyUrl(proxy) : null;
			if (!proxy) continue;
		} else if (phase.type === "env") {
			proxyUrl = phase.proxyUrl;
		}

		if (phaseIdx > 0 && lastErr) {
			console.log(
				`[yt-dlp] phase "${phases[phaseIdx - 1].id}" failed — trying "${phase.id}"`,
			);
		}

		phaseAttempt: for (let i = 0; i < playerClients.length; i++) {
			const client = playerClients[i];
			const proxyModes = proxy ? ["url", "header"] : ["url"];

			for (let modeIdx = 0; modeIdx < proxyModes.length; modeIdx++) {
				const proxyMode = proxyModes[modeIdx];
				const execOpts = {
					...baseExecOpts,
					...(phaseUseCookies && cookiesPath ? { cookies: cookiesPath } : {}),
				};
				if (client) {
					execOpts.extractorArgs = `youtube:player_client=${client}`;
				}
				const attemptUsedProxy = Boolean(proxyUrl);
				if (proxyUrl && proxy) {
					Object.assign(execOpts, buildYtDlpProxyExecOptions(proxy, proxyMode));
				} else if (proxyUrl) {
					execOpts.proxy = proxyUrl;
				}

				const started = Date.now();
				try {
					console.log(
						`[yt-dlp] phase=${phase.id} proxy=${proxy ? proxyPoolKey(proxy) : proxyUrl ? "env" : "none"} auth=${proxyMode} client=${client || "default"} cookies=${phaseUseCookies ? "yes" : "no"}`,
					);
					await dl.exec(trimmedUrl, execOpts, {
						timeout: YTDLP_TIMEOUT_MS,
						signal,
					});
					if (proxy) {
						proxyManager.recordProxyResult(
							proxy,
							true,
							Date.now() - started,
						);
					}
					lastErr = null;
					usedProxy = attemptUsedProxy;
					succeeded = true;
					break phaseAttempt;
				} catch (e) {
					lastErr = e;
					const stderr = String(e?.stderr || e?.message || "");
					if (attemptUsedProxy && isProxyAuthError(stderr)) {
						proxyAuthFailed = true;
					}
					console.warn(
						`[yt-dlp] failed phase=${phase.id} proxy=${proxy ? proxyPoolKey(proxy) : "none"} auth=${proxyMode} client=${client || "default"}: ${stderr.slice(-500)}`,
					);
					if (proxy) {
						proxyManager.recordProxyResult(
							proxy,
							false,
							Date.now() - started,
						);
					}
					await removePartialVideoDownloadsInDir(tmpDir);

					if (
						proxy &&
						proxyMode === "url" &&
						isProxyAuthError(stderr) &&
						modeIdx + 1 < proxyModes.length
					) {
						console.log(
							`[yt-dlp] retrying ${proxyPoolKey(proxy)} with Proxy-Authorization header auth`,
						);
						continue;
					}

					const retryClient =
						isYoutube &&
						i < playerClients.length - 1 &&
						!shouldRotateProxyAfterYtDlpError(stderr) &&
						(isYtDlpBotOrSignInError(stderr) ||
							/unable to extract|player response/i.test(stderr));
					if (retryClient) {
						modeIdx = proxyModes.length;
						break;
					}

					if (!retryClient) {
						modeIdx = proxyModes.length;
						if (i >= playerClients.length - 1) break;
					}
				}
			}
		}
	}

	if (lastErr) {
		throw formatYtDlpDownloadError(lastErr, {
			hadCookies: Boolean(cookiesPath),
			triedClients: playerClientsDefault.map((c) => c || "default"),
			usedProxy,
			triedCookiesDirect,
			proxyAuthFailed,
		});
	}

	const videoPath = await pickLargestVideoFileInDir(tmpDir);
	const buf = await fsp.readFile(videoPath);
	if (buf.length > maxVideoBytes) {
		throw new Error(
			`Video exceeds plan byte limit (${maxVideoBytes} bytes)`,
		);
	}
	return { buf, videoPath };
}

/**
 * Download YouTube via RapidAPI (YouTube Download & Info API), then fetch MP4 bytes.
 */
async function downloadViaRapidApi(url, signal, tmpDir, maxVideoBytes, maxMinutes) {
	const media = await resolveYoutubeRapidApiMedia(url, signal);
	const knownDurationSec =
		media.durationSec != null && Number.isFinite(media.durationSec)
			? media.durationSec
			: null;

	if (
		knownDurationSec != null &&
		Number.isFinite(maxMinutes) &&
		maxMinutes > 0 &&
		knownDurationSec > maxMinutes * 60
	) {
		throw new Error(
			`Video duration exceeds plan limit: ${Math.ceil(knownDurationSec)}s > ${maxMinutes * 60}s (${maxMinutes} min).`,
		);
	}

	let buf;
	if (media.kind === "buffer") {
		buf = media.buffer;
	} else {
		buf = await fetchVideoBufferWithRetries(media.url, signal, maxVideoBytes);
	}
	if (buf.length > maxVideoBytes) {
		throw new Error(
			`Video exceeds plan byte limit (${maxVideoBytes} bytes)`,
		);
	}
	assertValidVideoBuffer(buf);
	const videoPath = path.join(tmpDir, "input.mp4");
	await fsp.writeFile(videoPath, buf);
	return { buf, videoPath, durationSec: knownDurationSec };
}

function getOpenRouterKey() {
	return process.env.OPENROUTER_API_KEY?.trim() || "";
}

/** Gemini on OpenRouter: use video-capable model; non-YouTube URLs must be sent as base64 data URLs in video_url. */
function geminiVideoModel() {
	return (
		process.env.OPENROUTER_VIDEO_GEMINI_MODEL?.trim() ||
		"google/gemini-2.5-flash"
	);
}

function ttsModel() {
	return (
		process.env.OPENROUTER_VIDEO_TTS_MODEL?.trim() || DEFAULT_OPENROUTER_TTS_MODEL
	);
}

function openRouterFetchHeaders() {
	const key = getOpenRouterKey();
	const h = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${key}`,
	};
	/** OpenRouter recommends Referer; missing header sometimes yields generic provider errors for audio routes. */
	const ref = process.env.OPENROUTER_HTTP_REFERER?.trim();
	h.Referer = ref || "https://openrouter.ai";
	const title = process.env.OPENROUTER_APP_TITLE?.trim();
	if (title) h["X-Title"] = title;
	return h;
}

function formatOpenRouterHttpError(status, bodyText) {
	const raw = String(bodyText || "").slice(0, 4000);
	try {
		const j = JSON.parse(raw);
		const e = j.error;
		if (e && typeof e === "object") {
			return `${JSON.stringify(e)}`;
		}
		return String(e?.message || e || raw);
	} catch {
		return raw || `HTTP ${status}`;
	}
}

export async function execFfmpeg(args, label) {
	const ffmpeg = getFfmpegBin();
	await new Promise((resolve, reject) => {
		execFile(
			ffmpeg,
			args,
			{ timeout: 300_000, maxBuffer: 20 * 1024 * 1024 },
			(err, _stdout, stderr) => {
				if (err) {
					const se = stderr ? String(stderr).slice(0, 3000) : "";
					const hint =
						err.code === "ENOENT"
							? " Install ffmpeg or set FFMPEG_PATH to an existing binary (`which ffmpeg`; Homebrew is often /opt/homebrew/bin/ffmpeg)."
							: "";
					reject(
						new Error(
							`${label}: ${err.message}${hint}${se ? `\nffmpeg stderr:\n${se}` : ""}`,
						),
					);
					return;
				}
				resolve();
			},
		);
	});
}

/**
 * Models routed to OpenRouter `POST /audio/speech` (raw pcm/mp3 stream). Others use chat completions + streaming audio deltas (gpt-audio).
 */
function usesOpenRouterSpeechApi(modelId) {
	const m = String(modelId || "").toLowerCase();
	if (!m) return false;
	/* Gemini TTS slugs (`...-tts-preview`), OpenAI `...-tts-...`, Mistral Voxtral TTS, etc. */
	return m.includes("-tts");
}


/**
 * Build TTS fallback entries from OpenRouter model ids.
 * @param {string[]} modelIds
 * @returns {{ model: string, format?: string }[]}
 */
export function buildTtsFallbackEntries(modelIds) {
	const seen = new Set();
	const out = [];
	for (const raw of modelIds) {
		const model = String(raw || "").trim();
		if (!model || seen.has(model)) continue;
		seen.add(model);
		out.push(
			usesOpenRouterSpeechApi(model)
				? { model }
				: { model, format: "pcm16" },
		);
	}
	return out;
}

function buildTtsFallbackList() {
	const custom = process.env.OPENROUTER_VIDEO_TTS_MODEL?.trim();
	const core = [
		{ model: DEFAULT_OPENROUTER_TTS_MODEL },
		{ model: "openai/gpt-audio-mini", format: "pcm16" },
		{ model: "openai/gpt-audio", format: "pcm16" },
	];
	if (custom) {
		const prepend = usesOpenRouterSpeechApi(custom)
			? [{ model: custom }]
			: [{ model: custom, format: "pcm16" }];
		const seen = new Set();
		const out = [];
		for (const x of [...prepend, ...core]) {
			const k = x.model;
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(x);
		}
		return out;
	}
	return core;
}

/**
 * OpenRouter OpenAI-compatible TTS endpoint → raw pcm (default 24 kHz mono s16le for Gemini TTS).
 */
async function ttsSingleAttemptSpeechApi({ text, model, signal, voice }) {
	const resolvedVoice =
		voice?.trim() ||
		process.env.OPENROUTER_VIDEO_TTS_VOICE?.trim() ||
		process.env.OPENROUTER_TTS_VOICE?.trim() ||
		"Puck";
	const res = await fetch(OPENROUTER_AUDIO_SPEECH, {
		method: "POST",
		signal,
		headers: openRouterFetchHeaders(),
		body: JSON.stringify({
			model,
			input: text,
			voice: resolvedVoice,
			response_format: "pcm",
		}),
	});

	if (!res.ok) {
		let errText = "";
		try {
			errText = await res.text();
		} catch {
			/* ignore */
		}
		throw new Error(
			`OpenRouter speech TTS (${model}) HTTP ${res.status}: ${String(errText).slice(0, 1500)}`,
		);
	}

	const buf = Buffer.from(await res.arrayBuffer());
	if (!buf.length) {
		throw new Error(`OpenRouter speech TTS (${model}) returned empty body`);
	}
	return { buffer: buf, usage: null };
}

function splitTextIntoTtsChunks(text, maxLen) {
	const t = String(text || "").trim();
	if (t.length <= maxLen) return [t];
	const chunks = [];
	let i = 0;
	while (i < t.length) {
		let end = Math.min(i + maxLen, t.length);
		if (end < t.length) {
			const cut = t.lastIndexOf(". ", end);
			const cut2 = t.lastIndexOf("\n", end);
			const best = Math.max(cut, cut2);
			if (best > i + maxLen * 0.4) end = best + 1;
		}
		chunks.push(t.slice(i, end).trim());
		i = end;
	}
	return chunks.filter(Boolean);
}

async function readSseAudioStream(reader, decoder, onErrorPayload) {
	let sseBuffer = "";
	const audioChunks = [];
	/** OpenRouter sends `usage` on the last streaming chunk (includes `cost` in USD when available). */
	let lastUsage = null;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		sseBuffer += decoder.decode(value, { stream: true });
		const lines = sseBuffer.split("\n");
		sseBuffer = lines.pop() || "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("data: ")) continue;
			const payload = trimmed.slice(6).trim();
			if (payload === "[DONE]") continue;
			let parsed;
			try {
				parsed = JSON.parse(payload);
			} catch {
				continue;
			}
			if (parsed.error) {
				onErrorPayload(parsed.error);
			}
			if (parsed.usage) lastUsage = parsed.usage;
			const audio = parsed?.choices?.[0]?.delta?.audio;
			if (audio?.data) audioChunks.push(audio.data);
		}
	}
	return { audioChunks, usage: lastUsage };
}

/**
 * Single TTS attempt: OpenRouter `/audio/speech` (Gemini TTS, etc.) or chat stream (gpt-audio).
 */
async function ttsSingleAttempt({ text, model, format, signal, voice }) {
	if (usesOpenRouterSpeechApi(model)) {
		return ttsSingleAttemptSpeechApi({ text, model, signal, voice });
	}
	const fmt = format || "pcm16";
	const chatVoice = voiceForOpenAiChatTts(voice);
	const res = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterFetchHeaders(),
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "user",
					content: `Speak the following narration clearly and naturally for video dubbing, with no introduction or preamble. Only the spoken words:\n\n${text}`,
				},
			],
			modalities: ["text", "audio"],
			audio: { voice: chatVoice, format: fmt },
			stream: true,
		}),
	});

	if (!res.ok) {
		const bodyText = await res.text();
		throw new Error(formatOpenRouterHttpError(res.status, bodyText));
	}

	if (!res.body) throw new Error("TTS: empty response body");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let streamErr;
	const { audioChunks, usage } = await readSseAudioStream(reader, decoder, (e) => {
		streamErr = e;
	});
	if (streamErr) {
		throw new Error(
			typeof streamErr === "object"
				? JSON.stringify(streamErr)
				: String(streamErr),
		);
	}
	if (!audioChunks.length) {
		throw new Error(
			"No audio chunks in TTS stream (empty or unsupported modality for this model)",
		);
	}
	return {
		buffer: Buffer.from(audioChunks.join(""), "base64"),
		usage,
	};
}

/**
 * gpt-audio streaming or OpenRouter `/audio/speech` (Gemini TTS); optional chunking + ffmpeg concat raw PCM.
 * Exported for text-only voice translation (OpenRouter TTS).
 */
export async function ttsSynthesizeToBuffer({ text, signal, voice, fallbackModels }) {
	const fallbacks =
		Array.isArray(fallbackModels) && fallbackModels.length
			? fallbackModels
			: buildTtsFallbackList();
	const chunks = splitTextIntoTtsChunks(text, 2800);
	let lastErr = "";

	for (const entry of fallbacks) {
		const { model, format } = entry;
		try {
			const ext = "pcm";
			if (chunks.length === 1) {
				const { buffer: buf, usage: u0 } = await ttsSingleAttempt({
					text: chunks[0],
					model,
					format,
					signal,
					voice,
				});
				return { buffer: buf, format: "pcm16", usage: u0, modelUsed: model };
			}
			const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vt-tts-"));
			try {
				const paths = [];
				let mergedTtsUsage = normalizeOpenRouterUsage(null);
				for (let i = 0; i < chunks.length; i++) {
					const { buffer: buf, usage: uPart } = await ttsSingleAttempt({
						text: chunks[i],
						model,
						format,
						signal,
						voice,
					});
					mergedTtsUsage = mergeOpenRouterUsage(mergedTtsUsage, uPart);
					const p = path.join(tmpDir, `p${i}.${ext}`);
					await fsp.writeFile(p, buf);
					paths.push(p);
				}
				const listPath = path.join(tmpDir, "list.txt");
				const listBody = paths
					.map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
					.join("\n");
				await fsp.writeFile(listPath, listBody, "utf8");
				const outPath = path.join(tmpDir, `merged.${ext}`);
				await execFfmpeg(
					["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath],
					"ffmpeg concat TTS PCM segments",
				);
				return {
					buffer: await fsp.readFile(outPath),
					format: "pcm16",
					usage: mergedTtsUsage,
					modelUsed: model,
				};
			} finally {
				await rmDirSafe(tmpDir);
			}
		} catch (e) {
			lastErr = e?.message || String(e);
		}
	}

	throw new Error(
		`TTS failed after fallbacks (Gemini speech API + gpt-audio-mini + gpt-audio). Last: ${lastErr}`,
	);
}

/**
 * First balanced `{...}` in text, respecting JSON strings (so `{`/`}` inside transcript do not break depth).
 */
function extractFirstJsonObjectString(t) {
	const start = t.indexOf("{");
	if (start === -1) throw new SyntaxError("No JSON object in model output");
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < t.length; i++) {
		const c = t[i];
		if (inString) {
			if (escape) {
				escape = false;
				continue;
			}
			if (c === "\\") {
				escape = true;
				continue;
			}
			if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return t.slice(start, i + 1);
		}
	}
	throw new SyntaxError("Unterminated JSON in model output");
}

/** Strip trailing commas before } or ] (common model mistake). */
function tryRepairJsonText(jsonStr) {
	const candidates = new Set([jsonStr]);
	candidates.add(jsonStr.replace(/,\s*([}\]])/g, "$1"));
	candidates.add(jsonStr.replace(/,\s*([}\]])/g, "$1").replace(/,\s*([}\]])/g, "$1"));
	return [...candidates];
}

function parseJsonObjectFromModel(raw) {
	if (!raw || typeof raw !== "string") {
		throw new SyntaxError("Empty model output");
	}
	let t = raw.trim();
	t = t
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/m, "")
		.trim();
	const jsonStr = extractFirstJsonObjectString(t);
	let lastErr;
	for (const candidate of tryRepairJsonText(jsonStr)) {
		try {
			return JSON.parse(candidate);
		} catch (e) {
			lastErr = e;
		}
	}
	throw new SyntaxError(
		lastErr instanceof Error
			? `Invalid JSON in model output: ${lastErr.message}`
			: "Invalid JSON in model output",
	);
}

/**
 * OpenRouter chat completion for video + JSON. Sets max_tokens to reduce truncation; optional json_object with HTTP retry if unsupported.
 */
async function fetchGeminiVideoJsonCompletion({
	model,
	messages,
	temperature,
	signal,
	jsonObjectResponse = true,
}) {
	const baseBody = {
		model,
		messages,
		temperature,
		max_tokens: OPENROUTER_VIDEO_GEMINI_MAX_TOKENS,
	};
	if (jsonObjectResponse) {
		baseBody.response_format = { type: "json_object" };
	}
	let res = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterFetchHeaders(),
		body: JSON.stringify(baseBody),
	});
	let data = await res.json();
	if (!res.ok || data.error) {
		const msg = String(data?.error?.message || data?.error || "");
		const retryNoRf =
			jsonObjectResponse && /response_format|json_object|unsupported/i.test(msg);
		if (retryNoRf) {
			const second = { ...baseBody };
			delete second.response_format;
			res = await fetch(OPENROUTER_CHAT, {
				method: "POST",
				signal,
				headers: openRouterFetchHeaders(),
				body: JSON.stringify(second),
			});
			data = await res.json();
		}
	}
	return { res, data };
}

/**
 * Gemini: video as base64 data URL + JSON transcript + translation.
 */
async function transcribeAndTranslateWithGemini({
	videoDataUrl,
	targetLanguage,
	signal,
	model: modelId,
}) {
	const model = modelId?.trim() || geminiVideoModel();
	const baseUserText = `Transcribe this video exactly and then translate it into ${targetLanguage}. Provide both as a structured JSON object with keys "transcript" and "translation" only.`;
	const jsonReminder =
		"\n\nReply with a single JSON object only. Escape any double quote characters inside transcript or translation strings as \\\". No markdown fences or text outside JSON.";

	let lastError;
	for (let attempt = 0; attempt < 2; attempt++) {
		const userText = attempt === 0 ? baseUserText : baseUserText + jsonReminder;
		const messages = [
			{
				role: "user",
				content: [
					{ type: "text", text: userText },
					{
						type: "video_url",
						video_url: { url: videoDataUrl },
					},
				],
			},
		];

		const { res, data } = await fetchGeminiVideoJsonCompletion({
			model,
			messages,
			temperature: attempt === 0 ? 0.2 : 0.1,
			signal,
			jsonObjectResponse: true,
		});

		if (!res.ok || data.error) {
			throw new Error(
				data?.error?.message ||
					data?.error ||
					`Gemini video HTTP ${res.status}`,
			);
		}

		const content = data?.choices?.[0]?.message?.content;
		const raw = typeof content === "string" ? content : "";
		if (!raw) {
			lastError = new Error("Empty response from Gemini");
			continue;
		}

		try {
			const parsed = parseJsonObjectFromModel(raw);
			const transcript = String(parsed.transcript ?? "").trim();
			const translation = String(parsed.translation ?? "").trim();
			if (!transcript || !translation) {
				throw new Error(
					"Gemini JSON must include non-empty transcript and translation",
				);
			}
			return { transcript, translation, usage: data.usage };
		} catch (e) {
			lastError = e instanceof Error ? e : new Error(String(e));
		}
	}

	throw lastError || new Error("Could not parse transcript/translation from Gemini");
}

/**
 * Gemini: video as base64 data URL → transcript only (for NLLB bulk MT + optional glossary LLM pass).
 * Asks the model to guess the spoken language as ISO 639-1 (for NLLB src_lang mapping).
 */
async function transcribeOnlyWithGemini({
	videoDataUrl,
	signal,
	model: modelId,
}) {
	const model = modelId?.trim() || geminiVideoModel();
	const baseUserText = `Transcribe the speech in this video exactly, word for word. Return a single JSON object with keys "transcript" (string) and "source_language" (string, ISO 639-1 code for the primary spoken language, e.g. "en" or "es"). No other keys.`;
	const jsonReminder =
		"\n\nReply with one JSON object only. Escape double quotes inside transcript as \\\". No markdown or extra text.";

	let lastError;
	for (let attempt = 0; attempt < 2; attempt++) {
		const userText = attempt === 0 ? baseUserText : baseUserText + jsonReminder;
		const messages = [
			{
				role: "user",
				content: [
					{ type: "text", text: userText },
					{
						type: "video_url",
						video_url: { url: videoDataUrl },
					},
				],
			},
		];

		const { res, data } = await fetchGeminiVideoJsonCompletion({
			model,
			messages,
			temperature: attempt === 0 ? 0.1 : 0.05,
			signal,
			jsonObjectResponse: true,
		});

		if (!res.ok || data.error) {
			throw new Error(
				data?.error?.message ||
					data?.error ||
					`Gemini video (transcribe only) HTTP ${res.status}`,
			);
		}

		const content = data?.choices?.[0]?.message?.content;
		const raw = typeof content === "string" ? content : "";
		if (!raw) {
			lastError = new Error("Empty response from Gemini (transcribe only)");
			continue;
		}

		try {
			const parsed = parseJsonObjectFromModel(raw);
			const transcript = String(parsed.transcript ?? "").trim();
			if (!transcript) {
				throw new Error("Gemini JSON must include non-empty transcript");
			}
			const sourceLanguage =
				parsed.source_language != null
					? String(parsed.source_language).trim().toLowerCase().slice(0, 5)
					: null;
			return { transcript, source_language: sourceLanguage, usage: data.usage };
		} catch (e) {
			lastError = e instanceof Error ? e : new Error(String(e));
		}
	}

	throw lastError || new Error("Could not parse transcript JSON from Gemini");
}

export function normalizeVideoTranslationEngine(raw) {
	const s = String(raw || "llm").trim().toLowerCase();
	if (s === "nllb" || s === "opus" || s === "opus_mt" || s === "marian" || s === "bulk")
		return "nllb";
	return "llm";
}

export function normalizeOpenRouterTtsEngine(raw) {
	const s = String(raw || "openrouter").trim().toLowerCase();
	if (s === "piper" || s === "local") return "piper";
	return "openrouter";
}

export async function downloadVideoToTempFile(
	url,
	signal,
	maxVideoBytes,
	maxMinutes,
	opts = {},
) {
	const normalizedUrl = normalizeYoutubeVideoUrl(String(url || "").trim());
	const preferYtDlpForYoutube = opts.preferYtDlpForYoutube === true;
	// Avoid pessimistic pre-checks based on plan max bytes. Under traffic, this can
	// fail even when the current file would fit. Do a small startup check first and
	// enforce precise checks once actual file size is known.
	const startupTmpBytes = Math.max(
		64 * 1024 * 1024,
		Math.min(TMP_SPACE_BASE_BUFFER_BYTES, 256 * 1024 * 1024),
	);
	await waitForTmpSpace(startupTmpBytes, "video download start", signal);
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vt-dub-"));
	try {
		if (isYoutubeVideoUrl(normalizedUrl)) {
			if (preferYtDlpForYoutube) {
				console.log(
					`[videoTranslate] YouTube download via yt-dlp (long-form; RapidAPI skipped)`,
				);
				const { buf, videoPath } = await downloadViaYtDlp(
					normalizedUrl,
					signal,
					tmpDir,
					maxVideoBytes,
				);
				await enforceDurationLimit(videoPath, maxMinutes);
				return { videoPath, tmpDir, buffer: buf };
			}
			const { buf, videoPath, durationSec } = await downloadViaRapidApi(
				normalizedUrl,
				signal,
				tmpDir,
				maxVideoBytes,
				maxMinutes,
			);
			await enforceDurationLimit(videoPath, maxMinutes, durationSec);
			return { videoPath, tmpDir, buffer: buf };
		}
		if (isYtDlpPageVideoUrl(normalizedUrl)) {
			const { buf, videoPath } = await downloadViaYtDlp(
				normalizedUrl,
				signal,
				tmpDir,
				maxVideoBytes,
			);
			await enforceDurationLimit(videoPath, maxMinutes);
			return { videoPath, tmpDir, buffer: buf };
		}
		const buf = await fetchVideoBufferWithRetries(
			normalizedUrl,
			signal,
			maxVideoBytes,
		);
		if (buf.length > maxVideoBytes) {
			throw new Error(`Video exceeds plan byte limit (${maxVideoBytes} bytes)`);
		}
		const videoPath = path.join(tmpDir, "input.mp4");
		await fsp.writeFile(videoPath, buf);
		await enforceDurationLimit(videoPath, maxMinutes);
		return { videoPath, tmpDir, buffer: buf };
	} catch (e) {
		await rmDirSafe(tmpDir);
		throw e;
	}
}

export async function ffmpegStripAudio(inputPath, outMutedPath) {
	await execFfmpeg(
		["-y", "-i", inputPath, "-an", "-vcodec", "copy", outMutedPath],
		"ffmpeg strip audio",
	);
}

/** Mux muted video + PCM for long-form (full video duration, no -shortest). */
async function ffmpegMuxPcm16WithVideoFullDuration(
	mutedPath,
	pcmPath,
	outFinalPath,
	durationSec,
) {
	await execFfmpeg(
		[
			"-y",
			"-i",
			mutedPath,
			"-f",
			"s16le",
			"-ar",
			String(TTS_PCM_SAMPLE_RATE),
			"-ac",
			String(TTS_PCM_CHANNELS),
			"-i",
			pcmPath,
			"-c:v",
			"copy",
			"-c:a",
			"aac",
			"-map",
			"0:v:0",
			"-map",
			"1:a:0",
			"-t",
			String(Math.max(0.1, durationSec)),
			outFinalPath,
		],
		"ffmpeg mux pcm16 + video (full duration)",
	);
}

async function wavBufferToPcm24kMono(wavBuffer, workDir) {
	const inPath = path.join(workDir, "tts_in.wav");
	const outPath = path.join(workDir, "tts_out.pcm");
	await fsp.writeFile(inPath, wavBuffer);
	await execFfmpeg(
		[
			"-y",
			"-i",
			inPath,
			"-f",
			"s16le",
			"-acodec",
			"pcm_s16le",
			"-ar",
			String(TTS_PCM_SAMPLE_RATE),
			"-ac",
			"1",
			outPath,
		],
		"ffmpeg wav to pcm24k",
	);
	return fsp.readFile(outPath);
}

async function translateLongFormGroupText({
	text,
	job,
	sourceLanguage,
	transEngineRequested,
	signal,
}) {
	const snippet = String(text || "").trim();
	if (!snippet) return { translatedText: "", engine: transEngineRequested };

	if (transEngineRequested === "nllb") {
		const nllbOk = await isNllbRuntimeReady();
		if (!nllbOk) {
			// Fall through to LLM below (probe already logged why NLLB is unavailable).
		} else {
		const tgtNllb = targetLanguageLabelToNllb(job.output_language);
		if (!tgtNllb) {
			throw new Error(
				"Target language is not supported for translation_engine nllb.",
			);
		}
		let srcNllb = null;
		if (
			job.transcript_source_nllb &&
			String(job.transcript_source_nllb).includes("_")
		) {
			srcNllb = String(job.transcript_source_nllb).trim();
		} else if (job.transcript_language_hint) {
			srcNllb = whisperIsoToNllbSource(
				String(job.transcript_language_hint).toLowerCase().slice(0, 2),
			);
		} else if (sourceLanguage) {
			srcNllb = looseIsoToNllbSource(sourceLanguage) || "eng_Latn";
		}
		if (!srcNllb) srcNllb = "eng_Latn";
		try {
			const nllbOut = await translateTextWithNllb({
				text: snippet,
				srcLang: srcNllb,
				tgtLang: tgtNllb,
				signal,
			});
			return {
				translatedText: nllbOut.translation,
				engine: "nllb",
				bulkMtModel: nllbOut.model,
			};
		} catch (nllbErr) {
			console.warn(
				`[videoTranslate-long] segment NLLB failed, LLM fallback: ${nllbErr?.message || nllbErr}`,
			);
		}
		}
	}

	const t = await translateTranscriptTextLlm({
		transcript: snippet,
		targetLanguage: job.output_language,
		model: job.gemini_model,
		signal,
	});
	return { translatedText: t.translation, engine: "llm", usage: t.usage };
}

/**
 * Translate multiple timed cues in one text LLM call (SRT-batch style).
 * @param {{ id: number, text: string }[]} items
 */
async function translateSrtItemsBatchLlm({
	items,
	targetLanguage,
	model,
	signal,
}) {
	const modelId = model?.trim() || geminiVideoModel();
	const cues = items.map((it) => ({
		id: it.id,
		text: String(it.text || "").trim(),
	}));
	const messages = [
		{
			role: "user",
			content: `Translate each subtitle cue into ${targetLanguage} for voice dubbing. Keep tone natural and spoken. Preserve meaning; do not merge or drop cues.

Reply with ONLY compact JSON:
{"items":[{"id":0,"translation":"..."},{"id":1,"translation":"..."}]}

Cues:
${JSON.stringify(cues)}`,
		},
	];

	const { res, data } = await fetchGeminiVideoJsonCompletion({
		model: modelId,
		messages,
		temperature: 0.2,
		signal,
		jsonObjectResponse: true,
	});
	if (!res.ok || data.error) {
		throw new Error(
			String(
				data?.error?.message ||
					data?.error ||
					`SRT batch translation HTTP ${res.status}`,
			),
		);
	}
	const content = data.choices?.[0]?.message?.content;
	const raw = extractMessageText(content);
	if (!raw?.trim()) throw new Error("Empty SRT batch translation");

	let parsed;
	try {
		parsed = parseJsonObjectFromModel(raw);
	} catch {
		// Fall back: translate cues one-by-one
		const out = [];
		let usage = mergeOpenRouterUsage(null, data.usage);
		for (const it of cues) {
			const t = await translateTranscriptTextLlm({
				transcript: it.text,
				targetLanguage,
				model: modelId,
				signal,
			});
			out.push({ id: it.id, translation: t.translation });
			usage = mergeOpenRouterUsage(usage, t.usage);
		}
		return { items: out, usage };
	}

	const list = Array.isArray(parsed?.items) ? parsed.items : [];
	const byId = new Map();
	for (const row of list) {
		const id = Number(row?.id);
		const translation = String(row?.translation ?? "").trim();
		if (Number.isFinite(id) && translation) byId.set(id, translation);
	}

	const out = [];
	let usage = mergeOpenRouterUsage(null, data.usage);
	for (const it of cues) {
		let translation = byId.get(it.id);
		if (!translation) {
			const t = await translateTranscriptTextLlm({
				transcript: it.text,
				targetLanguage,
				model: modelId,
				signal,
			});
			translation = t.translation;
			usage = mergeOpenRouterUsage(usage, t.usage);
		}
		out.push({ id: it.id, translation });
	}
	return { items: out, usage };
}

/**
 * Translate merged timed groups: NLLB per cue (parallel) or LLM in text batches.
 */
async function translateTimedGroupsInBatches({
	groups,
	job,
	sourceLanguage,
	transEngineRequested,
	signal,
	onProgress,
	onBatchDone,
}) {
	const translatedGroups = groups.map((g) => ({ ...g, translatedText: "" }));
	let mergedUsage = mergeOpenRouterUsage(null, null);
	let effectiveEngine = transEngineRequested;
	let bulkMtModel = null;
	const total = groups.length;

	const useNllb =
		transEngineRequested === "nllb" && (await isNllbRuntimeReady());

	if (useNllb) {
		const settled = await mapPoolSettled(groups, 3, async (g, i) => {
			if (onProgress) await onProgress(i, total);
			const tr = await translateLongFormGroupText({
				text: g.text,
				job,
				sourceLanguage,
				transEngineRequested: "nllb",
				signal,
			});
			return { i, tr };
		});
		for (const s of settled) {
			if (!s.ok || !s.value) {
				effectiveEngine = "llm";
				continue;
			}
			const { i, tr } = s.value;
			translatedGroups[i].translatedText = tr.translatedText || "";
			if (tr.engine === "llm") effectiveEngine = "llm";
			if (tr.bulkMtModel) bulkMtModel = tr.bulkMtModel;
			if (tr.usage) {
				mergedUsage = mergeOpenRouterUsage(mergedUsage, tr.usage);
			}
		}
		// Fill any empty with LLM
		for (let i = 0; i < translatedGroups.length; i++) {
			if (translatedGroups[i].translatedText) continue;
			const tr = await translateLongFormGroupText({
				text: groups[i].text,
				job,
				sourceLanguage,
				transEngineRequested: "llm",
				signal,
			});
			translatedGroups[i].translatedText = tr.translatedText || "";
			effectiveEngine = "llm";
			if (tr.usage) {
				mergedUsage = mergeOpenRouterUsage(mergedUsage, tr.usage);
			}
		}
		return {
			translatedGroups,
			usage: mergedUsage,
			engine: effectiveEngine,
			bulkMtModel,
		};
	}

	const batchSize = Math.max(1, LONG_VIDEO_TRANSLATE_BATCH_SIZE);
	let batchIndex = 0;
	for (let start = 0; start < groups.length; start += batchSize) {
		const slice = [];
		for (let i = start; i < Math.min(start + batchSize, groups.length); i++) {
			slice.push({ id: i, text: groups[i].text });
		}
		const from = start;
		const to = start + slice.length - 1;
		if (onProgress) await onProgress(start, total);
		try {
			const batch = await translateSrtItemsBatchLlm({
				items: slice,
				targetLanguage: job.output_language,
				model: job.gemini_model,
				signal,
			});
			mergedUsage = mergeOpenRouterUsage(mergedUsage, batch.usage);
			for (const row of batch.items) {
				translatedGroups[row.id].translatedText = row.translation;
			}
			if (onBatchDone) {
				await onBatchDone({
					batchIndex,
					from,
					to,
					ok: true,
				});
			}
		} catch (e) {
			console.warn(
				`[videoTranslate-long] batch translate failed, per-cue fallback: ${e?.message || e}`,
			);
			if (onBatchDone) {
				await onBatchDone({
					batchIndex,
					from,
					to,
					ok: false,
					error: e?.message || String(e),
				});
			}
			for (const it of slice) {
				const tr = await translateLongFormGroupText({
					text: it.text,
					job,
					sourceLanguage,
					transEngineRequested: "llm",
					signal,
				});
				translatedGroups[it.id].translatedText = tr.translatedText || "";
				if (tr.usage) {
					mergedUsage = mergeOpenRouterUsage(mergedUsage, tr.usage);
				}
			}
		}
		effectiveEngine = "llm";
		batchIndex += 1;
	}

	return {
		translatedGroups,
		usage: mergedUsage,
		engine: effectiveEngine,
		bulkMtModel,
	};
}

async function synthesizeLongFormTimedDubTrack({
	groups,
	durationSec,
	ttsEng,
	job,
	signal,
	tmpDir,
	onProgress,
	onGroupDone,
}) {
	const track = createSilentPcmBuffer(durationSec, TTS_PCM_SAMPLE_RATE);
	let mergedTtsUsage = mergeOpenRouterUsage(null, null);
	const total = groups.length;
	let done = 0;

	const settled = await mapPoolSettled(
		groups,
		LONG_VIDEO_TTS_CONCURRENCY,
		async (g, i) => {
			const text = String(g.translatedText || "").trim();
			if (!text) return null;
			let pcmBuf;
			if (ttsEng === "piper") {
				const wavBuf = await piperSynthesizeWav({
					text,
					modelPath: job.piper_model || null,
					signal,
				});
				const workDir = path.join(tmpDir, `piper_pcm_${i}`);
				await fsp.mkdir(workDir, { recursive: true });
				pcmBuf = await wavBufferToPcm24kMono(wavBuf, workDir);
				await rmDirSafe(workDir);
				return { pcmBuf, start_ms: g.start_ms, usage: null };
			}
			const t = await ttsSynthesizeToBuffer({
				text,
				signal,
				voice: job.tts_voice || undefined,
			});
			return { pcmBuf: t.buffer, start_ms: g.start_ms, usage: t.usage };
		},
	);

	for (const s of settled) {
		done += 1;
		if (onProgress) await onProgress(done - 1, total);
		if (!s.ok || !s.value?.pcmBuf) {
			if (onGroupDone) {
				await onGroupDone({
					index: s.idx,
					total,
					ok: false,
					error: s.error || "empty TTS",
				});
			} else if (!s.ok) {
				console.warn(
					`[videoTranslate-long] TTS group ${s.idx} failed: ${s.error}`,
				);
			}
			continue;
		}
		if (onGroupDone) {
			await onGroupDone({ index: s.idx, total, ok: true });
		}
		mergedTtsUsage = mergeOpenRouterUsage(mergedTtsUsage, s.value.usage);
		const startSample = Math.floor(
			(s.value.start_ms / 1000) * TTS_PCM_SAMPLE_RATE,
		);
		overlayPcmS16le(track, s.value.pcmBuf, startSample);
	}

	return { buffer: track, usage: mergedTtsUsage };
}

/** Mux muted video + raw s16le PCM (24 kHz from Gemini TTS or gpt-audio pcm16). */
async function ffmpegMuxPcm16WithVideo(mutedPath, pcmPath, outFinalPath) {
	await execFfmpeg(
		[
			"-y",
			"-i",
			mutedPath,
			"-f",
			"s16le",
			"-ar",
			String(TTS_PCM_SAMPLE_RATE),
			"-ac",
			String(TTS_PCM_CHANNELS),
			"-i",
			pcmPath,
			"-c:v",
			"copy",
			"-c:a",
			"aac",
			"-map",
			"0:v:0",
			"-map",
			"1:a:0",
			"-shortest",
			outFinalPath,
		],
		"ffmpeg mux pcm16 + video",
	);
}

/** Extract mono 16 kHz WAV for ASR (Whisper). */
export async function ffmpegExtractAudioForAsr(inputPath, outWavPath) {
	await execFfmpeg(
		[
			"-y",
			"-i",
			inputPath,
			"-vn",
			"-acodec",
			"pcm_s16le",
			"-ar",
			"16000",
			"-ac",
			"1",
			outWavPath,
		],
		"ffmpeg extract audio for ASR",
	);
}

/** Mux muted video + WAV (e.g. Orpheus TTS). */
export async function ffmpegMuxWavWithVideo(mutedPath, wavPath, outFinalPath) {
	await execFfmpeg(
		[
			"-y",
			"-i",
			mutedPath,
			"-i",
			wavPath,
			"-c:v",
			"copy",
			"-c:a",
			"aac",
			"-map",
			"0:v:0",
			"-map",
			"1:a:0",
			"-shortest",
			outFinalPath,
		],
		"ffmpeg mux wav + video",
	);
}

export async function uploadMp4Buffer(buffer, jobId) {
	const fileName = `dubbed-${jobId}.mp4`;
	const utFile = new UTFile([buffer], fileName, { type: "video/mp4" });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing final video failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

/** Upload raw source video (post-download) before translation pipeline runs. */
async function uploadSourceMp4Buffer(buffer, jobId) {
	const fileName = `source-${jobId}.mp4`;
	const utFile = new UTFile([buffer], fileName, { type: "video/mp4" });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(
			`UploadThing source video failed: ${response.error.message}`,
		);
	}
	return response.data.ufsUrl;
}

function isLikelyHostedSourceUrl(url) {
	const u = String(url || "").trim().toLowerCase();
	if (!u.startsWith("http://") && !u.startsWith("https://")) return false;
	return (
		u.includes("uploadthing.com") ||
		u.includes("utfs.io") ||
		u.includes("ufs.sh") ||
		u.includes("uploadthing-prod.s3")
	);
}

/**
 * Phase 2 only: load bytes from `stored_source_video_url` via HTTP.
 * Never routes through yt-dlp (YouTube/X page URLs must not be re-fetched here).
 */
async function fetchStoredSourceVideoToTempFile(
	storedUrl,
	signal,
	maxVideoBytes,
	maxMinutes,
) {
	const url = String(storedUrl || "").trim();
	if (!url) {
		throw new Error("Missing stored source video URL");
	}
	if (isYtDlpPageVideoUrl(url) || isYoutubeVideoUrl(url)) {
		throw new Error(
			"Internal error: translation phase received a page URL instead of stored_source_video_url",
		);
	}

	const startupTmpBytes = Math.max(
		64 * 1024 * 1024,
		Math.min(TMP_SPACE_BASE_BUFFER_BYTES, 256 * 1024 * 1024),
	);
	await waitForTmpSpace(startupTmpBytes, "stored source fetch start", signal);
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vt-dub-"));
	try {
		const buf = await fetchVideoBufferWithRetries(url, signal, maxVideoBytes);
		if (buf.length > maxVideoBytes) {
			throw new Error(`Video exceeds plan byte limit (${maxVideoBytes} bytes)`);
		}
		const videoPath = path.join(tmpDir, "input.mp4");
		await fsp.writeFile(videoPath, buf);
		await enforceDurationLimit(videoPath, maxMinutes);
		return { videoPath, tmpDir, buffer: buf };
	} catch (e) {
		await rmDirSafe(tmpDir);
		throw e;
	}
}

export async function uploadVttFromText(text, jobId) {
	const vtt = `WEBVTT

00:00:00.000 --> 00:10:00.000
${String(text).replace(/\r\n/g, "\n")}`;
	const fileName = `subs-${jobId}.vtt`;
	const utFile = new UTFile([Buffer.from(vtt, "utf8")], fileName, {
		type: "text/vtt",
	});
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing VTT failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

export async function rmDirSafe(dir) {
	await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function newJobId() {
	return `vt_${uuidv4().replace(/-/g, "")}`;
}

async function writeJob(docId, data) {
	await firestore.collection(JOBS_COLL).doc(docId).set(data, { merge: true });
}

async function patchJob(docId, data) {
	await firestore.collection(JOBS_COLL).doc(docId).update(data);
}

export function getVideoTranslateLanguagesResponse() {
	return {
		error: null,
		data: { languages: [...VIDEO_TRANSLATE_TARGET_LANGUAGES] },
	};
}

/**
 * Subscribe to job doc updates until caption is ready, failed, missing, or listener errors.
 * Call the returned function to unsubscribe (e.g. client disconnect or timeout).
 */
export function subscribeVideoTranslateCaptionUpdates(videoTranslateId, onEvent) {
	const id = String(videoTranslateId).trim();
	const ref = firestore.collection(JOBS_COLL).doc(id);
	let unsubscribed = false;
	const unsub = ref.onSnapshot(
		(snap) => {
			if (unsubscribed) return;
			if (!snap.exists) {
				unsubscribed = true;
				unsub();
				onEvent({ kind: "not_found" });
				return;
			}
			const d = snap.data();
			if (d.status === "failed") {
				unsubscribed = true;
				unsub();
				onEvent({
					kind: "failed",
					message: d.error || d.status_message || null,
				});
				return;
			}
			if (d.status === "success") {
				if (d.caption_url) {
					const caption =
						d.caption_text != null && d.caption_text !== ""
							? String(d.caption_text)
							: d.translated_transcript != null
								? String(d.translated_transcript)
								: "";
					unsubscribed = true;
					unsub();
					onEvent({
						kind: "ready",
						data: {
							caption_url: d.caption_url,
							caption,
							...publicTranslateUsageFromDoc(d),
						},
					});
					return;
				}
				unsubscribed = true;
				unsub();
				onEvent({
					kind: "failed",
					message: d.error || "Caption URL unavailable",
				});
				return;
			}
			onEvent({ kind: "progress", status: d.status });
		},
		(err) => {
			if (unsubscribed) return;
			unsubscribed = true;
			try {
				unsub();
			} catch {}
			onEvent({
				kind: "listener_error",
				message: err?.message || String(err),
			});
		},
	);
	return () => {
		if (unsubscribed) return;
		unsubscribed = true;
		try {
			unsub();
		} catch {}
	};
}

export async function getVideoTranslateCaptionResponse(videoTranslateId) {
	if (!videoTranslateId || !String(videoTranslateId).trim()) {
		return {
			error: "Query video_translate_id is required",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}
	const snap = await firestore
		.collection(JOBS_COLL)
		.doc(String(videoTranslateId).trim())
		.get();
	if (!snap.exists) {
		return {
			error: "Unknown video_translate_id",
			code: "NOT_FOUND",
			httpStatus: 404,
		};
	}
	const d = snap.data();
	if (d.status !== "success" || !d.caption_url) {
		return {
			error: "Captions not ready yet or job failed",
			code: "NOT_READY",
			httpStatus: 404,
			data: { status: d.status },
		};
	}
	const caption =
		d.caption_text != null && d.caption_text !== ""
			? String(d.caption_text)
			: (d.translated_transcript != null ? String(d.translated_transcript) : "");
	return {
		error: null,
		data: {
			caption_url: d.caption_url,
			caption,
			...publicTranslateUsageFromDoc(d),
		},
		httpStatus: 200,
	};
}

export async function getVideoTranslateJobStatus(videoTranslateId) {
	if (!videoTranslateId || !String(videoTranslateId).trim()) {
		return {
			error: "Missing video_translate_id",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}
	let snap;
	try {
		snap = await firestore
			.collection(JOBS_COLL)
			.doc(String(videoTranslateId).trim())
			.get();
	} catch (e) {
		if (isFirestoreQuotaError(e)) {
			console.warn(
				`[videoTranslate] GET status Firestore quota for ${videoTranslateId}: ${e?.message || e}`,
			);
			return {
				error:
					"Status temporarily unavailable (Firestore quota exceeded). Retry shortly — the job may still be running or already finished.",
				code: "FIRESTORE_QUOTA",
				httpStatus: 503,
			};
		}
		throw e;
	}
	if (!snap.exists) {
		return {
			error: null,
			data: {
				video_translate_id: videoTranslateId,
				status: "failed",
				message: "Unknown job id",
				url: null,
				caption_url: null,
				caption: null,
				usage: null,
				tokenUsage: null,
			},
			httpStatus: 404,
		};
	}
	const d = snap.data();
	const captionStr =
		d.caption_text != null && d.caption_text !== ""
			? String(d.caption_text)
			: (d.translated_transcript != null
					? String(d.translated_transcript)
					: null);
	const heygenLike = {
		video_translate_id: d.id || videoTranslateId,
		title: d.title || null,
		output_language: d.output_language || null,
		status:
			d.status === "pending" || d.status === "running"
				? d.status === "pending"
					? "pending"
					: "running"
				: d.status === "success"
					? "success"
					: "failed",
		url:
			d.translated_video_url ||
			d.final_video_url ||
			d.source_video_url ||
			d.video_url ||
			null,
		caption_url: d.caption_url || null,
		caption: captionStr,
		message: d.error || d.status_message || null,
		callback_id: d.callback_id || null,
		transcript_original: d.transcript_original ?? null,
		translated_transcript: d.translated_transcript ?? null,
		source_video_url:
			d.original_video_url || d.source_video_url || d.video_url || null,
		...publicTranslateUsageFromDoc(d),
		engine: d.long_form ? "openrouter-gemini-dub-long" : "openrouter-gemini-dub",
		pipeline: {
			translation: d.translation_engine || "llm",
			tts: d.tts_engine || "openrouter",
			...(d.tts_voice ? { tts_voice: d.tts_voice } : {}),
			...(d.tts_voice_id ? { tts_voice_id: d.tts_voice_id } : {}),
			glossary_refinement: d.glossary_refinement === true,
			bulk_mt_model: d.bulk_mt_model ?? null,
		},
		...(d.long_form
			? {
					partial: d.partial === true,
					long_chunk_total: d.long_chunk_total ?? null,
					long_chunk_done: d.long_chunk_done ?? null,
					long_chunk_failed: d.long_chunk_failed ?? null,
					chunks: Array.isArray(d.chunk_results) ? d.chunk_results : null,
					steps: Array.isArray(d.step_results) ? d.step_results : null,
				}
			: {}),
	};
	return { error: null, data: heygenLike, httpStatus: 200 };
}

export async function createVideoTranslateJobs({
	videoUrl,
	body,
	longForm = false,
}) {
	if (!getOpenRouterKey()) {
		return {
			error: "OPENROUTER_API_KEY not configured",
			code: "MISSING_API_KEY",
			httpStatus: 503,
		};
	}
	if (!process.env.UPLOADTHING_TOKEN) {
		return {
			error:
				"UPLOADTHING_TOKEN not configured (required to upload dubbed video)",
			code: "MISSING_UPLOAD_TOKEN",
			httpStatus: 503,
		};
	}

	const video_url = normalizeYoutubeVideoUrl(String(videoUrl || "").trim());
	const langs = body.output_language
		? [body.output_language]
		: Array.isArray(body.output_languages)
			? body.output_languages
			: [];

	if (!video_url) {
		return {
			error:
				"Provide video_url (or videoUrl) or upload a video file (field: file or video)",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}
	if (!langs.length) {
		return {
			error: "Provide output_language or output_languages",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const { plan, maxVideoBytes, maxMinutes } = resolvePlanCaps(
		body.plan ?? body.user_plan ?? body.subscription_plan ?? body.tier,
	);
	const rawLlm = body.model ?? body.llm_model;
	let videoLlmOpenRouterId;
	let llmPresetLabel = "gemini";
	if (rawLlm != null && String(rawLlm).trim() !== "") {
		const r = resolveTranslateLlmModel(rawLlm);
		if (!r.ok) {
			return {
				error: r.error,
				code: "BAD_REQUEST",
				details: { allowed_models: r.allowed },
				httpStatus: 400,
			};
		}
		videoLlmOpenRouterId = r.openrouterId;
		llmPresetLabel = r.preset;
	} else {
		videoLlmOpenRouterId = geminiVideoModel();
	}

	const translation_engine = normalizeVideoTranslationEngine(
		body.translation_engine,
	);
	const tts_engine = normalizeOpenRouterTtsEngine(body.tts_engine);
	const glossary_refinement =
		body.glossary_refinement === true ||
		body.glossary_refinement === "true" ||
		body.glossary_refinement === "1";
	const piper_model = body.piper_model
		? String(body.piper_model).trim()
		: null;
	const transcript_source_nllb =
		body.source_nllb != null && String(body.source_nllb).includes("_")
			? String(body.source_nllb).trim()
			: null;
	const transcript_language_hint =
		body.transcript_language != null
			? String(body.transcript_language).trim()
			: body.source_language != null
				? String(body.source_language).trim()
				: null;
	const glossary_refine_model = body.glossary_refine_model
		? String(body.glossary_refine_model).trim()
		: null;

	if (translation_engine === "nllb") {
		for (const lang of langs) {
			if (!targetLanguageLabelToNllb(String(lang))) {
				return {
					error: `output_language "${lang}" is not supported for translation_engine nllb (extend lib/nmtLanguages.js or use translation_engine llm).`,
					code: "BAD_REQUEST",
					httpStatus: 400,
				};
			}
		}
	}
	if (tts_engine === "piper" && !piper_model && !isPiperConfigured()) {
		return {
			error:
				"Piper TTS requires PIPER_MODEL in the environment or piper_model in the request body.",
			code: "MISSING_PIPER_MODEL",
			httpStatus: 503,
		};
	}

	let tts_voice = null;
	let tts_voice_id = null;
	if (tts_engine !== "piper") {
		const voiceRes = resolveOpenRouterTtsVoice({
			tts_voice: body.tts_voice,
			brand_voice_id: body.brand_voice_id,
			voice_id: body.voice_id,
		});
		if (!voiceRes.ok) {
			return {
				error: voiceRes.error,
				code: "BAD_REQUEST",
				details: voiceRes.details,
				httpStatus: voiceRes.httpStatus,
			};
		}
		tts_voice = voiceRes.voice;
		tts_voice_id = voiceRes.voice_id;
	}

	const baseMeta = {
		video_url,
		title: body.title || null,
		callback_id: body.callback_id || null,
		plan,
		max_video_bytes: maxVideoBytes,
		max_minutes: maxMinutes,
		long_form: longForm === true,
		gemini_model: videoLlmOpenRouterId,
		llm_preset: llmPresetLabel,
		tts_model: ttsModel(),
		translation_engine,
		tts_engine,
		...(tts_voice ? { tts_voice, tts_voice_id } : {}),
		...(body.brand_voice_id ? { brand_voice_id: String(body.brand_voice_id) } : {}),
		glossary_refinement,
		piper_model: piper_model || null,
		transcript_source_nllb,
		transcript_language_hint: transcript_language_hint || null,
		glossary_refine_model: glossary_refine_model || null,
	};

	const ids = [];
	for (const output_language of langs) {
		const id = newJobId();
		await writeJob(id, {
			id,
			status: "pending",
			video_url,
			original_video_url: video_url,
			source_video_url: video_url,
			output_language: String(output_language),
			...baseMeta,
			createdAt: FieldValue.serverTimestamp(),
			updatedAt: FieldValue.serverTimestamp(),
		});
		ids.push(id);
		queueProcessVideoJob(id, longForm);
	}

	const pipeline = {
		translation: translation_engine,
		tts: tts_engine,
		glossary_refinement,
		...(tts_voice ? { tts_voice, tts_voice_id } : {}),
	};
	if (ids.length === 1) {
		return {
			error: null,
			data: {
				video_translate_id: ids[0],
				video_translate_ids: null,
				pipeline,
			},
			httpStatus: 200,
		};
	}
	return {
		error: null,
		data: {
			video_translate_id: null,
			video_translate_ids: ids,
			pipeline,
		},
		httpStatus: 200,
	};
}

function queueProcessVideoJob(jobId, longForm = false) {
	setImmediate(() => {
		const runner = longForm
			? processVideoTranslateLongJob
			: processVideoTranslateJob;
		runner(jobId).catch((err) => {
			console.error(`[videoTranslate] job ${jobId} failed:`, err);
			patchJob(jobId, {
				status: "failed",
				phase: "failed",
				error: err?.message || String(err),
				status_message: null,
				updatedAt: FieldValue.serverTimestamp(),
			}).catch(() => {});
		});
	});
}

async function readJobOrThrow(jobId) {
	const snap = await firestore.collection(JOBS_COLL).doc(jobId).get();
	if (!snap.exists) {
		throw new Error(`Unknown job id: ${jobId}`);
	}
	return snap.data();
}

/**
 * Phase 1: download page URL / remote file → UploadThing source MP4.
 * Sets `stored_source_video_url` on the job doc for phase 2.
 */
async function downloadAndUploadSourceVideoForJob(jobId, signal) {
	const job = await readJobOrThrow(jobId);
	if (job.stored_source_video_url) {
		console.log(
			`[videoTranslate] job ${jobId} source already stored, skipping download`,
		);
		return String(job.stored_source_video_url);
	}

	const planCaps = resolvePlanCaps(job.plan);
	const storedBytes = Number.parseInt(String(job.max_video_bytes || ""), 10);
	const maxVideoBytes = Math.max(
		planCaps.maxVideoBytes,
		Number.isFinite(storedBytes) && storedBytes > 0 ? storedBytes : 0,
	);
	const storedMinutes = Number.parseInt(String(job.max_minutes || ""), 10);
	const maxMinutes = Math.max(
		planCaps.maxMinutes,
		Number.isFinite(storedMinutes) && storedMinutes > 0 ? storedMinutes : 0,
	);
	const inputUrl = String(job.video_url || "").trim();
	const originalUrl = String(job.original_video_url || inputUrl).trim();

	console.log(
		`[videoTranslate] job ${jobId} download caps plan=${planCaps.plan} max_bytes=${maxVideoBytes} max_min=${maxMinutes}`,
	);

	/** Already on UploadThing / utfs.io — skip yt-dlp and re-upload. */
	if (isLikelyHostedSourceUrl(inputUrl)) {
		await patchJob(jobId, {
			status: "running",
			phase: "translate",
			status_message: "Using hosted source video; starting translation...",
			original_video_url: originalUrl,
			stored_source_video_url: inputUrl,
			download_completed_at: FieldValue.serverTimestamp(),
			download_skipped: true,
			download_skip_reason: "hosted_source_url",
			updatedAt: FieldValue.serverTimestamp(),
		});
		console.log(
			`[videoTranslate] job ${jobId} skip download — hosted source: ${inputUrl}`,
		);
		return inputUrl;
	}

	await patchJob(jobId, {
		status: "running",
		phase: "download",
		status_message: "Downloading source video...",
		original_video_url: originalUrl,
		updatedAt: FieldValue.serverTimestamp(),
	});

	let tmpDir;
	try {
		const { buffer, tmpDir: tDir } = await downloadVideoToTempFile(
			inputUrl,
			signal,
			maxVideoBytes,
			maxMinutes,
		);
		tmpDir = tDir;

		console.log(
			`[videoTranslate] job ${jobId} downloaded ${buffer.length} bytes, uploading source...`,
		);
		const storedUrl = await uploadSourceMp4Buffer(buffer, jobId);
		await patchJob(jobId, {
			stored_source_video_url: storedUrl,
			download_completed_at: FieldValue.serverTimestamp(),
			status_message: "Source video uploaded; starting translation...",
			phase: "translate",
			download_error: null,
			download_skipped: false,
			updatedAt: FieldValue.serverTimestamp(),
		});
		console.log(`[videoTranslate] job ${jobId} source stored at ${storedUrl}`);
		return storedUrl;
	} catch (e) {
		const msg = e?.message || String(e);
		await patchJob(jobId, {
			status: "failed",
			phase: "download",
			download_error: msg,
			error: msg,
			status_message: null,
			updatedAt: FieldValue.serverTimestamp(),
		});
		throw e;
	} finally {
		if (tmpDir) await rmDirSafe(tmpDir);
	}
}

/**
 * Phase 2: fetch stored source → Gemini / TTS / ffmpeg → upload final assets.
 */
async function translateStoredSourceVideoJob(jobId, signal) {
	const job = await readJobOrThrow(jobId);
	const storedUrl = String(job.stored_source_video_url || "").trim();
	if (!storedUrl) {
		throw new Error("Source video not available (download phase did not complete)");
	}

	const planCaps = resolvePlanCaps(job.plan);
	const storedBytes = Number.parseInt(String(job.max_video_bytes || ""), 10);
	const maxVideoBytes = Math.max(
		planCaps.maxVideoBytes,
		Number.isFinite(storedBytes) && storedBytes > 0 ? storedBytes : 0,
	);
	const storedMinutes = Number.parseInt(String(job.max_minutes || ""), 10);
	const maxMinutes = Math.max(
		planCaps.maxMinutes,
		Number.isFinite(storedMinutes) && storedMinutes > 0 ? storedMinutes : 0,
	);

	await patchJob(jobId, {
		status: "running",
		phase: "translate",
		status_message: "Translating and dubbing video...",
		updatedAt: FieldValue.serverTimestamp(),
	});

	let tmpDir;
	let bulkMtModel = null;
	try {
		console.log(
			`[videoTranslate] job ${jobId} phase 2 direct fetch from stored source (no yt-dlp): ${storedUrl}`,
		);
		const { videoPath, tmpDir: tDir, buffer } =
			await fetchStoredSourceVideoToTempFile(
				storedUrl,
				signal,
				maxVideoBytes,
				maxMinutes,
			);
		tmpDir = tDir;

		const mime = "video/mp4";
		const videoDataUrl = `data:${mime};base64,${buffer.toString("base64")}`;

		const transEngine = normalizeVideoTranslationEngine(job.translation_engine);
		const ttsEng = normalizeOpenRouterTtsEngine(job.tts_engine);
		const glossaryRef = job.glossary_refinement === true;

		let transcript;
		let translation;
		let mergedOpenRouterUsage = mergeOpenRouterUsage(null, null);

		if (transEngine === "nllb") {
			const tOnly = await transcribeOnlyWithGemini({
				videoDataUrl,
				signal,
				model: job.gemini_model,
			});
			transcript = tOnly.transcript;
			mergedOpenRouterUsage = mergeOpenRouterUsage(
				mergedOpenRouterUsage,
				tOnly.usage,
			);
			const tgtNllb = targetLanguageLabelToNllb(job.output_language);
			if (!tgtNllb) {
				throw new Error(
					"Target language is not supported for translation_engine nllb (update lib/nmtLanguages.js or use translation_engine llm).",
				);
			}
			let srcNllb = null;
			if (
				job.transcript_source_nllb &&
				String(job.transcript_source_nllb).includes("_")
			) {
				srcNllb = String(job.transcript_source_nllb).trim();
			} else if (job.transcript_language_hint) {
				srcNllb = whisperIsoToNllbSource(
					String(job.transcript_language_hint).toLowerCase().slice(0, 2),
				);
			}
			if (!srcNllb) {
				srcNllb =
					looseIsoToNllbSource(tOnly.source_language) || "eng_Latn";
			}
			const nllbOut = await translateTextWithNllb({
				text: transcript,
				srcLang: srcNllb,
				tgtLang: tgtNllb,
				signal,
			});
			translation = nllbOut.translation;
			bulkMtModel = nllbOut.model;
			if (glossaryRef) {
				const gModel =
					String(job.glossary_refine_model || "").trim() ||
					OPENROUTER_GLOSSARY_REFINE_MODEL;
				const refined = await refineTranslationGlossaryOpenRouter({
					translation,
					targetLanguage: job.output_language,
					model: gModel,
					signal,
				});
				translation = refined.translation;
				mergedOpenRouterUsage = mergeOpenRouterUsage(
					mergedOpenRouterUsage,
					refined.usage,
				);
			}
		} else {
			const t = await transcribeAndTranslateWithGemini({
				videoDataUrl,
				targetLanguage: job.output_language,
				signal,
				model: job.gemini_model,
			});
			transcript = t.transcript;
			translation = t.translation;
			mergedOpenRouterUsage = mergeOpenRouterUsage(
				mergedOpenRouterUsage,
				t.usage,
			);
		}

		let ttsBuf;
		let ttsUsage = mergeOpenRouterUsage(null, null);
		if (ttsEng === "piper") {
			ttsBuf = await piperSynthesizeWav({
				text: translation,
				modelPath: job.piper_model || null,
				signal,
			});
		} else {
			const t = await ttsSynthesizeToBuffer({
				text: translation,
				signal,
				voice: job.tts_voice || undefined,
			});
			ttsBuf = t.buffer;
			ttsUsage = t.usage;
		}
		mergedOpenRouterUsage = mergeOpenRouterUsage(mergedOpenRouterUsage, ttsUsage);
		const usagePayload = buildUsageResponseFields(mergedOpenRouterUsage);

		const mutedPath = path.join(tmpDir, "muted_video.mp4");
		const pcmPath = path.join(tmpDir, "speech.pcm");
		const finalPath = path.join(tmpDir, "final_output.mp4");

		await waitForTmpSpace(
			Math.floor(
				buffer.length * 1.5 + ttsBuf.length + TMP_SPACE_BASE_BUFFER_BYTES,
			),
			"ffmpeg mux/output",
			signal,
		);
		if (ttsEng === "piper") {
			const ttsWavPath = path.join(tmpDir, "piper_tts.wav");
			await fsp.writeFile(ttsWavPath, ttsBuf);
			await ffmpegStripAudio(videoPath, mutedPath);
			await ffmpegMuxWavWithVideo(mutedPath, ttsWavPath, finalPath);
		} else {
			await fsp.writeFile(pcmPath, ttsBuf);
			await ffmpegStripAudio(videoPath, mutedPath);
			await ffmpegMuxPcm16WithVideo(mutedPath, pcmPath, finalPath);
		}

		const finalBuf = await fsp.readFile(finalPath);
		const translatedVideoUrl = await uploadMp4Buffer(finalBuf, jobId);
		const captionUrl = await uploadVttFromText(translation, jobId).catch(
			() => null,
		);

		await patchJob(jobId, {
			status: "success",
			phase: "done",
			transcript_original: transcript,
			translated_transcript: translation,
			caption_text: translation,
			translated_video_url: translatedVideoUrl,
			final_video_url: translatedVideoUrl,
			caption_url: captionUrl,
			...usagePayload,
			translation_engine: transEngine,
			tts_engine: ttsEng,
			glossary_refinement: glossaryRef,
			bulk_mt_model: bulkMtModel,
			error: null,
			status_message: null,
			updatedAt: FieldValue.serverTimestamp(),
		});
	} catch (e) {
		const msg = e?.message || String(e);
		await patchJob(jobId, {
			status: "failed",
			phase: "translate",
			error: msg,
			status_message: null,
			updatedAt: FieldValue.serverTimestamp(),
		});
		throw e;
	} finally {
		if (tmpDir) await rmDirSafe(tmpDir);
	}
}

async function processVideoTranslateJob(jobId) {
	const signal = AbortSignal.timeout(OPENROUTER_VIDEO_TIMEOUT_MS);
	await acquireVideoJobSlot(signal);
	try {
		await downloadAndUploadSourceVideoForJob(jobId, signal);
		await translateStoredSourceVideoJob(jobId, signal);
	} finally {
		releaseVideoJobSlot();
	}
}

/**
 * Long videos: captions/SRT (or one-pass audio ASR) → batch text translate → timed TTS → mux.
 * Same public request/response as /api/video-translate. Default translation_engine: llm.
 */
export async function createVideoTranslateLongJobs({ videoUrl, body }) {
	const explicitEngine =
		body?.translation_engine != null &&
		String(body.translation_engine).trim() !== ""
			? String(body.translation_engine).trim()
			: null;
	const mergedBody = {
		...body,
		translation_engine: explicitEngine || "llm",
	};
	return createVideoTranslateJobs({
		videoUrl,
		body: mergedBody,
		longForm: true,
	});
}

async function ffmpegExtractEmbeddedSrt(videoPath) {
	const outSrt = path.join(path.dirname(videoPath), "embedded_extract.srt");
	await execFfmpeg(
		["-y", "-i", videoPath, "-map", "0:s:0", outSrt],
		"ffmpeg extract embedded subtitles",
	);
	const content = await fsp.readFile(outSrt, "utf8");
	if (!String(content || "").trim()) {
		throw new Error("Embedded subtitle track is empty");
	}
	return content;
}

async function translateTranscriptTextLlm({
	transcript,
	targetLanguage,
	model,
	signal,
}) {
	const modelId = model?.trim() || geminiVideoModel();
	const snippet = String(transcript || "").trim();
	if (!snippet) {
		throw new Error("Empty transcript for translation");
	}

	const jsonMessages = [
		{
			role: "user",
			content: `Translate the following into ${targetLanguage} for voice dubbing. Reply with ONLY compact JSON: {"translation":"<spoken translation>"}. Escape internal double quotes as \\".

Text:
"""${snippet}"""`,
		},
	];
	const plainMessages = [
		{
			role: "user",
			content: `Translate the following into ${targetLanguage} for voice dubbing. Reply with ONLY the translated spoken text — no JSON, no labels, no markdown.

${snippet}`,
		},
	];

	let lastErr;
	for (let attempt = 0; attempt < 3; attempt++) {
		const usePlainText = attempt === 2;
		try {
			const { res, data } = await fetchGeminiVideoJsonCompletion({
				model: modelId,
				messages: usePlainText ? plainMessages : jsonMessages,
				temperature: usePlainText ? 0.2 : attempt === 0 ? 0.25 : 0.15,
				signal,
				jsonObjectResponse: !usePlainText,
			});
			if (!res.ok || data.error) {
				throw new Error(
					String(
						data?.error?.message ||
							data?.error ||
							`Translation LLM HTTP ${res.status}`,
					),
				);
			}
			const content = data.choices?.[0]?.message?.content;
			if (!content || (typeof content !== "string" && !Array.isArray(content))) {
				throw new Error("Empty translation from model");
			}

			if (usePlainText) {
				const plain = extractMessageText(content)
					.replace(/^```(?:json)?\s*/i, "")
					.replace(/\s*```$/m, "")
					.trim();
				if (!plain) {
					throw new Error("Empty plain translation from model");
				}
				return { translation: plain, usage: data.usage };
			}

			const parsed = parseLongFormModelResponse(
				content,
				longFormTranslationSchema,
				"translation",
			);
			return { translation: parsed.translation.trim(), usage: data.usage };
		} catch (e) {
			lastErr = e;
			if (attempt < 2) {
				console.warn(
					`[videoTranslate-long] translation LLM retry (${attempt + 1}/2): ${e?.message || e}`,
				);
			}
		}
	}
	throw lastErr instanceof Error
		? lastErr
		: new Error(String(lastErr));
}

async function ffmpegExtractAudioSegmentForAsr(
	inputPath,
	outWavPath,
	startSec,
	durationSec,
) {
	await execFfmpeg(
		[
			"-y",
			"-ss",
			String(Math.max(0, startSec)),
			"-i",
			inputPath,
			"-t",
			String(Math.max(0.1, durationSec)),
			"-vn",
			"-acodec",
			"pcm_s16le",
			"-ar",
			"16000",
			"-ac",
			"1",
			outWavPath,
		],
		"ffmpeg extract ASR audio segment",
	);
}

async function transcribeAudioBufferWithOpenRouter({
	audioBuffer,
	signal,
	model,
}) {
	const modelId = model?.trim() || geminiVideoModel();
	const base64 = audioBuffer.toString("base64");
	const messages = [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: 'Transcribe the spoken content verbatim. Reply with ONLY compact JSON: {"transcript":"<spoken text>","source_language":"<ISO 639-1 e.g. en>"}. Keep transcript as one string; escape quotes inside as \\".',
				},
				{
					type: "input_audio",
					input_audio: { data: base64, format: "wav" },
				},
			],
		},
	];

	let lastErr;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const { res, data } = await fetchGeminiVideoJsonCompletion({
				model: modelId,
				messages,
				temperature: attempt === 0 ? 0.1 : 0.05,
				signal,
				jsonObjectResponse: true,
			});
			if (!res.ok || data.error) {
				throw new Error(
					String(
						data?.error?.message ||
							data?.error ||
							`Audio transcription HTTP ${res.status}`,
					),
				);
			}
			const content = data.choices?.[0]?.message?.content;
			if (!content || typeof content !== "string") {
				throw new Error("Empty audio transcription from model");
			}
			const parsed = parseLongFormModelResponse(
				content,
				longFormTranscriptSchema,
				"transcript",
			);
			const sourceLanguage = parsed.source_language
				? String(parsed.source_language).trim().slice(0, 2)
				: null;
			return {
				transcript: parsed.transcript.trim(),
				sourceLanguage,
				usage: data.usage,
			};
		} catch (e) {
			lastErr = e;
			if (attempt === 0) {
				console.warn(
					`[videoTranslate-long] audio ASR JSON retry: ${e?.message || e}`,
				);
			}
		}
	}
	throw lastErr instanceof Error
		? lastErr
		: new Error(String(lastErr));
}

async function transcribeLongFormAudioFromVideo({
	videoPath,
	model,
	signal,
	onProgress,
	onChunkDone,
}) {
	const durationSec = await getMediaDurationSeconds(videoPath);
	if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) {
		throw new Error("Unable to determine video duration for audio transcription");
	}

	const workDir = path.dirname(videoPath);
	const fullWav = path.join(workDir, "asr_full.wav");
	await ffmpegExtractAudioForAsr(videoPath, fullWav);
	const fullBuffer = await fsp.readFile(fullWav);
	await fsp.unlink(fullWav).catch(() => {});

	if (fullBuffer.length <= LONG_ASR_AUDIO_MAX_BYTES) {
		if (onProgress) await onProgress({ chunkIdx: 0, totalChunks: 1 });
		try {
			const single = await transcribeAudioBufferWithOpenRouter({
				audioBuffer: fullBuffer,
				signal,
				model,
			});
			if (onChunkDone) {
				await onChunkDone({
					chunkIdx: 0,
					totalChunks: 1,
					ok: true,
					textLen: String(single.transcript || "").length,
				});
			}
			return {
				segments: [
					{
						start_ms: 0,
						end_ms: Math.floor(durationSec * 1000),
						text: single.transcript,
					},
				],
				sourceLanguage: single.sourceLanguage,
				usage: single.usage,
			};
		} catch (e) {
			if (onChunkDone) {
				await onChunkDone({
					chunkIdx: 0,
					totalChunks: 1,
					ok: false,
					error: e?.message || String(e),
				});
			}
			throw e;
		}
	}

	const chunkSec = LONG_ASR_CHUNK_SEC;
	const segments = [];
	let sourceLanguage = null;
	let mergedUsage = mergeOpenRouterUsage(null, null);
	const totalChunks = Math.ceil(durationSec / chunkSec);

	for (let startSec = 0, idx = 0; startSec < durationSec; startSec += chunkSec, idx++) {
		const chunkDuration = Math.min(chunkSec, durationSec - startSec);
		const chunkWav = path.join(workDir, `asr_chunk_${idx}.wav`);
		if (onProgress) {
			await onProgress({ chunkIdx: idx, totalChunks });
		}
		try {
			await ffmpegExtractAudioSegmentForAsr(
				videoPath,
				chunkWav,
				startSec,
				chunkDuration,
			);
			const chunkBuffer = await fsp.readFile(chunkWav);
			if (chunkBuffer.length > LONG_ASR_AUDIO_MAX_BYTES) {
				throw new Error(
					`ASR audio chunk too large (${chunkBuffer.length} bytes)`,
				);
			}
			const chunk = await transcribeAudioBufferWithOpenRouter({
				audioBuffer: chunkBuffer,
				signal,
				model,
			});
			const text = String(chunk.transcript || "").trim();
			if (text) {
				segments.push({
					start_ms: Math.floor(startSec * 1000),
					end_ms: Math.floor((startSec + chunkDuration) * 1000),
					text,
				});
			}
			if (!sourceLanguage && chunk.sourceLanguage) {
				sourceLanguage = chunk.sourceLanguage;
			}
			mergedUsage = mergeOpenRouterUsage(mergedUsage, chunk.usage);
			if (onChunkDone) {
				await onChunkDone({
					chunkIdx: idx,
					totalChunks,
					ok: true,
					textLen: text.length,
				});
			}
		} catch (e) {
			if (onChunkDone) {
				await onChunkDone({
					chunkIdx: idx,
					totalChunks,
					ok: false,
					error: e?.message || String(e),
				});
			}
			throw e;
		} finally {
			await fsp.unlink(chunkWav).catch(() => {});
		}
	}

	if (!segments.length) {
		throw new Error("Audio transcription produced no text");
	}
	return { segments, sourceLanguage, usage: mergedUsage };
}

/**
 * Run async work over items with limited parallelism.
 * Does not throw on item failure — returns settled results.
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<unknown>} fn
 * @returns {Promise<{ idx: number, ok: boolean, value?: any, error?: string }[]>}
 */
async function mapPoolSettled(items, concurrency, fn) {
	const results = new Array(items.length);
	let next = 0;
	const limit = Math.max(1, Math.min(concurrency, items.length || 1));
	async function worker() {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			try {
				const value = await fn(items[i], i);
				results[i] = { idx: i, ok: true, value };
			} catch (e) {
				results[i] = {
					idx: i,
					ok: false,
					error: e?.message || String(e),
				};
			}
		}
	}
	await Promise.all(Array.from({ length: limit }, () => worker()));
	return results;
}

function isNonRetryableProviderError(err) {
	const msg = String(err?.message || err || "").toLowerCase();
	return (
		/internal server error/.test(msg) ||
		/http 5\d\d/.test(msg) ||
		/provider.*(error|unavailable|overloaded)/.test(msg) ||
		/rate.?limit|quota|insufficient/.test(msg) ||
		/context.?length|too many tokens|payload.?too.?large/.test(msg)
	);
}

/**
 * Split a local video into fixed-length MP4 chunks (re-encoded for clean concat).
 * @returns {Promise<string[]>} absolute paths in order
 */
async function ffmpegSplitVideoIntoChunks(videoPath, chunksDir, chunkSec) {
	await fsp.mkdir(chunksDir, { recursive: true });
	const durationSec = await getMediaDurationSeconds(videoPath);
	if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) {
		throw new Error("Unable to determine video duration for chunking");
	}
	const sec = Math.max(20, Number(chunkSec) || LONG_VIDEO_CHUNK_SEC);
	const paths = [];
	let idx = 0;
	for (let start = 0; start < durationSec; start += sec, idx++) {
		const len = Math.min(sec, durationSec - start);
		if (len < 0.25) break;
		const outPath = path.join(
			chunksDir,
			`chunk_${String(idx).padStart(3, "0")}.mp4`,
		);
		await execFfmpeg(
			[
				"-y",
				"-ss",
				String(start),
				"-i",
				videoPath,
				"-t",
				String(len),
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-crf",
				"23",
				"-c:a",
				"aac",
				"-b:a",
				"128k",
				"-movflags",
				"+faststart",
				"-avoid_negative_ts",
				"make_zero",
				outPath,
			],
			`ffmpeg split chunk ${idx}`,
		);
		paths.push(outPath);
	}
	if (!paths.length) {
		throw new Error("Video split produced no chunks");
	}
	return paths;
}

/** Concat MP4s with identical codecs via ffmpeg concat demuxer. */
async function ffmpegConcatVideoChunks(chunkPaths, outPath) {
	const listPath = `${outPath}.concat.txt`;
	const body = chunkPaths
		.map((p) => `file '${String(p).replace(/'/g, "'\\''")}'`)
		.join("\n");
	await fsp.writeFile(listPath, body, "utf8");
	await execFfmpeg(
		[
			"-y",
			"-f",
			"concat",
			"-safe",
			"0",
			"-i",
			listPath,
			"-c",
			"copy",
			outPath,
		],
		"ffmpeg concat long chunks",
	);
}

/**
 * Long-form chunk dub: ffmpeg audio → ASR → text translate → TTS → mux.
 * Does NOT send the video as base64 to Gemini (avoids ~50k token video bills).
 */
async function dubLocalVideoChunkToFile({
	videoPath,
	outPath,
	job,
	signal,
}) {
	const workDir = path.join(
		path.dirname(outPath),
		`work_${path.basename(outPath, ".mp4")}`,
	);
	await fsp.mkdir(workDir, { recursive: true });
	try {
		const transEngine = normalizeVideoTranslationEngine(job.translation_engine);
		const ttsEng = normalizeOpenRouterTtsEngine(job.tts_engine);
		let mergedOpenRouterUsage = mergeOpenRouterUsage(null, null);
		let bulkMtModel = null;
		let effectiveTransEngine = "llm";

		const wavPath = path.join(workDir, "asr.wav");
		await ffmpegExtractAudioForAsr(videoPath, wavPath);
		const audioBuffer = await fsp.readFile(wavPath);
		if (audioBuffer.length > LONG_ASR_AUDIO_MAX_BYTES) {
			throw new Error(
				`Chunk ASR audio too large (${audioBuffer.length} bytes). Lower LONG_VIDEO_CHUNK_SEC.`,
			);
		}

		const asr = await transcribeAudioBufferWithOpenRouter({
			audioBuffer,
			signal,
			model: job.gemini_model,
		});
		mergedOpenRouterUsage = mergeOpenRouterUsage(
			mergedOpenRouterUsage,
			asr.usage,
		);
		const transcript = String(asr.transcript || "").trim();
		if (!transcript) {
			// Keep original chunk video so concat stays full-length.
			await fsp.copyFile(videoPath, outPath);
			return {
				transcript: "",
				translation: "",
				usage: mergedOpenRouterUsage,
				bulkMtModel: null,
				translationEngine: "skipped_empty",
				ttsEngine: ttsEng,
				dubbed: false,
			};
		}

		let translation = "";
		if (transEngine === "nllb") {
			const nllbOk = await isNllbRuntimeReady();
			const tgtNllb = targetLanguageLabelToNllb(job.output_language);
			if (nllbOk && tgtNllb) {
				let srcNllb = null;
				if (
					job.transcript_source_nllb &&
					String(job.transcript_source_nllb).includes("_")
				) {
					srcNllb = String(job.transcript_source_nllb).trim();
				} else if (job.transcript_language_hint) {
					srcNllb = whisperIsoToNllbSource(
						String(job.transcript_language_hint).toLowerCase().slice(0, 2),
					);
				} else if (asr.sourceLanguage) {
					srcNllb = looseIsoToNllbSource(asr.sourceLanguage) || "eng_Latn";
				}
				if (!srcNllb) srcNllb = "eng_Latn";
				try {
					const nllbOut = await translateTextWithNllb({
						text: transcript,
						srcLang: srcNllb,
						tgtLang: tgtNllb,
						signal,
					});
					translation = nllbOut.translation;
					bulkMtModel = nllbOut.model;
					effectiveTransEngine = "nllb";
				} catch (nllbErr) {
					console.warn(
						`[videoTranslate-long] chunk NLLB failed, LLM fallback: ${nllbErr?.message || nllbErr}`,
					);
				}
			}
		}

		if (!translation) {
			const t = await translateTranscriptTextLlm({
				transcript,
				targetLanguage: job.output_language,
				model: job.gemini_model,
				signal,
			});
			translation = t.translation;
			mergedOpenRouterUsage = mergeOpenRouterUsage(
				mergedOpenRouterUsage,
				t.usage,
			);
			effectiveTransEngine = "llm";
		}

		translation = String(translation || "").trim();
		if (!translation) {
			throw new Error("Chunk dubbing produced empty translation");
		}

		let ttsBuf;
		let ttsUsage = mergeOpenRouterUsage(null, null);
		if (ttsEng === "piper") {
			ttsBuf = await piperSynthesizeWav({
				text: translation,
				modelPath: job.piper_model || null,
				signal,
			});
		} else {
			const t = await ttsSynthesizeToBuffer({
				text: translation,
				signal,
				voice: job.tts_voice || undefined,
			});
			ttsBuf = t.buffer;
			ttsUsage = t.usage;
		}
		mergedOpenRouterUsage = mergeOpenRouterUsage(mergedOpenRouterUsage, ttsUsage);

		const mutedPath = path.join(workDir, "muted.mp4");
		const pcmPath = path.join(workDir, "speech.pcm");
		const chunkDurationSec = await getMediaDurationSeconds(videoPath);

		if (ttsEng === "piper") {
			const ttsWavPath = path.join(workDir, "piper_tts.wav");
			await fsp.writeFile(ttsWavPath, ttsBuf);
			await ffmpegStripAudio(videoPath, mutedPath);
			if (
				chunkDurationSec != null &&
				Number.isFinite(chunkDurationSec) &&
				chunkDurationSec > 0
			) {
				await execFfmpeg(
					[
						"-y",
						"-i",
						mutedPath,
						"-i",
						ttsWavPath,
						"-c:v",
						"copy",
						"-filter_complex",
						`[1:a]apad=whole_dur=${chunkDurationSec}[a]`,
						"-map",
						"0:v:0",
						"-map",
						"[a]",
						"-c:a",
						"aac",
						"-t",
						String(chunkDurationSec),
						outPath,
					],
					"ffmpeg mux wav + chunk video (full duration)",
				);
			} else {
				await ffmpegMuxWavWithVideo(mutedPath, ttsWavPath, outPath);
			}
		} else {
			let pcmBuf = ttsBuf;
			if (
				chunkDurationSec != null &&
				Number.isFinite(chunkDurationSec) &&
				chunkDurationSec > 0
			) {
				const track = createSilentPcmBuffer(
					chunkDurationSec,
					TTS_PCM_SAMPLE_RATE,
				);
				overlayPcmS16le(track, ttsBuf, 0);
				pcmBuf = track;
			}
			await fsp.writeFile(pcmPath, pcmBuf);
			await ffmpegStripAudio(videoPath, mutedPath);
			if (
				chunkDurationSec != null &&
				Number.isFinite(chunkDurationSec) &&
				chunkDurationSec > 0
			) {
				await ffmpegMuxPcm16WithVideoFullDuration(
					mutedPath,
					pcmPath,
					outPath,
					chunkDurationSec,
				);
			} else {
				await ffmpegMuxPcm16WithVideo(mutedPath, pcmPath, outPath);
			}
		}

		return {
			transcript,
			translation,
			usage: mergedOpenRouterUsage,
			bulkMtModel,
			translationEngine: effectiveTransEngine,
			ttsEngine: ttsEng,
			dubbed: true,
		};
	} finally {
		await rmDirSafe(workDir);
	}
}

async function dubLocalVideoChunkWithRetries(opts) {
	const retries = Math.max(0, LONG_VIDEO_CHUNK_RETRIES);
	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await dubLocalVideoChunkToFile(opts);
		} catch (e) {
			lastErr = e;
			if (isNonRetryableProviderError(e)) {
				console.warn(
					`[videoTranslate-long] non-retryable chunk error (no rebill): ${e?.message || e}`,
				);
				break;
			}
			if (attempt < retries) {
				console.warn(
					`[videoTranslate-long] chunk retry ${attempt + 1}/${retries}: ${e?.message || e}`,
				);
			}
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function translateLongStoredSourceVideoJob(jobId, signal) {
	const job = await readJobOrThrow(jobId);
	const tracker = createLongStepTracker(jobId);

	const planCaps = resolvePlanCaps(job.plan);
	const storedBytes = Number.parseInt(String(job.max_video_bytes || ""), 10);
	const maxVideoBytes = Math.max(
		planCaps.maxVideoBytes,
		Number.isFinite(storedBytes) && storedBytes > 0 ? storedBytes : 0,
	);
	const storedMinutes = Number.parseInt(String(job.max_minutes || ""), 10);
	const maxMinutes = Math.max(
		planCaps.maxMinutes,
		Number.isFinite(storedMinutes) && storedMinutes > 0 ? storedMinutes : 0,
	);

	const inputUrl = String(job.video_url || "").trim();
	if (!inputUrl) {
		throw new Error("Missing video_url on job");
	}

	tracker.upsert({
		id: "download",
		stage: "download",
		status: "running",
		detail: shortUrlForLog(inputUrl),
	});
	await patchJob(jobId, {
		status: "running",
		phase: "download",
		status_message: `Downloading source video (${shortUrlForLog(inputUrl)})...`,
		original_video_url: String(job.original_video_url || inputUrl).trim(),
		step_results: tracker.snapshot(),
		chunk_results: [],
		updatedAt: FieldValue.serverTimestamp(),
	});

	let tmpDir;
	let bulkMtModel = null;
	try {
		let videoPath;
		let buffer;
		try {
			const dl = await downloadVideoToTempFile(
				inputUrl,
				signal,
				maxVideoBytes,
				maxMinutes,
				{ preferYtDlpForYoutube: true },
			);
			videoPath = dl.videoPath;
			tmpDir = dl.tmpDir;
			buffer = dl.buffer;
		} catch (dlErr) {
			tracker.upsert({
				id: "download",
				stage: "download",
				status: "failed",
				error: dlErr?.message || String(dlErr),
				detail: shortUrlForLog(inputUrl),
			});
			await tracker.flush({
				status: "failed",
				phase: "download",
				error: dlErr?.message || String(dlErr),
				status_message: null,
			});
			throw dlErr;
		}

		const durationSec = await getMediaDurationSeconds(videoPath);
		if (
			durationSec == null ||
			!Number.isFinite(durationSec) ||
			durationSec <= 0
		) {
			throw new Error("Unable to determine video duration for long-form dub");
		}
		tracker.upsert({
			id: "download",
			stage: "download",
			status: "success",
			detail: `${buffer.length} bytes, ${durationSec.toFixed(1)}s`,
		});
		console.log(
			`[videoTranslate-long] job ${jobId} downloaded ${buffer.length} bytes (${durationSec.toFixed(1)}s) — SRT/batch-text pipeline`,
		);

		const captionSourceUrl = String(
			job.original_video_url || job.video_url || "",
		).trim();

		tracker.upsert({
			id: "captions",
			stage: "captions",
			status: "running",
			detail: shortUrlForLog(captionSourceUrl),
		});
		await patchJob(jobId, {
			phase: "captions",
			status_message: "Building timed transcript / SRT...",
			download_completed_at: FieldValue.serverTimestamp(),
			download_skipped: false,
			download_skip_reason: "long_srt_batch_local",
			step_results: tracker.snapshot(),
			updatedAt: FieldValue.serverTimestamp(),
		});

		let timedResult = await tryResolveLongFormTimedSegments({
			videoUrl: captionSourceUrl,
			videoPath,
			extractEmbeddedSrt: ffmpegExtractEmbeddedSrt,
		});
		let mergedOpenRouterUsage = mergeOpenRouterUsage(null, null);

		if (timedResult?.segments?.length) {
			tracker.upsert({
				id: "captions",
				stage: "captions",
				status: "success",
				detail: `${timedResult.source}: ${timedResult.segments.length} cues`,
			});
			console.log(
				`[videoTranslate-long] job ${jobId} timed SRT from ${timedResult.source} (${timedResult.segments.length} cues)`,
			);
		} else {
			tracker.upsert({
				id: "captions",
				stage: "captions",
				status: "success",
				detail: "none — falling back to audio ASR",
			});
			await patchJob(jobId, {
				phase: "transcribing",
				status_message: "Transcribing full audio once (no captions)...",
				step_results: tracker.snapshot(),
				updatedAt: FieldValue.serverTimestamp(),
			});
			console.log(
				`[videoTranslate-long] job ${jobId} no captions — one-pass audio ASR for timed segments`,
			);
			const asr = await transcribeLongFormAudioFromVideo({
				videoPath,
				model: job.gemini_model,
				signal,
				onProgress: async ({ chunkIdx, totalChunks }) => {
					tracker.upsert({
						id: `asr_${chunkIdx}`,
						stage: "asr",
						index: chunkIdx,
						status: "running",
						detail: `chunk ${chunkIdx + 1}/${totalChunks}`,
						persist: false,
					});
					await patchJobSafe(jobId, {
						status_message: `Transcribing audio ${chunkIdx + 1}/${totalChunks}...`,
						long_chunk_total: totalChunks,
						long_chunk_done: chunkIdx,
						updatedAt: FieldValue.serverTimestamp(),
					});
				},
				onChunkDone: async ({ chunkIdx, totalChunks, ok, error, textLen }) => {
					tracker.upsert({
						id: `asr_${chunkIdx}`,
						stage: "asr",
						index: chunkIdx,
						status: ok ? "success" : "failed",
						error: ok ? null : error || "ASR chunk failed",
						detail: ok
							? `chunk ${chunkIdx + 1}/${totalChunks}, ${textLen || 0} chars`
							: `chunk ${chunkIdx + 1}/${totalChunks}`,
						persist: !ok,
					});
					if (!ok) {
						await tracker.flush({
							status_message: `Transcribing audio ${chunkIdx + 1}/${totalChunks}...`,
							long_chunk_done: chunkIdx + 1,
							long_chunk_failed: tracker.failCount(),
						});
					}
				},
			});
			mergedOpenRouterUsage = mergeOpenRouterUsage(
				mergedOpenRouterUsage,
				asr.usage,
			);
			timedResult = {
				segments: asr.segments,
				sourceLanguage: asr.sourceLanguage,
				source: "audio_asr",
			};
		}

		const segments = timedResult.segments;
		const sourceLanguage = timedResult.sourceLanguage;
		const transcriptSource = timedResult.source;
		const transcript = segments
			.map((s) => String(s.text || "").trim())
			.filter(Boolean)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (!transcript) {
			tracker.upsert({
				id: "transcript",
				stage: "transcript",
				status: "failed",
				error: "No transcript / SRT text available",
			});
			await tracker.flush();
			throw new Error("No transcript / SRT text available for long-form dub");
		}

		const ttsGroups = mergeSegmentsForTts(segments, LONG_VIDEO_TTS_MERGE_CHARS);
		const transEngineRequested = normalizeVideoTranslationEngine(
			job.translation_engine,
		);
		const ttsEng = normalizeOpenRouterTtsEngine(job.tts_engine);
		const glossaryRef = job.glossary_refinement === true;

		tracker.upsert({
			id: "translate",
			stage: "translate",
			status: "running",
			detail: `${ttsGroups.length} cue groups, engine=${transEngineRequested}`,
		});
		await patchJob(jobId, {
			phase: "translating",
			status_message: `Translating SRT batches (0/${ttsGroups.length} cues)...`,
			transcript_original: transcript,
			caption_source: transcriptSource,
			long_chunk_total: ttsGroups.length,
			long_chunk_done: 0,
			step_results: tracker.snapshot(),
			updatedAt: FieldValue.serverTimestamp(),
		});

		const {
			translatedGroups,
			usage: mtUsage,
			engine: effectiveTransEngine,
			bulkMtModel: mtModel,
		} = await translateTimedGroupsInBatches({
			groups: ttsGroups,
			job,
			sourceLanguage,
			transEngineRequested,
			signal,
			onProgress: async (done, total) => {
				tracker.upsert({
					id: `translate_${done}`,
					stage: "translate",
					index: done,
					status: "running",
					detail: `cue ${Math.min(done + 1, total)}/${total}`,
				});
				await patchJob(jobId, {
					status_message: `Translating SRT batches (${Math.min(done + 1, total)}/${total} cues)...`,
					long_chunk_done: Math.min(done + 1, total),
					step_results: tracker.snapshot(),
					updatedAt: FieldValue.serverTimestamp(),
				});
			},
			onBatchDone: async ({ batchIndex, from, to, ok, error }) => {
				tracker.upsert({
					id: `translate_batch_${batchIndex}`,
					stage: "translate_batch",
					index: batchIndex,
					status: ok ? "success" : "failed",
					error: ok ? null : error || "batch translate failed",
					detail: `cues ${from}-${to}`,
				});
				await tracker.flush();
			},
		});
		mergedOpenRouterUsage = mergeOpenRouterUsage(mergedOpenRouterUsage, mtUsage);
		if (mtModel) bulkMtModel = mtModel;
		tracker.upsert({
			id: "translate",
			stage: "translate",
			status: "success",
			detail: `engine=${effectiveTransEngine}, ${translatedGroups.length} groups`,
		});

		let translation = translatedGroups
			.map((g) => String(g.translatedText || "").trim())
			.filter(Boolean)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();

		if (glossaryRef && translation) {
			tracker.upsert({
				id: "glossary",
				stage: "glossary",
				status: "running",
			});
			const gModel =
				String(job.glossary_refine_model || "").trim() ||
				OPENROUTER_GLOSSARY_REFINE_MODEL;
			try {
				const refined = await refineTranslationGlossaryOpenRouter({
					translation,
					targetLanguage: job.output_language,
					model: gModel,
					signal,
				});
				translation = refined.translation;
				mergedOpenRouterUsage = mergeOpenRouterUsage(
					mergedOpenRouterUsage,
					refined.usage,
				);
				tracker.upsert({
					id: "glossary",
					stage: "glossary",
					status: "success",
				});
			} catch (gErr) {
				tracker.upsert({
					id: "glossary",
					stage: "glossary",
					status: "failed",
					error: gErr?.message || String(gErr),
				});
				console.warn(
					`[videoTranslate-long] job ${jobId} glossary refine failed (continuing): ${gErr?.message || gErr}`,
				);
			}
		}

		tracker.upsert({
			id: "tts",
			stage: "tts",
			status: "running",
			detail: `${translatedGroups.length} groups, concurrency=${LONG_VIDEO_TTS_CONCURRENCY}`,
		});
		await patchJob(jobId, {
			phase: "dubbing",
			status_message: `Synthesizing timed speech (${translatedGroups.length} groups)...`,
			translated_transcript: translation,
			step_results: tracker.snapshot(),
			updatedAt: FieldValue.serverTimestamp(),
		});

		const { buffer: ttsBuf, usage: ttsUsage } =
			await synthesizeLongFormTimedDubTrack({
				groups: translatedGroups,
				durationSec,
				ttsEng,
				job,
				signal,
				tmpDir,
				onProgress: async (idx, total) => {
					await patchJobSafe(jobId, {
						status_message: `Synthesizing speech ${idx + 1}/${total}...`,
						updatedAt: FieldValue.serverTimestamp(),
					});
				},
				onGroupDone: async ({ index, total, ok, error }) => {
					tracker.upsert({
						id: `tts_${index}`,
						stage: "tts",
						index,
						status: ok ? "success" : "failed",
						error: ok ? null : error || "TTS failed",
						detail: `group ${index + 1}/${total}`,
						persist: !ok,
					});
					// Do not flush on every success — burns Firestore quota.
					if (!ok) {
						await tracker.flush({
							long_chunk_done: index + 1,
							long_chunk_failed: tracker.failCount(),
						});
					}
				},
			});
		mergedOpenRouterUsage = mergeOpenRouterUsage(mergedOpenRouterUsage, ttsUsage);
		tracker.upsert({
			id: "tts",
			stage: "tts",
			status: "success",
			detail: `track ${ttsBuf.length} bytes PCM`,
		});
		const usagePayload = buildUsageResponseFields(mergedOpenRouterUsage);

		const mutedPath = path.join(tmpDir, "muted_video.mp4");
		const pcmPath = path.join(tmpDir, "speech.pcm");
		const finalPath = path.join(tmpDir, "final_output.mp4");

		await waitForTmpSpace(
			Math.floor(
				buffer.length * 1.5 + ttsBuf.length + TMP_SPACE_BASE_BUFFER_BYTES,
			),
			"ffmpeg mux/output",
			signal,
		);

		tracker.upsert({
			id: "mux",
			stage: "mux",
			status: "running",
		});
		await patchJobSafe(jobId, {
			phase: "uploading",
			status_message: "Muxing + uploading dubbed video...",
			step_results: tracker.snapshot(),
			updatedAt: FieldValue.serverTimestamp(),
		});

		await fsp.writeFile(pcmPath, ttsBuf);
		await ffmpegStripAudio(videoPath, mutedPath);
		await ffmpegMuxPcm16WithVideoFullDuration(
			mutedPath,
			pcmPath,
			finalPath,
			durationSec,
		);
		tracker.upsert({ id: "mux", stage: "mux", status: "success" });

		tracker.upsert({ id: "upload", stage: "upload", status: "running" });
		const finalBuf = await fsp.readFile(finalPath);
		const translatedVideoUrl = await uploadMp4Buffer(finalBuf, jobId);
		const captionUrl = await uploadVttFromText(translation, jobId).catch(
			() => null,
		);
		tracker.upsert({
			id: "upload",
			stage: "upload",
			status: "success",
			detail: shortUrlForLog(translatedVideoUrl),
		});

		await tracker.flush({
			status: "success",
			phase: "done",
			transcript_original: transcript,
			translated_transcript: translation,
			caption_text: translation,
			translated_video_url: translatedVideoUrl,
			final_video_url: translatedVideoUrl,
			caption_url: captionUrl,
			caption_source: transcriptSource,
			partial: tracker.failCount() > 0,
			long_chunk_total: ttsGroups.length,
			long_chunk_done: ttsGroups.length,
			long_chunk_failed: tracker.failCount(),
			...usagePayload,
			translation_engine: effectiveTransEngine,
			tts_engine: ttsEng,
			glossary_refinement: glossaryRef,
			bulk_mt_model: bulkMtModel,
			error:
				tracker.failCount() > 0
					? `${tracker.failCount()} step(s) had errors; see steps[] / chunks[]`
					: null,
			status_message:
				tracker.failCount() > 0
					? `Completed with ${tracker.failCount()} step warning(s)`
					: null,
		});
	} catch (e) {
		const msg = e?.message || String(e);
		console.error(
			`[videoTranslate-long] job ${jobId} FAILED: ${msg}`,
			e?.stack || "",
		);
		tracker.upsert({
			id: "job",
			stage: "job",
			status: "failed",
			error: msg,
		});
		await tracker.flush({
			status: "failed",
			phase: "translate",
			error: msg,
			long_chunk_failed: tracker.failCount(),
			status_message: null,
		});
		throw e;
	} finally {
		if (tmpDir) await rmDirSafe(tmpDir);
	}
}

async function processVideoTranslateLongJob(jobId) {
	const signal = AbortSignal.timeout(LONG_VIDEO_TRANSLATE_TIMEOUT_MS);
	await acquireVideoJobSlot(signal);
	try {
		await translateLongStoredSourceVideoJob(jobId, signal);
	} finally {
		releaseVideoJobSlot();
	}
}
