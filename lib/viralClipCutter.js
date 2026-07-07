/**
 * Viral clip cutter: download video → transcribe (OpenRouter) → AI picks viral moments
 * → FFmpeg cuts clips → UploadThing.
 */
import { v4 as uuidv4 } from "uuid";
import { execFile } from "child_process";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";
import { UTApi, UTFile } from "uploadthing/server";
import {
	buildUsageResponseFields,
	mergeOpenRouterUsage,
	normalizeOpenRouterUsage,
	publicTranslateUsageFromDoc,
} from "./openRouterUsage.js";
import { resolveTranslateLlmModel, TRANSLATE_LLM_PRESETS } from "./translateLlmModels.js";
import {
	openRouterErrorFromResponse,
	logOpenRouterErrorDev,
	jobFailureFieldsFromError,
	publicJobErrorFromDoc,
} from "./openRouterErrors.js";
import {
	isYoutubeVideoUrl,
	resolveYoutubeRapidApiMedia,
	assertValidVideoBuffer,
} from "./rapidApiYoutubeDownload.js";
import { getFfmpegBin, getFfprobeBin } from "./ffmpegBin.js";

const JOBS_COLL = "viralClipCutJobs";
const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";

const utapi = new UTApi({ token: process.env.UPLOADTHING_TOKEN });

const MAX_VIDEO_BYTES =
	Number.parseInt(process.env.VIRAL_CLIP_MAX_VIDEO_BYTES || "", 10) ||
	Number.parseInt(process.env.VIDEO_CAPTION_MAX_VIDEO_BYTES || "", 10) ||
	200 * 1024 * 1024;
const MAX_MINUTES =
	Number.parseInt(process.env.VIRAL_CLIP_MAX_MINUTES || "", 10) ||
	Number.parseInt(process.env.VIDEO_CAPTION_MAX_MINUTES || "", 10) ||
	30;
const DEFAULT_MAX_CLIPS =
	Number.parseInt(process.env.VIRAL_CLIP_MAX_CLIPS || "", 10) || 10;
const DEFAULT_SECONDS_PER_CLIP =
	Number.parseInt(process.env.VIRAL_CLIP_SECONDS_PER_CLIP || "", 10) || 120;
const DEFAULT_MIN_CLIP_SEC =
	Number.parseInt(process.env.VIRAL_CLIP_MIN_CLIP_SEC || "", 10) || 15;
const DEFAULT_MAX_CLIP_SEC =
	Number.parseInt(process.env.VIRAL_CLIP_MAX_CLIP_SEC || "", 10) || 60;
const OPENROUTER_TIMEOUT_MS =
	Number.parseInt(process.env.OPENROUTER_VIDEO_TIMEOUT_MS || "", 10) || 600_000;
const TRANSCRIBE_AUDIO_MAX_BYTES =
	Number.parseInt(process.env.VIRAL_CLIP_TRANSCRIBE_AUDIO_MAX_BYTES || "", 10) ||
	25 * 1024 * 1024;
const VIDEO_DOWNLOAD_MAX_ATTEMPTS =
	Number.parseInt(process.env.VIRAL_CLIP_DOWNLOAD_RETRIES || "", 10) || 5;
const BOUNDARY_PAD_MS =
	Number.parseInt(process.env.VIRAL_CLIP_BOUNDARY_PAD_MS || "", 10) || 300;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOpenRouterKey() {
	return process.env.OPENROUTER_API_KEY?.trim() || "";
}

