
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
import { translateTextWithNllb } from "./nllbTranslate.js";
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

export const MAX_VIDEO_BYTES =
	Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES || "", 10) ||
	200 * 1024 * 1024;
const OPENROUTER_VIDEO_TIMEOUT_MS =
	Number.parseInt(process.env.OPENROUTER_VIDEO_TIMEOUT_MS || "", 10) || 600_000;

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
/**
 * Videos longer than this (seconds) are split with ffmpeg into chunk jobs,
 * translated in parallel (bounded by VIDEO_TRANSLATE_MAX_CONCURRENT_JOBS), then concatenated.
 */
const VIDEO_TRANSLATE_CHUNK_THRESHOLD_SEC =
	Number.parseInt(process.env.VIDEO_TRANSLATE_CHUNK_THRESHOLD_SEC || "", 10) ||
	240;
/** Target length of each source chunk sent to Gemini / TTS. */
const VIDEO_TRANSLATE_CHUNK_SEC =
	Number.parseInt(process.env.VIDEO_TRANSLATE_CHUNK_SEC || "", 10) || 180;
const VIDEO_TRANSLATE_DISABLE_CHUNKING =
	process.env.VIDEO_TRANSLATE_DISABLE_CHUNKING === "1" ||
	process.env.VIDEO_TRANSLATE_DISABLE_CHUNKING === "true";
/** ffmpeg timeout for split/concat of long videos (ms). */
const VIDEO_TRANSLATE_FFMPEG_LONG_TIMEOUT_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_FFMPEG_LONG_TIMEOUT_MS || "", 10) ||
	30 * 60 * 1000;
