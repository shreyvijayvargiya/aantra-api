
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
import {
	targetLanguageLabelToNllb,
	looseIsoToNllbSource,
	whisperIsoToNllbSource,
} from "./nmtLanguages.js";
import {
	buildYtDlpProxyUrl,
	getVideoTranslateProxyManager,
	getVideoTranslateProxyMaxRotations,
	proxyPoolKey,
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
let cachedYtDlpCookiesPath = null;
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
	const ffprobe = process.env.FFPROBE_PATH?.trim() || "ffprobe";
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

function parseYtDlpPlayerClients() {
	const raw = process.env.VIDEO_TRANSLATE_YTDLP_PLAYER_CLIENTS?.trim();
	if (raw) {
		return raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	/** android/tv_embedded often work on datacenter IPs without browser cookies. */
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

	const b64 = process.env.VIDEO_TRANSLATE_YTDLP_COOKIES_B64?.trim();
	if (!b64) return null;

	if (cachedYtDlpCookiesPath && existsSync(cachedYtDlpCookiesPath)) {
		return cachedYtDlpCookiesPath;
	}

	const dest = path.join(os.tmpdir(), "aantra-yt-dlp-cookies.txt");
	await fsp.writeFile(dest, Buffer.from(b64, "base64"), { mode: 0o600 });
	cachedYtDlpCookiesPath = dest;
	console.log(`[yt-dlp] loaded cookies from VIDEO_TRANSLATE_YTDLP_COOKIES_B64 → ${dest}`);
	return dest;
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

function formatYtDlpDownloadError(e, { hadCookies, triedClients, usedProxy }) {
	const tail = e?.stderr ? String(e.stderr).slice(-2500) : "";
	const base = tail || e?.message || String(e);
	if (isYtDlpBotOrSignInError(base) && !hadCookies && !usedProxy) {
		return new Error(
			`Video download failed (yt-dlp). YouTube blocked the server IP (bot check). ` +
				`Tried player clients: ${triedClients.join(", ")}. ` +
				`Configure Bright Data proxies (BRIGHTDATA_PROXY_* env) or ` +
				`VIDEO_TRANSLATE_YTDLP_COOKIES_B64. Original: ${base.slice(-800)}`,
		);
	}
	return new Error(`Video download failed (yt-dlp). ${base}`);
}

function shouldRotateProxyAfterYtDlpError(stderr) {
	return (
		isYtDlpBotOrSignInError(stderr) ||
		/unable to extract|player response|403|429|blocked|proxy/i.test(
			String(stderr || ""),
		)
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
	const playerClients = isYoutube ? parseYtDlpPlayerClients() : [null];

	const envProxy = process.env.VIDEO_TRANSLATE_YTDLP_PROXY?.trim();
	const proxyManager = getVideoTranslateProxyManager();
	const maxProxyRotations = proxyManager.hasProxies()
		? getVideoTranslateProxyMaxRotations(proxyManager.count)
		: envProxy
			? 1
			: 0;

	const baseExecOpts = {
		output: path.join(tmpDir, "input.%(ext)s"),
		format,
		mergeOutputFormat: "mp4",
		noPlaylist: true,
		noWarnings: true,
		maxFilesize: `${maxMb}M`,
		userAgent: YTDLP_DEFAULT_USER_AGENT,
		...(cookiesPath ? { cookies: cookiesPath } : {}),
	};

	let lastErr = null;
	let usedProxy = false;

	for (let proxyRound = 0; proxyRound <= maxProxyRotations; proxyRound++) {
		let proxy = null;
		let proxyUrl = envProxy || null;
		if (proxyRound < maxProxyRotations && proxyManager.hasProxies()) {
			proxy = proxyManager.getNextProxy();
			proxyUrl = proxy ? buildYtDlpProxyUrl(proxy) : null;
		} else if (proxyRound > 0 && !envProxy) {
			break;
		}

		for (let i = 0; i < playerClients.length; i++) {
			const client = playerClients[i];
			const execOpts = { ...baseExecOpts };
			if (client) {
				execOpts.extractorArgs = `youtube:player_client=${client}`;
			}
			if (proxyUrl) {
				execOpts.proxy = proxyUrl;
				usedProxy = true;
			}

			const started = Date.now();
			try {
				console.log(
					`[yt-dlp] attempt proxy=${proxy ? proxyPoolKey(proxy) : proxyUrl ? "env" : "none"} client=${client || "default"} cookies=${cookiesPath ? "yes" : "no"}`,
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
				proxyRound = maxProxyRotations + 1;
				break;
			} catch (e) {
				lastErr = e;
				const stderr = String(e?.stderr || e?.message || "");
				console.warn(
					`[yt-dlp] failed proxy=${proxy ? proxyPoolKey(proxy) : "none"} client=${client || "default"}: ${stderr.slice(-500)}`,
				);
				if (proxy) {
					proxyManager.recordProxyResult(
						proxy,
						false,
						Date.now() - started,
					);
				}
				await removePartialVideoDownloadsInDir(tmpDir);

				const retryClient =
					isYoutube &&
					i < playerClients.length - 1 &&
					!shouldRotateProxyAfterYtDlpError(stderr) &&
					(isYtDlpBotOrSignInError(stderr) ||
						/unable to extract|player response/i.test(stderr));
				if (retryClient) continue;

				const retryProxy =
					proxyManager.hasProxies() &&
					proxyRound + 1 < maxProxyRotations &&
					shouldRotateProxyAfterYtDlpError(stderr);
				if (retryProxy) break;
				if (!retryClient) break;
			}
		}
	}

	if (lastErr) {
		throw formatYtDlpDownloadError(lastErr, {
			hadCookies: Boolean(cookiesPath),
			triedClients: playerClients.map((c) => c || "default"),
			usedProxy,
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

function getFfmpegBin() {
	const fromEnv = process.env.FFMPEG_PATH?.trim();
	if (fromEnv && existsSync(fromEnv)) return fromEnv;

	for (const p of [
		"/opt/homebrew/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
		"/usr/bin/ffmpeg",
	]) {
		if (existsSync(p)) return p;
	}

	return "ffmpeg";
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

/** Extract mono 16 kHz WAV for ASR (Whisper / Groq). */
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

/** Mux muted video + WAV (e.g. Groq / Orpheus TTS). */
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
		},
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