function openRouterHeaders() {
	const key = getOpenRouterKey();
	const h = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${key}`,
	};
	const ref = process.env.OPENROUTER_HTTP_REFERER?.trim();
	h.Referer = ref || "https://ihatereading.in";
	const title = process.env.OPENROUTER_APP_TITLE?.trim();
	if (title) h["X-Title"] = title;
	return h;
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
	const start = t.indexOf("{");
	if (start === -1) throw new SyntaxError("No JSON object in model output");
	let depth = 0;
	let end = -1;
	for (let i = start; i < t.length; i++) {
		if (t[i] === "{") depth++;
		else if (t[i] === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) throw new SyntaxError("Unterminated JSON in model output");
	return JSON.parse(t.slice(start, end + 1));
}

function parseRetryAfterMs(headers) {
	const raw = headers.get("retry-after");
	if (!raw) return null;
	const sec = Number.parseInt(raw, 10);
	if (!Number.isNaN(sec)) return sec * 1000;
	const t = Date.parse(raw);
	if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
	return null;
}

async function fetchVideoBufferWithRetries(url, signal, maxVideoBytes) {
	const ua =
		process.env.VIRAL_CLIP_DOWNLOAD_USER_AGENT?.trim() ||
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
				throw new Error(`Video exceeds byte limit (${maxVideoBytes} bytes)`);
			}
			return buf;
		}

		lastStatus = res.status;
		try {
			await res.arrayBuffer();
		} catch {
			/* ignore */
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
		await sleep(waitMs + Math.floor(Math.random() * 400));
	}

	throw new Error(`Failed to download video: HTTP ${lastStatus}`);
}

async function execFfmpeg(args, label) {
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
							? " Install ffmpeg on the host or set FFMPEG_PATH."
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

async function getVideoDurationSeconds(videoPath) {
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
					"default=noprint_wrappers=1:nokey=1",
					videoPath,
				],
				{ timeout: 30_000 },
				(err, stdout) => {
					if (err) reject(err);
					else resolve(stdout);
				},
			);
		});
		const sec = Number.parseFloat(String(out).trim());
		if (Number.isFinite(sec) && sec > 0) return sec;
	} catch {
		/* fall through */
	}

	const ffmpeg = getFfmpegBin();
	const stderr = await new Promise((resolve, reject) => {
		execFile(
			ffmpeg,
			["-i", videoPath, "-f", "null", "-"],
			{ timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
			(_err, _stdout, errOut) => {
				if (errOut) resolve(String(errOut));
				else reject(new Error("ffmpeg produced no stderr for duration"));
			},
		);
	});
	const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
	if (!m) throw new Error("Unable to determine video duration");
	return (
		Number(m[1]) * 3600 + Number(m[2]) * 60 + Number.parseFloat(m[3])
	);
}

async function enforceDurationLimit(videoPath, maxMinutes) {
	const sec = await getVideoDurationSeconds(videoPath);
	if (sec > maxMinutes * 60) {
		throw new Error(
			`Video duration ${Math.ceil(sec)}s exceeds plan limit (${maxMinutes} minutes)`,
		);
	}
	return sec;
}

async function downloadVideoToTempFile(url, signal, maxVideoBytes, maxMinutes) {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vclip-"));
	try {
		let buf;
		if (isYoutubeVideoUrl(url)) {
			const media = await resolveYoutubeRapidApiMedia(url, signal);
			if (media.kind === "buffer") {
				buf = media.buffer;
			} else {
				buf = await fetchVideoBufferWithRetries(
					media.url,
					signal,
					maxVideoBytes,
				);
			}
			if (buf.length > maxVideoBytes) {
				throw new Error(
					`Video exceeds plan byte limit (${maxVideoBytes} bytes)`,
				);
			}
			assertValidVideoBuffer(buf);
		} else {
			buf = await fetchVideoBufferWithRetries(url, signal, maxVideoBytes);
		}
		const videoPath = path.join(tmpDir, "input.mp4");
		await fsp.writeFile(videoPath, buf);
		const durationSec = await enforceDurationLimit(videoPath, maxMinutes);
		return { videoPath, tmpDir, buffer: buf, durationSec };
	} catch (e) {
		await rmDirSafe(tmpDir);
		throw e;
	}
}

async function ffmpegExtractTranscribeAudio(inputPath, outAudioPath) {
	await execFfmpeg(
		[
			"-y",
			"-i",
			inputPath,
			"-vn",
			"-ac",
			"1",
			"-ar",
			"16000",
			"-c:a",
			"pcm_s16le",
			outAudioPath,
		],
		"ffmpeg extract transcription audio",
	);
}

function buildAspectFilter(targetAspect) {
	const a = String(targetAspect || "")
		.trim()
		.toLowerCase();
	if (!a || a === "original" || a === "source") return null;
	if (a === "9:16" || a === "vertical" || a === "shorts") {
		return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
	}
	if (a === "1:1" || a === "square") {
		return "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080";
	}
	if (a === "16:9" || a === "landscape") {
		return "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080";
	}
	return null;
}

async function ffmpegCutClip(inputPath, outPath, startSec, durationSec, targetAspect) {
	const vf = buildAspectFilter(targetAspect);
	const args = [
		"-y",
		"-ss",
		String(Math.max(0, startSec)),
		"-i",
		inputPath,
		"-t",
		String(Math.max(0.1, durationSec)),
	];
	if (vf) args.push("-vf", vf);
	args.push(
		"-c:v",
		"libx264",
		"-preset",
		"fast",
		"-crf",
		"23",
		"-c:a",
		"aac",
		"-movflags",
		"+faststart",
		outPath,
	);
	await execFfmpeg(args, "ffmpeg cut clip");
}

function distributeTranscriptToSegments(transcript, durationSec) {
	const sentences = String(transcript || "")
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (!sentences.length) return [];

	const totalMs = Math.max(1000, Math.floor(durationSec * 1000));
	const slice = Math.floor(totalMs / sentences.length);
	return sentences.map((text, i) => ({
		start_ms: i * slice,
		end_ms: i === sentences.length - 1 ? totalMs : (i + 1) * slice,
		text,
	}));
}

function normalizeTranscriptSegments(raw, durationSec) {
	if (!Array.isArray(raw)) {
		return typeof raw === "string" && raw.trim()
			? distributeTranscriptToSegments(raw, durationSec)
			: [];
	}
	const out = [];
	for (const row of raw) {
		const text = String(row?.text ?? "").trim();
		if (!text) continue;
		let startMs = Number(row?.start_ms ?? row?.startMs);
		let endMs = Number(row?.end_ms ?? row?.endMs);
		if (!Number.isFinite(startMs)) {
			const startSec = Number(row?.start ?? row?.start_sec ?? row?.startSec);
			startMs = Number.isFinite(startSec) ? startSec * 1000 : NaN;
		}
		if (!Number.isFinite(endMs)) {
			const endSec = Number(row?.end ?? row?.end_sec ?? row?.endSec);
			endMs = Number.isFinite(endSec) ? endSec * 1000 : NaN;
		}
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
			continue;
		}
		out.push({ start_ms: Math.floor(startMs), end_ms: Math.floor(endMs), text });
	}
	return out;
}

async function openRouterJsonChat({ model, messages, signal, temperature = 0.2 }) {
	let chatRes = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterHeaders(),
		body: JSON.stringify({
			model,
			messages,
			temperature,
			response_format: { type: "json_object" },
		}),
	});

	let chatData = await chatRes.json().catch(() => ({}));
	if (!chatRes.ok || chatData.error) {
		const msg = String(chatData?.error?.message || chatData?.error || "");
		const retryNoRf = /response_format|json_object|unsupported/i.test(msg);
		if (retryNoRf) {
			chatRes = await fetch(OPENROUTER_CHAT, {
				method: "POST",
				signal,
				headers: openRouterHeaders(),
				body: JSON.stringify({ model, messages, temperature }),
			});
			chatData = await chatRes.json().catch(() => ({}));
		}
	}

	if (!chatRes.ok || chatData.error) {
		throw openRouterErrorFromResponse(chatRes, chatData);
	}

	const content = chatData.choices?.[0]?.message?.content;
	if (!content || typeof content !== "string") {
		throw new Error("Empty response from model");
	}

	return {
		parsed: parseJsonObjectFromModel(content),
		usage: chatData.usage,
	};
}

async function transcribeTimedSegments({
	audioBuffer,
	language,
	durationSec,
	signal,
	model,
}) {
	const userText = `Listen to this video audio (~${Math.ceil(durationSec)} seconds). Transcribe all spoken content in ${language || "the original language"} with timed segments.

Reply with ONLY a JSON object:
{
  "transcript": "<full verbatim transcript>",
  "segments": [
    { "start_ms": 0, "end_ms": 2500, "text": "<line>" }
  ]
}

Rules:
- segments in chronological order, non-overlapping
- start_ms and end_ms are integers in milliseconds`;

	const audioBase64 = audioBuffer.toString("base64");
	const messages = [
		{
			role: "user",
			content: [
				{ type: "text", text: userText },
				{
					type: "input_audio",
					input_audio: { data: audioBase64, format: "wav" },
				},
			],
		},
	];

	const { parsed, usage } = await openRouterJsonChat({
		model,
		messages,
		signal,
		temperature: 0.1,
	});

	const transcript = String(parsed?.transcript ?? "").trim();
	let segments = normalizeTranscriptSegments(parsed?.segments, durationSec);
	if (!segments.length && transcript) {
		segments = distributeTranscriptToSegments(transcript, durationSec);
	}
	if (!segments.length) {
		throw new Error("Transcription produced no segments");
	}

	return {
		transcript: transcript || segments.map((s) => s.text).join(" "),
		segments,
		usage,
	};
}

export function resolveClipCount({
	durationSec,
	clipCount,
	maxClips = DEFAULT_MAX_CLIPS,
	secondsPerClip = DEFAULT_SECONDS_PER_CLIP,
}) {
	const cap = Math.max(1, maxClips);
	if (clipCount != null && String(clipCount).trim() !== "") {
		const n = Number.parseInt(String(clipCount), 10);
		if (!Number.isFinite(n) || n < 1) {
			return { ok: false, error: "clip_count must be a positive integer" };
		}
		return { ok: true, count: Math.min(cap, n) };
	}
	const byRatio = Math.max(1, Math.round(durationSec / secondsPerClip));
	return { ok: true, count: Math.min(cap, byRatio) };
}

async function pickViralClips({
	transcript,
	segments,
	durationSec,
	clipCount,
	userPrompt,
	minClipSec,
	maxClipSec,
	signal,
	model,
}) {
	const segmentJson = JSON.stringify(segments.slice(0, 500));
	const contextPrompt = String(userPrompt || "").trim() ||
		"Pick the most viral, shareable moments suitable for TikTok, Reels, and Shorts.";

	const userText = `You are a viral short-form video editor.

Video duration: ${Math.ceil(durationSec)} seconds.
Target clip count: exactly ${clipCount}.
Each clip must be between ${minClipSec} and ${maxClipSec} seconds.
User context: ${contextPrompt}

Full transcript:
${transcript}

Timed segments (JSON):
${segmentJson}

Select the ${clipCount} best viral clips. Align cut points to natural speech boundaries using segment timestamps.

Reply with ONLY a JSON object:
{
  "summary": "<one sentence about the video>",
  "clips": [
    {
      "title": "<short title>",
      "hook": "<one-line hook for caption/thumbnail>",
      "start_ms": 0,
      "end_ms": 30000,
      "virality_score": 0.95,
      "reason": "<why this moment is viral>"
    }
  ]
}

Rules:
- return exactly ${clipCount} clips unless the source is too thin (then return as many strong clips as possible, minimum 1)
- no overlapping clips
- start_ms >= 0, end_ms <= ${Math.floor(durationSec * 1000)}
- prefer complete thoughts, punchlines, hot takes, and emotional peaks`;

	const messages = [{ role: "user", content: userText }];
	const { parsed, usage } = await openRouterJsonChat({
		model,
		messages,
		signal,
		temperature: 0.3,
	});

	const summary = String(parsed?.summary ?? "").trim();
	const rawClips = Array.isArray(parsed?.clips) ? parsed.clips : [];
	if (!rawClips.length) {
		throw new Error("Model returned no viral clips");
	}

	return { summary, rawClips, usage };
}

function validateAndNormalizeClips(rawClips, durationMs, minClipSec, maxClipSec) {
	const minMs = minClipSec * 1000;
	const maxMs = maxClipSec * 1000;
	const out = [];

	for (const row of rawClips) {
		let startMs = Number(row?.start_ms ?? row?.startMs);
		let endMs = Number(row?.end_ms ?? row?.endMs);
		if (!Number.isFinite(startMs)) {
			const s = Number(row?.start ?? row?.start_sec ?? row?.startSec);
			startMs = Number.isFinite(s) ? s * 1000 : NaN;
		}
		if (!Number.isFinite(endMs)) {
			const e = Number(row?.end ?? row?.end_sec ?? row?.endSec);
			endMs = Number.isFinite(e) ? e * 1000 : NaN;
		}
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

		startMs = Math.max(0, Math.floor(startMs - BOUNDARY_PAD_MS));
		endMs = Math.min(durationMs, Math.floor(endMs + BOUNDARY_PAD_MS));
		if (endMs <= startMs) continue;

		let dur = endMs - startMs;
		if (dur < minMs) {
			const expand = minMs - dur;
			endMs = Math.min(durationMs, endMs + expand);
			dur = endMs - startMs;
		}
		if (dur > maxMs) {
			endMs = startMs + maxMs;
		}
		if (endMs <= startMs) continue;

		out.push({
			title: String(row?.title ?? "").trim() || `Clip ${out.length + 1}`,
			hook: String(row?.hook ?? "").trim() || null,
			start_ms: startMs,
			end_ms: endMs,
			duration_ms: endMs - startMs,
			virality_score:
				typeof row?.virality_score === "number"
					? row.virality_score
					: Number(row?.virality_score) || null,
			reason: String(row?.reason ?? "").trim() || null,
		});
	}

	out.sort((a, b) => (b.virality_score ?? 0) - (a.virality_score ?? 0));

	const deduped = [];
	for (const clip of out) {
		const overlaps = deduped.some(
			(c) =>
				!(clip.end_ms <= c.start_ms || clip.start_ms >= c.end_ms),
		);
		if (!overlaps) deduped.push(clip);
	}

	return deduped;
}

async function uploadClipMp4(buffer, jobId, index) {
	const fileName = `viral-clip-${jobId}-${index}.mp4`;
	const utFile = new UTFile([buffer], fileName, { type: "video/mp4" });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing clip upload failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

async function rmDirSafe(dir) {
	await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function newJobId() {
	return `vcc_${uuidv4().replace(/-/g, "")}`;
}

async function writeJob(docId, data) {
	await firestore.collection(JOBS_COLL).doc(docId).set(data, { merge: true });
}

async function patchJob(docId, data) {
	await firestore.collection(JOBS_COLL).doc(docId).update(data);
}

function resolveClipModel(raw) {
	if (raw != null && String(raw).trim() !== "") {
		const r = resolveTranslateLlmModel(raw);
		if (!r.ok) return r;
		return { ok: true, openrouterId: r.openrouterId, preset: r.preset };
	}
	return {
		ok: true,
		openrouterId:
			process.env.VIRAL_CLIP_LLM_MODEL?.trim() ||
			process.env.VIDEO_CAPTION_TRANSCRIBE_MODEL?.trim() ||
			TRANSLATE_LLM_PRESETS.gemini,
		preset: "gemini",
	};
}

function parsePositiveInt(raw, fallback) {
	if (raw == null || String(raw).trim() === "") return fallback;
	const n = Number.parseInt(String(raw), 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function createViralClipCutJob({ videoUrl, body = {} }) {
	if (!getOpenRouterKey()) {
		return {
			error: "OPENROUTER_API_KEY not configured",
			code: "MISSING_API_KEY",
			httpStatus: 503,
		};
	}
	if (!process.env.UPLOADTHING_TOKEN?.trim()) {
		return {
			error:
				"UPLOADTHING_TOKEN not configured (required to upload clip videos)",
			code: "MISSING_UPLOAD_TOKEN",
			httpStatus: 503,
		};
	}

	const video_url = String(videoUrl || "").trim();
	if (!video_url) {
		return {
			error:
				"Provide video_url (or videoUrl) or upload a video file (field: file or video)",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const modelRes = resolveClipModel(body.model ?? body.llm_model);
	if (!modelRes.ok) {
		return {
			error: modelRes.error,
			code: "BAD_REQUEST",
			details: { allowed_models: modelRes.allowed },
			httpStatus: 400,
		};
	}

	const maxClips = parsePositiveInt(
		body.max_clips ?? body.maxClips,
		DEFAULT_MAX_CLIPS,
	);
	const minClipSec = parsePositiveInt(
		body.min_clip_sec ?? body.minClipSec,
		DEFAULT_MIN_CLIP_SEC,
	);
	const maxClipSec = Math.max(
		minClipSec,
		parsePositiveInt(body.max_clip_sec ?? body.maxClipSec, DEFAULT_MAX_CLIP_SEC),
	);
	const secondsPerClip = parsePositiveInt(
		body.seconds_per_clip ?? body.secondsPerClip,
		DEFAULT_SECONDS_PER_CLIP,
	);

	const id = newJobId();
	await writeJob(id, {
		id,
		status: "pending",
		video_url,
		source_video_url: video_url,
		prompt: String(body.prompt ?? body.context ?? "").trim() || null,
		language: String(body.language ?? "en").trim(),
		clip_count: body.clip_count ?? body.clipCount ?? null,
		max_clips: maxClips,
		min_clip_sec: minClipSec,
		max_clip_sec: maxClipSec,
		seconds_per_clip: secondsPerClip,
		target_aspect: String(body.target_aspect ?? body.targetAspect ?? "").trim() || null,
		llm_model: modelRes.openrouterId,
		llm_preset: modelRes.preset,
		max_video_bytes: MAX_VIDEO_BYTES,
		max_minutes: MAX_MINUTES,
		createdAt: FieldValue.serverTimestamp(),
		updatedAt: FieldValue.serverTimestamp(),
	});

	queueProcessClipJob(id);

	return {
		error: null,
		data: {
			viral_clip_cut_id: id,
		},
		httpStatus: 200,
	};
}

function queueProcessClipJob(jobId) {
	setImmediate(() => {
		processViralClipCutJob(jobId).catch((err) => {
			logOpenRouterErrorDev("viralClipCut", err);
			console.error(`[viralClipCut] job ${jobId} failed:`, err?.message || err);
			const fields = jobFailureFieldsFromError(err);
			patchJob(jobId, {
				...fields,
				updatedAt: FieldValue.serverTimestamp(),
			}).catch(() => {});
		});
	});
}

async function processViralClipCutJob(jobId) {
	const signal = AbortSignal.timeout(OPENROUTER_TIMEOUT_MS);
	let tmpDir;
	try {
		const snap = await firestore.collection(JOBS_COLL).doc(jobId).get();
		if (!snap.exists) return;
		const job = snap.data();

		await patchJob(jobId, {
			status: "analyzing",
			updatedAt: FieldValue.serverTimestamp(),
		});

		const maxVideoBytes =
			Number.parseInt(String(job.max_video_bytes || ""), 10) || MAX_VIDEO_BYTES;
		const maxMinutes =
			Number.parseInt(String(job.max_minutes || ""), 10) || MAX_MINUTES;

		const { videoPath, tmpDir: tDir, durationSec } = await downloadVideoToTempFile(
			job.video_url,
			signal,
			maxVideoBytes,
			maxMinutes,
		);
		tmpDir = tDir;
		const durationMs = Math.floor(durationSec * 1000);

		const clipCountRes = resolveClipCount({
			durationSec,
			clipCount: job.clip_count,
			maxClips: job.max_clips ?? DEFAULT_MAX_CLIPS,
			secondsPerClip: job.seconds_per_clip ?? DEFAULT_SECONDS_PER_CLIP,
		});
		if (!clipCountRes.ok) {
			throw new Error(clipCountRes.error);
		}
		const targetClipCount = clipCountRes.count;

		const transcribeAudioPath = path.join(tmpDir, "transcribe_input.wav");
		await ffmpegExtractTranscribeAudio(videoPath, transcribeAudioPath);
		const transcribeAudioBuffer = await fsp.readFile(transcribeAudioPath);
		if (transcribeAudioBuffer.length > TRANSCRIBE_AUDIO_MAX_BYTES) {
			throw new Error(
				`Transcription audio too large (${transcribeAudioBuffer.length} bytes)`,
			);
		}

		const { transcript, segments, usage: transcribeUsage } =
			await transcribeTimedSegments({
				audioBuffer: transcribeAudioBuffer,
				language: job.language,
				durationSec,
				signal,
				model: job.llm_model,
			});

		let mergedUsage = normalizeOpenRouterUsage(transcribeUsage);

		const { summary, rawClips, usage: pickUsage } = await pickViralClips({
			transcript,
			segments,
			durationSec,
			clipCount: targetClipCount,
			userPrompt: job.prompt,
			minClipSec: job.min_clip_sec ?? DEFAULT_MIN_CLIP_SEC,
			maxClipSec: job.max_clip_sec ?? DEFAULT_MAX_CLIP_SEC,
			signal,
			model: job.llm_model,
		});
		mergedUsage = mergeOpenRouterUsage(mergedUsage, pickUsage);

		const normalizedClips = validateAndNormalizeClips(
			rawClips,
			durationMs,
			job.min_clip_sec ?? DEFAULT_MIN_CLIP_SEC,
			job.max_clip_sec ?? DEFAULT_MAX_CLIP_SEC,
		);
		if (!normalizedClips.length) {
			throw new Error("No valid clip ranges after validation");
		}

		await patchJob(jobId, {
			status: "cutting",
			transcript,
			summary,
			clip_count_requested: targetClipCount,
			clip_count: normalizedClips.length,
			updatedAt: FieldValue.serverTimestamp(),
		});

		const clipsWithUrls = [];
		for (let i = 0; i < normalizedClips.length; i++) {
			const clip = normalizedClips[i];
			const outPath = path.join(tmpDir, `clip-${i}.mp4`);
			const startSec = clip.start_ms / 1000;
			const durationClipSec = clip.duration_ms / 1000;

			await ffmpegCutClip(
				videoPath,
				outPath,
				startSec,
				durationClipSec,
				job.target_aspect,
			);

			await patchJob(jobId, {
				status: "uploading",
				clips_completed: i,
				updatedAt: FieldValue.serverTimestamp(),
			});

			const clipBuf = await fsp.readFile(outPath);
			const videoUrl = await uploadClipMp4(clipBuf, jobId, i);

			clipsWithUrls.push({
				index: i,
				title: clip.title,
				hook: clip.hook,
				start_ms: clip.start_ms,
				end_ms: clip.end_ms,
				duration_ms: clip.duration_ms,
				virality_score: clip.virality_score,
				reason: clip.reason,
				video_url: videoUrl,
				videoUrl,
			});
		}

		const usagePayload = buildUsageResponseFields(mergedUsage);

		await patchJob(jobId, {
			status: "success",
			transcript,
			summary,
			clips: clipsWithUrls,
			clip_count: clipsWithUrls.length,
			clip_count_requested: targetClipCount,
			source_video_url: job.source_video_url || job.video_url,
			...usagePayload,
			error: null,
			updatedAt: FieldValue.serverTimestamp(),
		});
	} catch (e) {
		logOpenRouterErrorDev("viralClipCut", e);
		const fields = jobFailureFieldsFromError(e);
		await patchJob(jobId, {
			...fields,
			updatedAt: FieldValue.serverTimestamp(),
		});
	} finally {
		if (tmpDir) await rmDirSafe(tmpDir);
	}
}

export async function getViralClipCutJobStatus(id) {
	const jobId = String(id || "").trim();
	if (!jobId) {
		return {
			error: "Missing viral clip cut job id",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const snap = await firestore.collection(JOBS_COLL).doc(jobId).get();
	if (!snap.exists) {
		return {
			error: "Unknown viral_clip_cut_id",
			code: "NOT_FOUND",
			httpStatus: 404,
		};
	}

	const d = snap.data();
	const clips = Array.isArray(d.clips) ? d.clips : null;
	const errFields = publicJobErrorFromDoc(d);

	const data = {
		viral_clip_cut_id: jobId,
		status: d.status || "pending",
		source_video_url: d.source_video_url || d.video_url || null,
		prompt: d.prompt ?? null,
		language: d.language ?? null,
		summary: d.summary ?? null,
		transcript: d.transcript ?? null,
		clip_count_requested: d.clip_count_requested ?? null,
		clip_count: d.clip_count ?? (clips ? clips.length : null),
		clips,
		target_aspect: d.target_aspect ?? null,
		min_clip_sec: d.min_clip_sec ?? null,
		max_clip_sec: d.max_clip_sec ?? null,
		max_clips: d.max_clips ?? null,
		error: errFields.error,
		error_code: errFields.error_code,
		user_message: errFields.user_message,
		...(errFields.error_detail ? { error_detail: errFields.error_detail } : {}),
		...(errFields.error_upstream_status
			? { error_upstream_status: errFields.error_upstream_status }
			: {}),
		...(d.error_retryable != null ? { error_retryable: d.error_retryable } : {}),
		...publicTranslateUsageFromDoc(d),
		engine: "openrouter-viral-clip-ffmpeg",
	};

	return { error: null, data, httpStatus: 200 };
}