const PLAN_CAPS = {
	free: {
		maxVideoBytes:
			Number.parseInt(
				process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES_FREE || "",
				10,
			) || MAX_VIDEO_BYTES,
		maxMinutes:
			Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_MINUTES_FREE || "", 10) || 10,
	},
	pro: {
		maxVideoBytes:
			Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES_PRO || "", 10) ||
			MAX_VIDEO_BYTES,
		maxMinutes:
			Number.parseInt(process.env.VIDEO_TRANSLATE_MAX_MINUTES_PRO || "", 10) || 30,
	},
	enterprise: {
		maxVideoBytes:
			Number.parseInt(
				process.env.VIDEO_TRANSLATE_MAX_VIDEO_BYTES_ENTERPRISE || "",
				10,
			) ||
			1024 * 1024 * 1024,
		maxMinutes:
			Number.parseInt(
				process.env.VIDEO_TRANSLATE_MAX_MINUTES_ENTERPRISE || "",
				10,
			) || 120,
	},
};

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
			throw new Error(`Failed to download video: HTTP ${res.status}`);
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
	return {
		plan,
		maxVideoBytes: PLAN_CAPS[plan].maxVideoBytes,
		maxMinutes: PLAN_CAPS[plan].maxMinutes,
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

async function enforceDurationLimit(videoPath, maxMinutes) {
	if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) return;
	const secs = await getMediaDurationSeconds(videoPath);
	if (secs == null) {
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

/** youtube.com / youtu.be / shorts / embed — same idea as lib/inkgestAgent.js */
function isYoutubeVideoUrl(url) {
	if (!url || typeof url !== "string") return false;
	return /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)/i.test(
		url.trim(),
	);
}

/**
 * URLs that point at a browser page / player, not a raw media file — plain HTTP fetch would get HTML.
 * Route these through yt-dlp (YouTube, X/Twitter status links, etc.).
 */
function isYtDlpPageVideoUrl(url) {
	if (!url || typeof url !== "string") return false;
	const u = url.trim();
	if (isYoutubeVideoUrl(u)) return true;
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

export async function execFfmpeg(args, label, timeoutMs = 300_000) {
	const ffmpeg = getFfmpegBin();
	await new Promise((resolve, reject) => {
		execFile(
			ffmpeg,
			args,
			{
				timeout: Math.max(30_000, timeoutMs),
				maxBuffer: 20 * 1024 * 1024,
			},
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

/** Cut a time range from source video into a self-contained MP4 (re-encode for clean cuts). */
async function ffmpegExtractChunk(inputPath, outPath, startSec, durationSec) {
	await execFfmpeg(
		[
			"-y",
			"-ss",
			String(Math.max(0, startSec)),
			"-i",
			inputPath,
			"-t",
			String(Math.max(0.1, durationSec)),
			"-c:v",
			"libx264",
			"-preset",
			"fast",
			"-crf",
			"23",
			"-c:a",
			"aac",
			"-ac",
			"2",
			"-ar",
			"44100",
			"-movflags",
			"+faststart",
			outPath,
		],
		`ffmpeg extract chunk @${startSec}s`,
		VIDEO_TRANSLATE_FFMPEG_LONG_TIMEOUT_MS,
	);
}

/** Concatenate ordered MP4 paths via concat demuxer (same codecs). */
async function ffmpegConcatMp4Files(chunkPaths, outPath, workDir) {
	const listPath = path.join(workDir, "concat_list.txt");
	const listBody = chunkPaths
		.map((p) => `file '${String(p).replace(/'/g, "'\\''")}'`)
		.join("\n");
	await fsp.writeFile(listPath, listBody, "utf8");
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
			"-movflags",
			"+faststart",
			outPath,
		],
		"ffmpeg concat translated chunks",
		VIDEO_TRANSLATE_FFMPEG_LONG_TIMEOUT_MS,
	);
}

function buildChunkRanges(durationSec, chunkSec) {
	const total = Math.max(0, Number(durationSec) || 0);
	const size = Math.max(30, Number(chunkSec) || VIDEO_TRANSLATE_CHUNK_SEC);
	if (total <= 0) return [];
	const ranges = [];
	let start = 0;
	let index = 0;
	while (start < total - 0.05) {
		const remaining = total - start;
		const dur = Math.min(size, remaining);
		ranges.push({
			index,
			start_sec: start,
			end_sec: start + dur,
			duration_sec: dur,
		});
		start += dur;
		index += 1;
	}
	return ranges;
}

function resolveChunkingOptions(job) {
	const disabled =
		VIDEO_TRANSLATE_DISABLE_CHUNKING ||
		job?.disable_chunking === true ||
		job?.chunking_enabled === false;
	const threshold = Number.isFinite(Number(job?.chunk_threshold_sec))
		? Number(job.chunk_threshold_sec)
		: VIDEO_TRANSLATE_CHUNK_THRESHOLD_SEC;
	const chunkSec = Number.isFinite(Number(job?.chunk_sec))
		? Math.max(30, Number(job.chunk_sec))
		: VIDEO_TRANSLATE_CHUNK_SEC;
	return { disabled, threshold, chunkSec };
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
export async function ttsSynthesizeToBuffer({ text, signal, voice }) {
	const fallbacks = buildTtsFallbackList();
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
				return { buffer: buf, format: "pcm16", usage: u0 };
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

export async function downloadVideoToTempFile(url, signal, maxVideoBytes, maxMinutes) {
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
		if (isYtDlpPageVideoUrl(url)) {
			const { buf, videoPath } = await downloadViaYtDlp(
				url,
				signal,
				tmpDir,
				maxVideoBytes,
			);
			await enforceDurationLimit(videoPath, maxMinutes);
			return { videoPath, tmpDir, buffer: buf };
		}
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

export async function ffmpegStripAudio(inputPath, outMutedPath) {
	await execFfmpeg(
		["-y", "-i", inputPath, "-an", "-vcodec", "copy", outMutedPath],
		"ffmpeg strip audio",
	);
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
	if (isYtDlpPageVideoUrl(url)) {
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
	const snap = await firestore
		.collection(JOBS_COLL)
		.doc(String(videoTranslateId).trim())
		.get();
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

	let chunksOut = Array.isArray(d.chunks) ? d.chunks : null;
	let chunkIdsOut = Array.isArray(d.chunk_job_ids) ? d.chunk_job_ids : null;
	if (
		d.job_kind === "parent" &&
		Array.isArray(d.chunk_job_ids) &&
		d.chunk_job_ids.length &&
		d.status !== "success"
	) {
		try {
			const chunkIds = d.chunk_job_ids;
			const baseChunks = Array.isArray(d.chunks) ? d.chunks : [];
			const snaps = await Promise.all(
				chunkIds.map((cid) =>
					firestore.collection(JOBS_COLL).doc(cid).get(),
				),
			);
			chunksOut = chunkIds.map((cid, i) => {
				const meta = baseChunks[i] || {
					index: i,
					id: cid,
					start_sec: null,
					end_sec: null,
					duration_sec: null,
				};
				const child = snaps[i]?.exists ? snaps[i].data() : null;
				return publicChunkStatusRow(
					{ ...meta, id: cid, index: meta.index ?? i },
					child,
				);
			});
			chunkIdsOut = chunkIds;
		} catch {
			/* keep stored chunks */
		}
	}

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
		engine: "openrouter-gemini-dub",
		pipeline: {
			translation: d.translation_engine || "llm",
			tts: d.tts_engine || "openrouter",
			...(d.tts_voice ? { tts_voice: d.tts_voice } : {}),
			...(d.tts_voice_id ? { tts_voice_id: d.tts_voice_id } : {}),
			glossary_refinement: d.glossary_refinement === true,
			bulk_mt_model: d.bulk_mt_model ?? null,
			...(d.job_kind === "parent" || d.job_kind === "chunk"
				? { job_kind: d.job_kind }
				: {}),
			...(d.long_pipeline === true ? { long: true, chunked: true } : {}),
		},
		phase: d.phase || null,
		job_kind: d.job_kind || "single",
		parent_job_id: d.parent_job_id || null,
		chunk_index: d.chunk_index ?? null,
		source_duration_sec: d.source_duration_sec ?? null,
		video_translate_ids: chunkIdsOut,
		chunks: chunksOut,
	};
	return { error: null, data: heygenLike, httpStatus: 200 };
}

export async function createVideoTranslateJobs({ videoUrl, body }) {
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

	const video_url = String(videoUrl || "").trim();
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

	const long_pipeline =
		body.long_pipeline === true ||
		body.long_pipeline === "true" ||
		body.long_pipeline === "1" ||
		body.long === true ||
		body.long === "true";
	const disable_chunking =
		!long_pipeline ||
		body.disable_chunking === true ||
		body.disable_chunking === "true" ||
		body.disable_chunking === "1" ||
		body.chunking_enabled === false ||
		body.chunking_enabled === "false" ||
		body.chunking_enabled === "0";
	const chunk_sec_raw = Number.parseInt(
		String(body.chunk_sec ?? body.chunk_duration_sec ?? ""),
		10,
	);
	const chunk_threshold_raw = Number.parseInt(
		String(body.chunk_threshold_sec ?? ""),
		10,
	);

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
		long_pipeline,
		disable_chunking,
		...(long_pipeline && Number.isFinite(chunk_sec_raw) && chunk_sec_raw > 0
			? { chunk_sec: chunk_sec_raw }
			: {}),
		...(long_pipeline &&
		Number.isFinite(chunk_threshold_raw) &&
		chunk_threshold_raw > 0
			? { chunk_threshold_sec: chunk_threshold_raw }
			: {}),
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
		queueProcessVideoJob(id);
	}

	const pipeline = {
		translation: translation_engine,
		tts: tts_engine,
		glossary_refinement,
		...(tts_voice ? { tts_voice, tts_voice_id } : {}),
		...(long_pipeline ? { long: true, chunked: true } : {}),
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

/** Same as createVideoTranslateJobs but enables ffmpeg chunk → parallel translate → concat. */
export async function createVideoTranslateLongJobs({ videoUrl, body }) {
	return createVideoTranslateJobs({
		videoUrl,
		body: { ...(body || {}), long_pipeline: true },
	});
}

function queueProcessVideoJob(jobId) {
	setImmediate(() => {
		processVideoTranslateJob(jobId).catch((err) => {
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

	const maxVideoBytes =
		Number.parseInt(String(job.max_video_bytes || ""), 10) || MAX_VIDEO_BYTES;
	const maxMinutes =
		Number.parseInt(String(job.max_minutes || ""), 10) ||
		resolvePlanCaps(job.plan).maxMinutes;
	const inputUrl = String(job.video_url || "").trim();
	const originalUrl = String(job.original_video_url || inputUrl).trim();

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
		const { buffer, tmpDir: tDir, videoPath } = await downloadVideoToTempFile(
			inputUrl,
			signal,
			maxVideoBytes,
			maxMinutes,
		);
		tmpDir = tDir;

		console.log(
			`[videoTranslate] job ${jobId} downloaded ${buffer.length} bytes, uploading source...`,
		);
		const durationSec = await getMediaDurationSeconds(videoPath);
		const storedUrl = await uploadSourceMp4Buffer(buffer, jobId);
		await patchJob(jobId, {
			stored_source_video_url: storedUrl,
			download_completed_at: FieldValue.serverTimestamp(),
			status_message: "Source video uploaded; starting translation...",
			phase: "translate",
			download_error: null,
			download_skipped: false,
			...(Number.isFinite(durationSec) && durationSec > 0
				? { source_duration_sec: durationSec }
				: {}),
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

	const maxVideoBytes =
		Number.parseInt(String(job.max_video_bytes || ""), 10) || MAX_VIDEO_BYTES;
	const maxMinutes =
		Number.parseInt(String(job.max_minutes || ""), 10) ||
		resolvePlanCaps(job.plan).maxMinutes;

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

async function ensureJobSourceDurationSec(jobId, signal) {
	const job = await readJobOrThrow(jobId);
	const existing = Number(job.source_duration_sec);
	if (Number.isFinite(existing) && existing > 0) return existing;

	const storedUrl = String(job.stored_source_video_url || "").trim();
	if (!storedUrl) {
		throw new Error("Cannot probe duration: source video not stored yet");
	}
	const maxVideoBytes =
		Number.parseInt(String(job.max_video_bytes || ""), 10) || MAX_VIDEO_BYTES;
	const maxMinutes =
		Number.parseInt(String(job.max_minutes || ""), 10) ||
		resolvePlanCaps(job.plan).maxMinutes;
	const { videoPath, tmpDir } = await fetchStoredSourceVideoToTempFile(
		storedUrl,
		signal,
		maxVideoBytes,
		maxMinutes,
	);
	try {
		const durationSec = await getMediaDurationSeconds(videoPath);
		if (!Number.isFinite(durationSec) || durationSec <= 0) {
			throw new Error("Unable to determine source video duration for chunking");
		}
		await patchJob(jobId, {
			source_duration_sec: durationSec,
			updatedAt: FieldValue.serverTimestamp(),
		});
		return durationSec;
	} finally {
		await rmDirSafe(tmpDir);
	}
}

function publicChunkStatusRow(chunkMeta, childDoc) {
	const status = childDoc?.status || "pending";
	return {
		index: chunkMeta.index,
		id: chunkMeta.id,
		start_sec: chunkMeta.start_sec,
		end_sec: chunkMeta.end_sec,
		duration_sec: chunkMeta.duration_sec,
		status,
		url:
			childDoc?.translated_video_url ||
			childDoc?.final_video_url ||
			null,
		error: childDoc?.error || null,
	};
}

async function refreshParentChunkStatuses(parentId) {
	const parent = await readJobOrThrow(parentId);
	const chunkIds = Array.isArray(parent.chunk_job_ids)
		? parent.chunk_job_ids
		: [];
	const baseChunks = Array.isArray(parent.chunks) ? parent.chunks : [];
	const snaps = await Promise.all(
		chunkIds.map((id) => firestore.collection(JOBS_COLL).doc(id).get()),
	);
	const chunks = chunkIds.map((id, i) => {
		const meta = baseChunks[i] || {
			index: i,
			id,
			start_sec: null,
			end_sec: null,
			duration_sec: null,
		};
		const child = snaps[i]?.exists ? snaps[i].data() : null;
		return publicChunkStatusRow({ ...meta, id, index: meta.index ?? i }, child);
	});
	const done = chunks.filter((c) => c.status === "success").length;
	const failed = chunks.filter((c) => c.status === "failed").length;
	const total = chunks.length;
	await patchJob(parentId, {
		chunks,
		chunks_completed: done,
		chunks_failed: failed,
		status_message:
			failed > 0
				? `Chunks: ${done}/${total} done, ${failed} failed`
				: `Translating chunks (${done}/${total})...`,
		updatedAt: FieldValue.serverTimestamp(),
	});
	return { chunks, done, failed, total };
}

/**
 * Split stored source into ffmpeg chunks, upload each, spawn child translate jobs.
 * Parent does not hold a concurrency slot while children run.
 */
async function splitAndSpawnChunkJobs(jobId, signal) {
	const job = await readJobOrThrow(jobId);
	const { chunkSec } = resolveChunkingOptions(job);
	const durationSec = await ensureJobSourceDurationSec(jobId, signal);
	const ranges = buildChunkRanges(durationSec, chunkSec);
	if (ranges.length < 2) {
		await translateStoredSourceVideoJob(jobId, signal);
		return;
	}

	await patchJob(jobId, {
		status: "running",
		phase: "splitting",
		job_kind: "parent",
		status_message: `Splitting ${Math.ceil(durationSec)}s video into ${ranges.length} chunks...`,
		source_duration_sec: durationSec,
		chunk_sec: chunkSec,
		updatedAt: FieldValue.serverTimestamp(),
	});

	const maxVideoBytes =
		Number.parseInt(String(job.max_video_bytes || ""), 10) || MAX_VIDEO_BYTES;
	const maxMinutes =
		Number.parseInt(String(job.max_minutes || ""), 10) ||
		resolvePlanCaps(job.plan).maxMinutes;

	const storedUrl = String(job.stored_source_video_url || "").trim();
	const { videoPath, tmpDir, buffer } = await fetchStoredSourceVideoToTempFile(
		storedUrl,
		signal,
		maxVideoBytes,
		maxMinutes,
	);

	try {
		await waitForTmpSpace(
			Math.floor(buffer.length * 2 + TMP_SPACE_BASE_BUFFER_BYTES),
			"ffmpeg split chunks",
			signal,
		);

		const chunkMeta = [];
		const chunkJobIds = [];

		for (const range of ranges) {
			if (signal?.aborted) {
				const e = new Error("Chunk split aborted");
				e.name = "AbortError";
				throw e;
			}
			const chunkPath = path.join(tmpDir, `chunk_${range.index}.mp4`);
			await ffmpegExtractChunk(
				videoPath,
				chunkPath,
				range.start_sec,
				range.duration_sec,
			);
			const chunkBuf = await fsp.readFile(chunkPath);
			const childId = newJobId();
			const chunkUrl = await uploadSourceMp4Buffer(
				chunkBuf,
				`${jobId}-c${range.index}`,
			);

			const childDoc = {
				id: childId,
				status: "pending",
				job_kind: "chunk",
				parent_job_id: jobId,
				chunk_index: range.index,
				chunk_start_sec: range.start_sec,
				chunk_end_sec: range.end_sec,
				chunk_duration_sec: range.duration_sec,
				video_url: chunkUrl,
				original_video_url: job.original_video_url || job.video_url,
				source_video_url: chunkUrl,
				stored_source_video_url: chunkUrl,
				download_skipped: true,
				download_skip_reason: "parent_chunk",
				download_completed_at: FieldValue.serverTimestamp(),
				output_language: job.output_language,
				title: job.title || null,
				callback_id: job.callback_id || null,
				plan: job.plan,
				max_video_bytes: maxVideoBytes,
				max_minutes: Math.max(
					maxMinutes,
					Math.ceil(range.duration_sec / 60) + 1,
				),
				gemini_model: job.gemini_model,
				llm_preset: job.llm_preset,
				tts_model: job.tts_model,
				translation_engine: job.translation_engine || "llm",
				tts_engine: job.tts_engine || "openrouter",
				...(job.tts_voice
					? { tts_voice: job.tts_voice, tts_voice_id: job.tts_voice_id || null }
					: {}),
				...(job.brand_voice_id
					? { brand_voice_id: job.brand_voice_id }
					: {}),
				glossary_refinement: job.glossary_refinement === true,
				piper_model: job.piper_model || null,
				transcript_source_nllb: job.transcript_source_nllb || null,
				transcript_language_hint: job.transcript_language_hint || null,
				glossary_refine_model: job.glossary_refine_model || null,
				disable_chunking: true,
				source_duration_sec: range.duration_sec,
				createdAt: FieldValue.serverTimestamp(),
				updatedAt: FieldValue.serverTimestamp(),
			};
			await writeJob(childId, childDoc);
			chunkJobIds.push(childId);
			chunkMeta.push({
				index: range.index,
				id: childId,
				start_sec: range.start_sec,
				end_sec: range.end_sec,
				duration_sec: range.duration_sec,
				status: "pending",
				source_chunk_url: chunkUrl,
				url: null,
				error: null,
			});
			console.log(
				`[videoTranslate] parent ${jobId} spawned chunk ${range.index}/${ranges.length - 1} → ${childId} (${range.duration_sec.toFixed(1)}s)`,
			);
		}

		await patchJob(jobId, {
			status: "running",
			phase: "chunks",
			job_kind: "parent",
			chunk_job_ids: chunkJobIds,
			chunks: chunkMeta,
			chunks_total: chunkMeta.length,
			chunks_completed: 0,
			chunks_failed: 0,
			status_message: `Translating ${chunkMeta.length} chunks...`,
			updatedAt: FieldValue.serverTimestamp(),
		});

		for (const childId of chunkJobIds) {
			queueProcessVideoJob(childId);
		}
	} catch (e) {
		const msg = e?.message || String(e);
		await patchJob(jobId, {
			status: "failed",
			phase: "splitting",
			error: msg,
			status_message: null,
			updatedAt: FieldValue.serverTimestamp(),
		});
		throw e;
	} finally {
		await rmDirSafe(tmpDir);
	}
}

async function concatParentChunkVideos(parentId) {
	const parent = await readJobOrThrow(parentId);
	const chunkIds = Array.isArray(parent.chunk_job_ids)
		? parent.chunk_job_ids
		: [];
	if (!chunkIds.length) {
		throw new Error("Parent job has no chunk_job_ids to concatenate");
	}

	const snaps = await Promise.all(
		chunkIds.map((id) => firestore.collection(JOBS_COLL).doc(id).get()),
	);
	const children = snaps.map((s, i) => {
		if (!s.exists) throw new Error(`Missing chunk job ${chunkIds[i]}`);
		return { id: s.id, ...s.data() };
	});
	for (const child of children) {
		if (child.status !== "success") {
			throw new Error(
				`Cannot concat: chunk ${child.id} status is ${child.status}`,
			);
		}
		if (!child.translated_video_url && !child.final_video_url) {
			throw new Error(`Chunk ${child.id} has no translated video URL`);
		}
	}

	children.sort(
		(a, b) => Number(a.chunk_index ?? 0) - Number(b.chunk_index ?? 0),
	);

	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vt-concat-"));
	try {
		const localPaths = [];
		let mergedUsage = mergeOpenRouterUsage(null, null);
		const transcriptParts = [];
		const translationParts = [];

		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			const url = String(
				child.translated_video_url || child.final_video_url,
			).trim();
			const maxBytes =
				Number.parseInt(String(parent.max_video_bytes || ""), 10) ||
				MAX_VIDEO_BYTES;
			const buf = await fetchVideoBufferWithRetries(url, null, maxBytes);
			const localPath = path.join(tmpDir, `out_${i}.mp4`);
			await fsp.writeFile(localPath, buf);
			localPaths.push(localPath);
			mergedUsage = mergeOpenRouterUsage(
				mergedUsage,
				normalizeOpenRouterUsage(child.usage),
			);
			if (child.transcript_original) {
				transcriptParts.push(String(child.transcript_original).trim());
			}
			if (child.translated_transcript || child.caption_text) {
				translationParts.push(
					String(child.translated_transcript || child.caption_text).trim(),
				);
			}
		}

		const finalPath = path.join(tmpDir, "final_concat.mp4");
		await ffmpegConcatMp4Files(localPaths, finalPath, tmpDir);
		const finalBuf = await fsp.readFile(finalPath);
		const translatedVideoUrl = await uploadMp4Buffer(finalBuf, parentId);
		const translation = translationParts.filter(Boolean).join("\n\n");
		const transcript = transcriptParts.filter(Boolean).join("\n\n");
		const captionUrl = translation
			? await uploadVttFromText(translation, parentId).catch(() => null)
			: null;
		const usagePayload = buildUsageResponseFields(mergedUsage);
		const { chunks } = await refreshParentChunkStatuses(parentId).catch(() => ({
			chunks: parent.chunks || null,
		}));

		await patchJob(parentId, {
			status: "success",
			phase: "done",
			transcript_original: transcript || null,
			translated_transcript: translation || null,
			caption_text: translation || null,
			translated_video_url: translatedVideoUrl,
			final_video_url: translatedVideoUrl,
			caption_url: captionUrl,
			chunks,
			...usagePayload,
			error: null,
			status_message: null,
			updatedAt: FieldValue.serverTimestamp(),
		});
		console.log(
			`[videoTranslate] parent ${parentId} concat complete → ${translatedVideoUrl}`,
		);
	} finally {
		await rmDirSafe(tmpDir);
	}
}

/**
 * After a chunk finishes (success or failure), update parent and concat when all succeed.
 */
async function maybeFinalizeParentJob(parentId) {
	if (!parentId) return;
	const parentRef = firestore.collection(JOBS_COLL).doc(String(parentId));

	let shouldConcat = false;
	let failPayload = null;

	try {
		await firestore.runTransaction(async (tx) => {
			const snap = await tx.get(parentRef);
			if (!snap.exists) return;
			const parent = snap.data();
			if (parent.job_kind !== "parent") return;
			if (parent.status === "success") return;
			if (parent.phase === "concat") return;

			const chunkIds = Array.isArray(parent.chunk_job_ids)
				? parent.chunk_job_ids
				: [];
			if (!chunkIds.length) return;

			const childSnaps = await Promise.all(
				chunkIds.map((id) => tx.get(firestore.collection(JOBS_COLL).doc(id))),
			);
			const baseChunks = Array.isArray(parent.chunks) ? parent.chunks : [];
			const chunks = chunkIds.map((id, i) => {
				const meta = baseChunks[i] || { index: i, id };
				const child = childSnaps[i]?.exists ? childSnaps[i].data() : null;
				return publicChunkStatusRow(
					{
						index: meta.index ?? i,
						id,
						start_sec: meta.start_sec ?? null,
						end_sec: meta.end_sec ?? null,
						duration_sec: meta.duration_sec ?? null,
					},
					child,
				);
			});

			const pending = chunks.filter(
				(c) => c.status === "pending" || c.status === "running",
			);
			const failed = chunks.filter((c) => c.status === "failed");
			const done = chunks.filter((c) => c.status === "success");

			if (pending.length > 0) {
				tx.update(parentRef, {
					chunks,
					chunks_completed: done.length,
					chunks_failed: failed.length,
					status: "running",
					phase: "chunks",
					status_message: `Translating chunks (${done.length}/${chunks.length})...`,
					updatedAt: FieldValue.serverTimestamp(),
				});
				return;
			}

			if (failed.length > 0) {
				failPayload = {
					chunks,
					chunks_completed: done.length,
					chunks_failed: failed.length,
					status: "failed",
					phase: "chunks",
					error: `Chunk translation failed (${failed.map((c) => c.id).join(", ")}). Retry failed chunk ids, then parent will re-concat.`,
					status_message: null,
					updatedAt: FieldValue.serverTimestamp(),
				};
				tx.update(parentRef, failPayload);
				return;
			}

			tx.update(parentRef, {
				chunks,
				chunks_completed: done.length,
				chunks_failed: 0,
				status: "running",
				phase: "concat",
				status_message: "Concatenating translated chunks...",
				error: null,
				updatedAt: FieldValue.serverTimestamp(),
			});
			shouldConcat = true;
		});
	} catch (e) {
		console.error(
			`[videoTranslate] maybeFinalizeParentJob(${parentId}) transaction failed:`,
			e?.message || e,
		);
		return;
	}

	if (!shouldConcat) return;

	try {
		await concatParentChunkVideos(parentId);
	} catch (e) {
		const msg = e?.message || String(e);
		console.error(`[videoTranslate] parent ${parentId} concat failed:`, msg);
		await patchJob(parentId, {
			status: "failed",
			phase: "concat",
			error: msg,
			status_message: null,
			updatedAt: FieldValue.serverTimestamp(),
		}).catch(() => {});
	}
}

async function notifyParentAfterChunkJob(jobId) {
	try {
		const job = await readJobOrThrow(jobId);
		if (job.job_kind !== "chunk" || !job.parent_job_id) return;
		await maybeFinalizeParentJob(String(job.parent_job_id));
	} catch (e) {
		console.error(
			`[videoTranslate] notifyParentAfterChunkJob(${jobId}):`,
			e?.message || e,
		);
	}
}

async function processVideoTranslateJob(jobId) {
	const orchestrationTimeoutMs = Math.max(
		OPENROUTER_VIDEO_TIMEOUT_MS,
		VIDEO_TRANSLATE_FFMPEG_LONG_TIMEOUT_MS,
		45 * 60 * 1000,
	);
	const signal = AbortSignal.timeout(orchestrationTimeoutMs);
	await acquireVideoJobSlot(signal);
	try {
		const job = await readJobOrThrow(jobId);

		/** Chunk children already have stored_source_video_url — download is a no-op. */
		await downloadAndUploadSourceVideoForJob(jobId, signal);

		if (job.job_kind === "chunk") {
			await translateStoredSourceVideoJob(jobId, signal);
			return;
		}

		/** Parent already split — do not re-enter split/translate of full source. */
		if (job.job_kind === "parent" && Array.isArray(job.chunk_job_ids) && job.chunk_job_ids.length) {
			await maybeFinalizeParentJob(jobId);
			return;
		}

		const fresh = await readJobOrThrow(jobId);
		if (fresh.long_pipeline === true) {
			const durationSec = await ensureJobSourceDurationSec(jobId, signal);
			const opts = resolveChunkingOptions(fresh);
			const shouldChunk =
				!opts.disabled &&
				durationSec > opts.threshold &&
				buildChunkRanges(durationSec, opts.chunkSec).length >= 2;

			if (shouldChunk) {
				console.log(
					`[videoTranslate] long job ${jobId} duration ${durationSec.toFixed(1)}s > ${opts.threshold}s — chunking @ ${opts.chunkSec}s`,
				);
				await splitAndSpawnChunkJobs(jobId, signal);
				return;
			}
		}

		await translateStoredSourceVideoJob(jobId, signal);
	} finally {
		releaseVideoJobSlot();
		await notifyParentAfterChunkJob(jobId);
	}
}

/**
 * Re-queue a failed chunk (or re-run parent concat). Returns updated status payload shape.
 */
export async function retryVideoTranslateJob(videoTranslateId) {
	if (!videoTranslateId || !String(videoTranslateId).trim()) {
		return {
			error: "Missing video_translate_id",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}
	const id = String(videoTranslateId).trim();
	const snap = await firestore.collection(JOBS_COLL).doc(id).get();
	if (!snap.exists) {
		return {
			error: "Unknown video_translate_id",
			code: "NOT_FOUND",
			httpStatus: 404,
		};
	}
	const d = snap.data();

	if (d.job_kind === "chunk") {
		if (d.status === "running" || d.status === "pending") {
			return {
				error: "Chunk job is already in progress",
				code: "CONFLICT",
				httpStatus: 409,
				data: { video_translate_id: id, status: d.status },
			};
		}
		await patchJob(id, {
			status: "pending",
			phase: "translate",
			error: null,
			status_message: "Retrying chunk translation...",
			translated_video_url: null,
			final_video_url: null,
			caption_url: null,
			updatedAt: FieldValue.serverTimestamp(),
		});
		if (d.parent_job_id) {
			await patchJob(String(d.parent_job_id), {
				status: "running",
				phase: "chunks",
				error: null,
				status_message: "Retrying failed chunk(s)...",
				translated_video_url: null,
				final_video_url: null,
				updatedAt: FieldValue.serverTimestamp(),
			}).catch(() => {});
		}
		queueProcessVideoJob(id);
		return {
			error: null,
			data: {
				video_translate_id: id,
				parent_job_id: d.parent_job_id || null,
				status: "pending",
				retried: true,
				job_kind: "chunk",
			},
			httpStatus: 200,
		};
	}

	if (d.job_kind === "parent") {
		const chunkIds = Array.isArray(d.chunk_job_ids) ? d.chunk_job_ids : [];
		const snaps = await Promise.all(
			chunkIds.map((cid) => firestore.collection(JOBS_COLL).doc(cid).get()),
		);
		const failedIds = snaps
			.filter((s) => s.exists && s.data()?.status === "failed")
			.map((s) => s.id);

		if (failedIds.length) {
			for (const cid of failedIds) {
				await patchJob(cid, {
					status: "pending",
					phase: "translate",
					error: null,
					status_message: "Retrying chunk translation...",
					translated_video_url: null,
					final_video_url: null,
					updatedAt: FieldValue.serverTimestamp(),
				});
			}
			await patchJob(id, {
				status: "running",
				phase: "chunks",
				error: null,
				status_message: `Retrying ${failedIds.length} failed chunk(s)...`,
				translated_video_url: null,
				final_video_url: null,
				updatedAt: FieldValue.serverTimestamp(),
			});
			for (const cid of failedIds) queueProcessVideoJob(cid);
			return {
				error: null,
				data: {
					video_translate_id: id,
					video_translate_ids: failedIds,
					status: "running",
					retried: true,
					job_kind: "parent",
				},
				httpStatus: 200,
			};
		}

		const allSuccess =
			chunkIds.length > 0 &&
			snaps.every((s) => s.exists && s.data()?.status === "success");
		if (allSuccess && d.status !== "success") {
			await patchJob(id, {
				status: "running",
				phase: "concat",
				error: null,
				status_message: "Retrying chunk concatenation...",
				updatedAt: FieldValue.serverTimestamp(),
			});
			setImmediate(() => {
				concatParentChunkVideos(id).catch(async (err) => {
					await patchJob(id, {
						status: "failed",
						phase: "concat",
						error: err?.message || String(err),
						updatedAt: FieldValue.serverTimestamp(),
					}).catch(() => {});
				});
			});
			return {
				error: null,
				data: {
					video_translate_id: id,
					status: "running",
					retried: true,
					job_kind: "parent",
					phase: "concat",
				},
				httpStatus: 200,
			};
		}

		return {
			error:
				"Nothing to retry on parent (no failed chunks, or already successful)",
			code: "CONFLICT",
			httpStatus: 409,
			data: { video_translate_id: id, status: d.status },
		};
	}

	if (d.status === "failed") {
		await patchJob(id, {
			status: "pending",
			phase: null,
			error: null,
			status_message: "Retrying translation...",
			translated_video_url: null,
			final_video_url: null,
			stored_source_video_url: d.stored_source_video_url || null,
			updatedAt: FieldValue.serverTimestamp(),
		});
		queueProcessVideoJob(id);
		return {
			error: null,
			data: {
				video_translate_id: id,
				status: "pending",
				retried: true,
				job_kind: d.job_kind || "single",
			},
			httpStatus: 200,
		};
	}

	return {
		error: "Job is not in a retryable state",
		code: "CONFLICT",
		httpStatus: 409,
		data: { video_translate_id: id, status: d.status },
	};
}
