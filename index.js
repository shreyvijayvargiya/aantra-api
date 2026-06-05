import path from "node:path";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { handle } from "@hono/node-server/vercel";
import { streamSSE } from "hono/streaming";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import { cors } from "hono/cors";
import {
	getVideoTranslateLanguagesResponse,
	getVideoTranslateCaptionResponse,
	subscribeVideoTranslateCaptionUpdates,
	VIDEO_TRANSLATE_CAPTION_SSE_MAX_MS,
	createVideoTranslateJobs,
	getVideoTranslateJobStatus,
} from "./lib/videoTranslateOpenRouter.js";
import {
	runVoiceTranslateText,
	guessAudioFormatFromFilename,
	uploadVoiceTranslateTtsToUploadThing,
} from "./lib/voiceTranslateText.js";
import {
	runGroqVoiceTranslateText,
	uploadGroqVoiceTranslateTtsToUploadThing,
} from "./lib/groqVoiceTranslateText.js";
import {
	createGroqVideoTranslateJobs,
	getGroqVideoTranslateJobStatus,
} from "./lib/groqVideoTranslate.js";
import { logger } from "hono/logger";
import { UTApi, UTFile } from "uploadthing/server";
import { openRouterTranslateAuthMiddleware } from "./lib/translateFirebaseAuth.js";

dotenv.config();
const utapi = new UTApi({ token: process.env.UPLOADTHING_TOKEN });



const app = new Hono();

// Add CORS middleware
app.use(
	"*",
	cors({
		origin: [
			"http://localhost:4001",
			"http://localhost:3000",
			"http://localhost:3001",
			"https://ihatereading.in",
			"https://www.inkgest.com",
			"https://aantraa.vercel.app",
			"https://aantraa.site",
			"https://gettemplate.website/",
			"https://swipe-emails.vercel.app",
		], // Allow specific origins
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		// Do not set allowHeaders to a fixed list: browsers send Access-Control-Request-Headers
		// (e.g. authorization, sentry-trace, baggage). Hono mirrors those when allowHeaders is empty.
		exposeHeaders: [
			"X-Video-Translate-Id",
			"X-Caption-Url",
			"X-Audio-Input-Url",
			"X-Content-Type-Options",
			"Cache-Control",
		],
		credentials: true,
		maxAge: 86_400,
	}),
);
export const customLogger = (message, ...rest) => {
	console.log(message, ...rest);
};
app.use(logger(customLogger));
/** Firebase ID token + Firestore credits on POST OpenRouter voice/video translate only. */
app.use("*", openRouterTranslateAuthMiddleware);

const rateLimitMap = new Map(); // Map<ip, { count: number, resetTime: number }>

function rateLimit(ip, limit, windowMs) {
	const now = Date.now();
	const record = rateLimitMap.get(ip);

	// New visitor or window has expired → reset
	if (!record || now > record.resetTime) {
		rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
		return { allowed: true, remaining: limit - 1 };
	}

	// Window still active but limit hit
	if (record.count >= limit) {
		return {
			allowed: false,
			retryAfter: Math.ceil((record.resetTime - now) / 1000), // seconds
			remaining: 0,
		};
	}

	record.count++;
	return { allowed: true, remaining: limit - record.count };
}

// Periodically purge expired entries (every 5 minutes) to avoid memory leaks
setInterval(
	() => {
		const now = Date.now();
		for (const [ip, record] of rateLimitMap.entries()) {
			if (now > record.resetTime) rateLimitMap.delete(ip);
		}
	},
	5 * 60 * 1000,
);

/**
 * Logs HTTP >=400 JSON errors for OpenRouter voice/video translate POST handlers.
 * @param {import("hono").Context} c
 * @param {string} routeLabel
 * @param {object} payload
 * @param {number} status
 */
function jsonTranslateApi(c, routeLabel, payload, status) {
	const code = Number(status) || 0;
	if (code >= 400) {
		console.error(
			`[translate-api:${routeLabel}] ${c.req.method} ${c.req.path} HTTP ${code}`,
			payload?.code || payload?.error || payload?.success,
			payload,
		);
	}
	return c.json(payload, status);
}

/** Response headers for /api/video-translate/* (IDs + caption URL for clients that read headers). */
function applyVideoTranslateApiHeaders(c, opts = {}) {
	const { videoTranslateId, captionUrl, cacheLanguages } = opts;
	c.header("X-Content-Type-Options", "nosniff");
	if (cacheLanguages) {
		c.header("Cache-Control", "public, max-age=86400");
	} else {
		c.header("Cache-Control", "no-store, private, max-age=0");
	}
	if (videoTranslateId) {
		c.header("X-Video-Translate-Id", String(videoTranslateId));
	}
	if (captionUrl) {
		c.header("X-Caption-Url", String(captionUrl));
	}
}


app.get("/api/video-translate/languages", async (c) => {
	applyVideoTranslateApiHeaders(c, { cacheLanguages: true });
	return c.json(getVideoTranslateLanguagesResponse());
});

app.get("/api/video-translate/caption", async (c) => {
	const videoTranslateId = c.req.query("video_translate_id");
	const accept = (c.req.header("accept") || "").toLowerCase();
	const wantSse =
		c.req.query("stream") === "1" ||
		c.req.query("stream") === "true" ||
		accept.includes("text/event-stream");

	if (wantSse) {
		if (!videoTranslateId || !String(videoTranslateId).trim()) {
			return c.json(
				{
					error: "Query video_translate_id is required",
					code: "BAD_REQUEST",
				},
				400,
			);
		}
		const id = String(videoTranslateId).trim();
		applyVideoTranslateApiHeaders(c, { videoTranslateId: id });

		return streamSSE(c, async (stream) => {
			let finished = false;
			let unsubscribe = () => {};
			const finish = () => {
				if (finished) return;
				finished = true;
				try {
					unsubscribe();
				} catch {}
			};

			const timer = setTimeout(async () => {
				if (finished) return;
				finished = true;
				try {
					unsubscribe();
				} catch {}
				try {
					await stream.writeSSE({
						event: "error",
						data: JSON.stringify({
							error: "Caption wait exceeded max duration",
							code: "TIMEOUT",
						}),
					});
					await stream.writeSSE({
						event: "done",
						data: JSON.stringify({ ok: false }),
					});
				} catch {}
			}, VIDEO_TRANSLATE_CAPTION_SSE_MAX_MS);

			unsubscribe = subscribeVideoTranslateCaptionUpdates(id, (evt) => {
				void (async () => {
					try {
						if (evt.kind === "progress") {
							await stream.writeSSE({
								event: "progress",
								data: JSON.stringify({ status: evt.status }),
							});
							return;
						}
						clearTimeout(timer);
						if (evt.kind === "ready") {
							await stream.writeSSE({
								event: "caption",
								data: JSON.stringify({
									error: null,
									data: evt.data,
								}),
							});
							await stream.writeSSE({
								event: "done",
								data: JSON.stringify({ ok: true }),
							});
							finish();
							return;
						}
						if (evt.kind === "not_found") {
							await stream.writeSSE({
								event: "error",
								data: JSON.stringify({
									error: "Unknown video_translate_id",
									code: "NOT_FOUND",
								}),
							});
						} else if (evt.kind === "failed") {
							await stream.writeSSE({
								event: "error",
								data: JSON.stringify({
									error: evt.message || "Job failed",
									code: "FAILED",
								}),
							});
						} else if (evt.kind === "listener_error") {
							await stream.writeSSE({
								event: "error",
								data: JSON.stringify({
									error: evt.message || "Listener error",
									code: "LISTENER_ERROR",
								}),
							});
						}
						await stream.writeSSE({
							event: "done",
							data: JSON.stringify({ ok: false }),
						});
						finish();
					} catch (e) {
						try {
							await stream.writeSSE({
								event: "error",
								data: JSON.stringify({
									error: e?.message || "Stream error",
									code: "STREAM_ERROR",
								}),
							});
						} catch {}
						finish();
					}
				})();
			});
		});
	}

	const out = await getVideoTranslateCaptionResponse(videoTranslateId);
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;
	const capUrl = rest?.data?.caption_url;
	applyVideoTranslateApiHeaders(c, {
		videoTranslateId,
		captionUrl: capUrl,
	});
	return c.json(rest, status);
});

/** Headers for POST /api/voice-translate/text */
function applyVoiceTranslateTextHeaders(c) {
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Cache-Control", "no-store, private, max-age=0");
}

const VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT = 20;
const VOICE_TRANSLATE_TEXT_POST_RATE_WINDOW_MS = 10 * 60 * 1000;



const handleVoiceTranslateTextPost = async (c) => {
	const vtReqId = uuidv4();
	const authHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const authToken = authHdr?.startsWith("Bearer ")
		? authHdr.slice(7).trim()
		: authHdr?.trim();
	if (!authToken) {
		return jsonTranslateApi(
			c,
			"voice-translate/text",
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide a Bearer token in the Authorization header",
			},
			401,
		);
	}

	const xff = c.req.header("x-forwarded-for");
	const vtIp =
		xff?.split(",")?.[0]?.trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const rl = rateLimit(
		vtIp,
		VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT,
		VOICE_TRANSLATE_TEXT_POST_RATE_WINDOW_MS,
	);
	if (!rl.allowed) {
		c.header("Retry-After", String(rl.retryAfter));
		c.header("X-RateLimit-Limit", String(VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return jsonTranslateApi(
			c,
			"voice-translate/text",
			{
				success: false,
				error: "Rate limit exceeded",
				retryAfter: rl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(rl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");
	c.header("X-Voice-Translate-Request-Id", vtReqId);

	const parseBool = (v) => v === true || v === "true" || v === "1";
	const parseLanguages = (raw) => {
		if (raw == null || raw === "") return undefined;
		if (Array.isArray(raw)) return raw;
		if (typeof raw === "string") {
			const s = raw.trim();
			if (s.startsWith("[")) {
				try {
					return JSON.parse(s);
				} catch {
					return undefined;
				}
			}
			return s.split(",").map((x) => x.trim()).filter(Boolean);
		}
		return raw;
	};

	let text;
	let audioUrl;
	let audioBuffer;
	let audioFormat;
	let languages;
	let includeAudio = true;
	let modelOpt;
	let llmModelOpt;
	let translationEngineOpt;
	let ttsEngineOpt;
	let glossaryRefinementOpt;
	let piperModelOpt;
	let sourceNllbOpt;
	let transcriptLanguageOpt;
	let sourceLanguageOpt;
	let glossaryRefineModelOpt;

	const contentType = c.req.header("content-type") || "";

	if (contentType.includes("multipart/form-data")) {
		let form;
		try {
			form = await c.req.formData();
		} catch {
			return jsonTranslateApi(
				c,
				"voice-translate/text",
				{ error: "Invalid multipart/form-data payload" },
				400,
			);
		}
		const fileField = form.get("audio") || form.get("file");
		if (
			fileField &&
			typeof fileField === "object" &&
			"arrayBuffer" in fileField
		) {
			if (!process.env.UPLOADTHING_TOKEN) {
				return jsonTranslateApi(
					c,
					"voice-translate/text",
					{
						error:
							"UPLOADTHING_TOKEN not configured (required to upload audio files)",
						code: "MISSING_UPLOAD_TOKEN",
					},
					503,
				);
			}
			try {
				const ab = await fileField.arrayBuffer();
				audioBuffer = Buffer.from(ab);
				const origName =
					typeof fileField.name === "string" ? fileField.name : "audio.mp3";
				audioFormat = guessAudioFormatFromFilename(origName);
				const uploadedUrl = await uploadAudioBufferToUploadThing(
					audioBuffer,
					origName,
				);
				audioUrl = uploadedUrl;
			} catch (e) {
				return jsonTranslateApi(
					c,
					"voice-translate/text",
					{ error: e?.message || "Audio upload failed" },
					502,
				);
			}
		}
		if (!audioUrl) {
			audioUrl = pickAudioSourceUrlFromVoiceFormFields(form);
		}
		const tf = form.get("text");
		const sf = form.get("source_text");
		if (tf != null && String(tf).trim() !== "") text = String(tf);
		else if (sf != null) text = String(sf);
		languages = parseLanguages(form.get("languages") ?? form.get("output_languages"));
		if (form.has("include_audio")) {
			includeAudio = parseBool(form.get("include_audio"));
		}
		const mf = form.get("model");
		const lmf = form.get("llm_model");
		if (mf != null && String(mf).trim() !== "") modelOpt = String(mf).trim();
		if (lmf != null && String(lmf).trim() !== "") llmModelOpt = String(lmf).trim();
		if (form.has("translation_engine")) {
			translationEngineOpt = String(form.get("translation_engine") ?? "");
		}
		if (form.has("tts_engine")) ttsEngineOpt = String(form.get("tts_engine") ?? "");
		if (form.has("glossary_refinement")) {
			glossaryRefinementOpt = parseBool(form.get("glossary_refinement"));
		}
		if (form.has("piper_model")) {
			piperModelOpt = String(form.get("piper_model") ?? "");
		}
		if (form.has("source_nllb")) {
			sourceNllbOpt = String(form.get("source_nllb") ?? "");
		}
		if (form.has("transcript_language")) {
			transcriptLanguageOpt = String(form.get("transcript_language") ?? "");
		}
		if (form.has("source_language")) {
			sourceLanguageOpt = String(form.get("source_language") ?? "");
		}
		if (form.has("glossary_refine_model")) {
			glossaryRefineModelOpt = String(form.get("glossary_refine_model") ?? "");
		}
	} else if (contentType.includes("application/json")) {
		let body = {};
		try {
			body = await c.req.json();
		} catch {
			return jsonTranslateApi(
				c,
				"voice-translate/text",
				{ error: "Invalid JSON body" },
				400,
			);
		}
		text = body.text ?? body.source_text;
		audioUrl = pickAudioSourceUrlFromVoiceJsonBody(body);
		languages = body.languages ?? body.output_languages;
		if (body.include_audio != null) includeAudio = parseBool(body.include_audio);
		modelOpt = body.model;
		llmModelOpt = body.llm_model;
		translationEngineOpt = body.translation_engine;
		ttsEngineOpt = body.tts_engine;
		glossaryRefinementOpt = body.glossary_refinement;
		piperModelOpt = body.piper_model;
		sourceNllbOpt = body.source_nllb;
		transcriptLanguageOpt = body.transcript_language;
		sourceLanguageOpt = body.source_language;
		glossaryRefineModelOpt = body.glossary_refine_model;
	} else {
		return jsonTranslateApi(
			c,
			"voice-translate/text",
			{
				error:
					"Unsupported Content-Type. Use application/json or multipart/form-data.",
			},
			415,
		);
	}

	const utTok = process.env.UPLOADTHING_TOKEN?.trim();
	const out = await runVoiceTranslateText({
		text,
		audioUrl: audioUrl ? String(audioUrl).trim() : undefined,
		audioBuffer,
		audioFormat,
		languages,
		includeAudio,
		model: modelOpt,
		llmModel: llmModelOpt,
		translation_engine: translationEngineOpt,
		tts_engine: ttsEngineOpt,
		glossary_refinement: glossaryRefinementOpt,
		piper_model: piperModelOpt,
		source_nllb: sourceNllbOpt,
		transcript_language: transcriptLanguageOpt,
		source_language: sourceLanguageOpt,
		glossary_refine_model: glossaryRefineModelOpt,
		afterTranslatedTts:
			includeAudio && utTok
				? (results) =>
						uploadVoiceTranslateTtsToUploadThing(
							results,
							uploadAudioBufferToUploadThing,
							vtReqId,
						)
				: undefined,
	});
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;

	applyVoiceTranslateTextHeaders(c);
	if (audioUrl && rest?.data && typeof rest.data === "object") {
		c.header("X-Audio-Input-Url", String(audioUrl).slice(0, 2048));
	}
	return jsonTranslateApi(c, "voice-translate/text", rest, status);
};

app.post("/api/voice-translate/text", handleVoiceTranslateTextPost);
/** Same as /api/voice-translate/text — avoids 404 when clients use "video" instead of "voice". */
app.post("/api/video-translate/text", handleVoiceTranslateTextPost);

/**
 * POST /api/groq/voice-translate/text (alias: /api/groq/video-translate/text)
 * Same request shape as /api/voice-translate/text; uses Groq (Whisper + chat + TTS) only — no OpenRouter.
 * JSON: text or remote media URL as `audio_url` | `audioUrl` | `url` | `link` | `media_url` | `video_url`, plus `languages`.
 * Optional `model` / `llm_model` = Groq chat model id (default from GROQ_CHAT_MODEL).
 */
const handleGroqVoiceTranslateTextPost = async (c) => {
	const vtReqId = uuidv4();
	const authHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const authToken = authHdr?.startsWith("Bearer ")
		? authHdr.slice(7).trim()
		: authHdr?.trim();
	if (!authToken) {
		return c.json(
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide a Bearer token in the Authorization header",
			},
			401,
		);
	}

	const xff = c.req.header("x-forwarded-for");
	const vtIp =
		xff?.split(",")?.[0]?.trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const rl = rateLimit(
		vtIp,
		VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT,
		VOICE_TRANSLATE_TEXT_POST_RATE_WINDOW_MS,
	);
	if (!rl.allowed) {
		c.header("Retry-After", String(rl.retryAfter));
		c.header("X-RateLimit-Limit", String(VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				retryAfter: rl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(VOICE_TRANSLATE_TEXT_POST_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(rl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");
	c.header("X-Voice-Translate-Request-Id", vtReqId);
	c.header("X-Translate-Engine", "groq");

	const parseLanguages = (raw) => {
		if (raw == null || raw === "") return undefined;
		if (Array.isArray(raw)) return raw;
		if (typeof raw === "string") {
			const s = raw.trim();
			if (s.startsWith("[")) {
				try {
					return JSON.parse(s);
				} catch {
					return undefined;
				}
			}
			return s.split(",").map((x) => x.trim()).filter(Boolean);
		}
		return raw;
	};

	let text;
	let audioUrl;
	let audioBuffer;
	let audioFormat;
	let languages;
	let includeAudio = true;
	let modelOpt;
	let llmModelOpt;

	const contentType = c.req.header("content-type") || "";

	if (contentType.includes("multipart/form-data")) {
		let form;
		try {
			form = await c.req.formData();
		} catch {
			return c.json(
				{ error: "Invalid multipart/form-data payload" },
				400,
			);
		}
		const fileField = form.get("audio") || form.get("file");
		if (
			fileField &&
			typeof fileField === "object" &&
			"arrayBuffer" in fileField
		) {
			if (!process.env.UPLOADTHING_TOKEN) {
				return c.json(
					{
						error:
							"UPLOADTHING_TOKEN not configured (required to upload audio files)",
						code: "MISSING_UPLOAD_TOKEN",
					},
					503,
				);
			}
			try {
				const ab = await fileField.arrayBuffer();
				audioBuffer = Buffer.from(ab);
				const origName =
					typeof fileField.name === "string" ? fileField.name : "audio.mp3";
				audioFormat = guessAudioFormatFromFilename(origName);
				const uploadedUrl = await uploadAudioBufferToUploadThing(
					audioBuffer,
					origName,
				);
				audioUrl = uploadedUrl;
			} catch (e) {
				return c.json(
					{ error: e?.message || "Audio upload failed" },
					502,
				);
			}
		}
		if (!audioUrl) {
			audioUrl = pickAudioSourceUrlFromVoiceFormFields(form);
		}
		const tf = form.get("text");
		const sf = form.get("source_text");
		if (tf != null && String(tf).trim() !== "") text = String(tf);
		else if (sf != null) text = String(sf);
		languages = parseLanguages(form.get("languages") ?? form.get("output_languages"));
		includeAudio = true;
		const mf = form.get("model");
		const lmf = form.get("llm_model");
		if (mf != null && String(mf).trim() !== "") modelOpt = String(mf).trim();
		if (lmf != null && String(lmf).trim() !== "") llmModelOpt = String(lmf).trim();
	} else if (contentType.includes("application/json")) {
		let body = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		text = body.text ?? body.source_text;
		audioUrl = pickAudioSourceUrlFromVoiceJsonBody(body);
		languages = body.languages ?? body.output_languages;
		includeAudio = true;
		modelOpt = body.model;
		llmModelOpt = body.llm_model;
	} else {
		return c.json(
			{
				error:
					"Unsupported Content-Type. Use application/json or multipart/form-data.",
			},
			415,
		);
	}

	const utTok = process.env.UPLOADTHING_TOKEN?.trim();
	const out = await runGroqVoiceTranslateText({
		text,
		audioUrl: audioUrl ? String(audioUrl).trim() : undefined,
		audioBuffer,
		audioFormat,
		languages,
		includeAudio,
		model: modelOpt,
		llmModel: llmModelOpt,
		afterTranslatedTts:
			includeAudio && utTok
				? (results) =>
						uploadGroqVoiceTranslateTtsToUploadThing(
							results,
							uploadAudioBufferToUploadThing,
							vtReqId,
						)
				: undefined,
	});
	const status = out.httpStatus ?? 200;
	const { httpStatus: _gh, ...rest } = out;

	applyVoiceTranslateTextHeaders(c);
	if (audioUrl && rest?.data && typeof rest.data === "object") {
		c.header("X-Audio-Input-Url", String(audioUrl).slice(0, 2048));
	}
	return c.json(rest, status);
};

app.post("/api/groq/voice-translate/text", handleGroqVoiceTranslateTextPost);
app.post("/api/groq/video-translate/text", handleGroqVoiceTranslateTextPost);


const VIDEO_TRANSLATE_POST_RATE_LIMIT = 10;
const VIDEO_TRANSLATE_POST_RATE_WINDOW_MS = 10 * 60 * 1000;

function normalizeVideoUrlString(v) {
	if (v == null) return "";
	const s = String(v).trim();
	return s;
}

/** JSON body keys for a remote video URL (same for /api/video-translate and /api/groq/video-translate). */
function pickVideoUrlFromJsonBody(body) {
	if (!body || typeof body !== "object") return "";
	const keys = [
		"video_url",
		"videoUrl",
		"url",
		"video",
		"source_url",
		"sourceUrl",
		"link",
	];
	for (const k of keys) {
		if (!(k in body)) continue;
		const s = normalizeVideoUrlString(body[k]);
		if (s) return s;
	}
	return "";
}

/**
 * Multipart text fields for a video URL. `video` is only used when the value is a string
 * (file upload uses file + video fields via arrayBuffer branch above).
 */
function pickVideoUrlFromFormFields(form) {
	const keys = [
		"video_url",
		"videoUrl",
		"url",
		"source_url",
		"sourceUrl",
		"link",
	];
	for (const k of keys) {
		const raw = form.get(k);
		if (typeof raw === "string") {
			const s = normalizeVideoUrlString(raw);
			if (s) return s;
		}
	}
	const v = form.get("video");
	if (typeof v === "string") {
		const s = normalizeVideoUrlString(v);
		if (s) return s;
	}
	return "";
}


async function uploadVideoBufferToUploadThing(buffer, originalName) {
	const ext = path.extname(originalName || "").toLowerCase() || ".mp4";
	const allowed = [".mp4", ".mov", ".webm", ".mkv"];
	const useExt = allowed.includes(ext) ? ext : ".mp4";
	const fileName = `video-${Date.now()}-${uuidv4().replace(/[^a-zA-Z0-9]/g, "")}${useExt}`;
	const mimeByExt = {
		".mp4": "video/mp4",
		".mov": "video/quicktime",
		".webm": "video/webm",
		".mkv": "video/x-matroska",
	};
	const mime = mimeByExt[useExt] || "application/octet-stream";
	const utFile = new UTFile([buffer], fileName, { type: mime });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing upload failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

async function uploadAudioBufferToUploadThing(buffer, originalName) {
	const ext = path.extname(originalName || "").toLowerCase() || ".mp3";
	const allowed = [
		".mp3",
		".wav",
		".m4a",
		".aac",
		".ogg",
		".oga",
		".webm",
		".flac",
		".aiff",
		".aif",
		".mp4",
	];
	const useExt = allowed.includes(ext) ? ext : ".mp3";
	const fileName = `audio-${Date.now()}-${uuidv4().replace(/[^a-zA-Z0-9]/g, "")}${useExt}`;
	const mimeByExt = {
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".m4a": "audio/mp4",
		".aac": "audio/aac",
		".ogg": "audio/ogg",
		".oga": "audio/ogg",
		".webm": "audio/webm",
		".flac": "audio/flac",
		".aiff": "audio/aiff",
		".aif": "audio/aiff",
		".mp4": "audio/mp4",
	};
	const mime = mimeByExt[useExt] || "application/octet-stream";
	const utFile = new UTFile([buffer], fileName, { type: mime });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing audio upload failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

/** Remote audio (or media) URL for /api/*voice-translate/text — JSON fields. */
function pickAudioSourceUrlFromVoiceJsonBody(body) {
	if (!body || typeof body !== "object") return undefined;
	const v =
		body.audio_url ??
		body.audioUrl ??
		body.url ??
		body.link ??
		body.media_url ??
		body.mediaUrl ??
		body.video_url ??
		body.videoUrl;
	if (v == null) return undefined;
	const s = String(v).trim();
	return s || undefined;
}

function pickAudioSourceUrlFromVoiceFormFields(form) {
	const keys = [
		"audio_url",
		"audioUrl",
		"url",
		"link",
		"media_url",
		"mediaUrl",
		"video_url",
		"videoUrl",
	];
	for (const k of keys) {
		const raw = form.get(k);
		if (typeof raw === "string") {
			const s = normalizeVideoUrlString(raw);
			if (s) return s;
		}
	}
	return undefined;
}

/**
 * POST /api/video-translate
 * JSON: { video_url | videoUrl | url | video | source_url | link, output_language | output_languages, ... }
 * multipart: file or video (upload), or string URL fields above, optional output_language, etc.
 * LLM preset (optional; default Gemini): gemini | gpt-4o-mini | sonnet | kimi | grok — see lib/translateLlmModels.js
 * Cost controls: translation_engine: llm (default) | nllb; tts_engine: openrouter (default) | piper; glossary_refinement: bool;
 *   source_nllb (FLORES) or transcript_language / source_language (ISO) for NLLB source; piper_model; glossary_refine_model (OpenRouter id for glossary pass).
 * Auth: non-empty Authorization (Bearer &lt;token&gt; or raw token string). Rate limited per IP.
 */
app.post("/api/video-translate", async (c) => {
	const vtAuthHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const vtAuthToken = vtAuthHdr?.startsWith("Bearer ")
		? vtAuthHdr.slice(7).trim()
		: vtAuthHdr?.trim();
	if (!vtAuthToken) {
		return jsonTranslateApi(
			c,
			"video-translate",
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide a Bearer token in the Authorization header",
			},
			401,
		);
	}

	const xff = c.req.header("x-forwarded-for");
	const vtIp =
		xff?.split(",")?.[0]?.trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const vtRl = rateLimit(
		vtIp,
		VIDEO_TRANSLATE_POST_RATE_LIMIT,
		VIDEO_TRANSLATE_POST_RATE_WINDOW_MS,
	);
	if (!vtRl.allowed) {
		c.header("Retry-After", String(vtRl.retryAfter));
		c.header("X-RateLimit-Limit", String(VIDEO_TRANSLATE_POST_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return jsonTranslateApi(
			c,
			"video-translate",
			{
				success: false,
				error: "Rate limit exceeded",
				retryAfter: vtRl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(VIDEO_TRANSLATE_POST_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(vtRl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");

	const contentType = c.req.header("content-type") || "";
	let videoUrl;
	let body = {};

	const parseBool = (v) => v === true || v === "true" || v === "1";

	if (contentType.includes("multipart/form-data")) {
		let form;
		try {
			form = await c.req.formData();
		} catch {
			return jsonTranslateApi(
				c,
				"video-translate",
				{
					error:
						"Invalid multipart/form-data payload. Use proper multipart encoding (-F in curl) or send JSON.",
				},
				400,
			);
		}
		const fileField = form.get("file") || form.get("video");
		if (
			fileField &&
			typeof fileField === "object" &&
			"arrayBuffer" in fileField
		) {
			if (!process.env.UPLOADTHING_TOKEN) {
				return jsonTranslateApi(
					c,
					"video-translate",
					{
						error:
							"UPLOADTHING_TOKEN not configured (required to upload video files)",
						code: "MISSING_UPLOAD_TOKEN",
					},
					503,
				);
			}
			try {
				const ab = await fileField.arrayBuffer();
				const buf = Buffer.from(ab);
				const origName =
					typeof fileField.name === "string" ? fileField.name : "upload.mp4";
				videoUrl = await uploadVideoBufferToUploadThing(buf, origName);
			} catch (e) {
				return jsonTranslateApi(
					c,
					"video-translate",
					{ error: e?.message || "Video upload failed" },
					502,
				);
			}
		}
		if (!videoUrl) {
			videoUrl = pickVideoUrlFromFormFields(form);
		}
		const ol = form.get("output_language");
		const ols = form.get("output_languages");
		if (ol) body.output_language = String(ol);
		if (ols) {
			try {
				body.output_languages =
					typeof ols === "string" ? JSON.parse(ols) : ols;
			} catch {
				return jsonTranslateApi(
					c,
					"video-translate",
					{
						error:
							"output_languages must be a JSON array string (e.g. [\"Spanish\",\"French\"])",
					},
					400,
				);
			}
		}
		if (form.has("title")) body.title = String(form.get("title") ?? "");
		if (form.has("translate_audio_only")) {
			body.translate_audio_only = parseBool(form.get("translate_audio_only"));
		}
		if (form.has("keep_the_same_format")) {
			body.keep_the_same_format = parseBool(form.get("keep_the_same_format"));
		}
		if (form.has("mode")) body.mode = String(form.get("mode") ?? "fast");
		if (form.has("speaker_num")) {
			const n = Number(form.get("speaker_num"));
			if (!Number.isNaN(n)) body.speaker_num = n;
		}
		if (form.has("callback_id")) body.callback_id = String(form.get("callback_id") ?? "");
		if (form.has("enable_dynamic_duration")) {
			body.enable_dynamic_duration = String(
				form.get("enable_dynamic_duration") ?? "",
			);
		}
		if (form.has("brand_voice_id")) {
			body.brand_voice_id = String(form.get("brand_voice_id") ?? "");
		}
		if (form.has("callback_url")) {
			body.callback_url = String(form.get("callback_url") ?? "");
		}
		if (form.has("plan")) body.plan = String(form.get("plan") ?? "");
		if (form.has("user_plan")) body.user_plan = String(form.get("user_plan") ?? "");
		if (form.has("subscription_plan")) {
			body.subscription_plan = String(form.get("subscription_plan") ?? "");
		}
		if (form.has("tier")) body.tier = String(form.get("tier") ?? "");
		const modelField = form.get("model");
		if (modelField != null && String(modelField).trim() !== "") {
			body.model = String(modelField).trim();
		}
		const llmModelField = form.get("llm_model");
		if (llmModelField != null && String(llmModelField).trim() !== "") {
			body.llm_model = String(llmModelField).trim();
		}
		if (form.has("translation_engine")) {
			body.translation_engine = String(form.get("translation_engine") ?? "");
		}
		if (form.has("tts_engine")) {
			body.tts_engine = String(form.get("tts_engine") ?? "");
		}
		if (form.has("glossary_refinement")) {
			body.glossary_refinement = parseBool(form.get("glossary_refinement"));
		}
		if (form.has("piper_model")) {
			body.piper_model = String(form.get("piper_model") ?? "");
		}
		if (form.has("source_nllb")) {
			body.source_nllb = String(form.get("source_nllb") ?? "");
		}
		if (form.has("transcript_language")) {
			body.transcript_language = String(form.get("transcript_language") ?? "");
		}
		if (form.has("source_language")) {
			body.source_language = String(form.get("source_language") ?? "");
		}
		if (form.has("glossary_refine_model")) {
			body.glossary_refine_model = String(form.get("glossary_refine_model") ?? "");
		}
	} else if (contentType.includes("application/json")) {
		try {
			body = await c.req.json();
		} catch {
			return jsonTranslateApi(
				c,
				"video-translate",
				{ error: "Invalid JSON body" },
				400,
			);
		}
		videoUrl = pickVideoUrlFromJsonBody(body);
	} else {
		return jsonTranslateApi(
			c,
			"video-translate",
			{
				error: "Unsupported Content-Type. Use application/json or multipart/form-data.",
			},
			415,
		);
	}

	if (!videoUrl || !String(videoUrl).trim()) {
		return jsonTranslateApi(
			c,
			"video-translate",
			{
				error:
					"Provide video_url, videoUrl, url, or video (string URL), or upload a file (field: file or video)",
			},
			400,
		);
	}

	if (!body.output_language && !body.output_languages) {
		return jsonTranslateApi(
			c,
			"video-translate",
			{ error: "Provide output_language or output_languages" },
			400,
		);
	}
	if (body.output_language && body.output_languages) {
		return jsonTranslateApi(
			c,
			"video-translate",
			{ error: "Use only one of output_language or output_languages" },
			400,
		);
	}

	const payload = {
		video_url: String(videoUrl).trim(),
		translate_audio_only: body.translate_audio_only ?? false,
		keep_the_same_format: body.keep_the_same_format ?? false,
		mode: body.mode ?? "fast",
	};
	if (body.output_language) {
		payload.output_language = body.output_language;
	} else {
		payload.output_languages = body.output_languages;
	}
	if (body.title) payload.title = body.title;
	if (body.speaker_num != null && !Number.isNaN(Number(body.speaker_num))) {
		payload.speaker_num = Number(body.speaker_num);
	}
	if (body.callback_id) payload.callback_id = body.callback_id;
	if (body.enable_dynamic_duration) {
		payload.enable_dynamic_duration = body.enable_dynamic_duration;
	}
	if (body.brand_voice_id) payload.brand_voice_id = body.brand_voice_id;
	if (body.callback_url) payload.callback_url = body.callback_url;

	const out = await createVideoTranslateJobs({
		videoUrl: payload.video_url,
		body: {
			output_language: payload.output_language,
			output_languages: payload.output_languages,
			title: payload.title,
			callback_id: payload.callback_id,
			plan: body.plan,
			user_plan: body.user_plan,
			subscription_plan: body.subscription_plan,
			tier: body.tier,
			model: body.model,
			llm_model: body.llm_model,
			translation_engine: body.translation_engine,
			tts_engine: body.tts_engine,
			glossary_refinement: body.glossary_refinement,
			piper_model: body.piper_model,
			source_nllb: body.source_nllb,
			transcript_language: body.transcript_language,
			source_language: body.source_language,
			glossary_refine_model: body.glossary_refine_model,
		},
	});
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;
	const createdId =
		rest?.data?.video_translate_id ??
		(Array.isArray(rest?.data?.video_translate_ids)
			? rest.data.video_translate_ids[0]
			: null);
	applyVideoTranslateApiHeaders(c, {
		videoTranslateId: createdId,
		captionUrl: rest?.data?.caption_url,
	});
	return jsonTranslateApi(c, "video-translate", rest, status);
});

/**
 * POST /api/groq/video-translate
 * Same URL / output_language shape as POST /api/video-translate; jobs in `groqVideoTranslateJobs`.
 * Cost options: translation_engine: llm (default) | nllb; tts_engine: groq (default) | piper; glossary_refinement; source_nllb or transcript_language.
 */
app.post("/api/groq/video-translate", async (c) => {
	const vtAuthHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const vtAuthToken = vtAuthHdr?.startsWith("Bearer ")
		? vtAuthHdr.slice(7).trim()
		: vtAuthHdr?.trim();
	if (!vtAuthToken) {
		return c.json(
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide a Bearer token in the Authorization header",
			},
			401,
		);
	}

	const xff = c.req.header("x-forwarded-for");
	const vtIp =
		xff?.split(",")?.[0]?.trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const vtRl = rateLimit(
		vtIp,
		VIDEO_TRANSLATE_POST_RATE_LIMIT,
		VIDEO_TRANSLATE_POST_RATE_WINDOW_MS,
	);
	if (!vtRl.allowed) {
		c.header("Retry-After", String(vtRl.retryAfter));
		c.header("X-RateLimit-Limit", String(VIDEO_TRANSLATE_POST_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				retryAfter: vtRl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(VIDEO_TRANSLATE_POST_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(vtRl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");
	c.header("X-Translate-Engine", "groq");

	const contentType = c.req.header("content-type") || "";
	let videoUrl;
	let body = {};

	const parseBool = (v) => v === true || v === "true" || v === "1";

	if (contentType.includes("multipart/form-data")) {
		let form;
		try {
			form = await c.req.formData();
		} catch {
			return c.json(
				{
					error:
						"Invalid multipart/form-data payload. Use proper multipart encoding (-F in curl) or send JSON.",
				},
				400,
			);
		}
		const fileField = form.get("file") || form.get("video");
		if (
			fileField &&
			typeof fileField === "object" &&
			"arrayBuffer" in fileField
		) {
			if (!process.env.UPLOADTHING_TOKEN) {
				return c.json(
					{
						error:
							"UPLOADTHING_TOKEN not configured (required to upload video files)",
						code: "MISSING_UPLOAD_TOKEN",
					},
					503,
				);
			}
			try {
				const ab = await fileField.arrayBuffer();
				const buf = Buffer.from(ab);
				const origName =
					typeof fileField.name === "string" ? fileField.name : "upload.mp4";
				videoUrl = await uploadVideoBufferToUploadThing(buf, origName);
			} catch (e) {
				return jsonTranslateApi(
					c,
					"groq/video-translate",
					{ error: e?.message || "Video upload failed" },
					502,
				);
			}
		}
		if (!videoUrl) {
			videoUrl = pickVideoUrlFromFormFields(form);
		}
		const ol = form.get("output_language");
		const ols = form.get("output_languages");
		if (ol) body.output_language = String(ol);
		if (ols) {
			try {
				body.output_languages =
					typeof ols === "string" ? JSON.parse(ols) : ols;
			} catch {
				return jsonTranslateApi(
					c,
					"groq/video-translate",
					{
						error:
							"output_languages must be a JSON array string (e.g. [\"Spanish\",\"French\"])",
					},
					400,
				);
			}
		}
		if (form.has("title")) body.title = String(form.get("title") ?? "");
		if (form.has("translate_audio_only")) {
			body.translate_audio_only = parseBool(form.get("translate_audio_only"));
		}
		if (form.has("keep_the_same_format")) {
			body.keep_the_same_format = parseBool(form.get("keep_the_same_format"));
		}
		if (form.has("mode")) body.mode = String(form.get("mode") ?? "fast");
		if (form.has("speaker_num")) {
			const n = Number(form.get("speaker_num"));
			if (!Number.isNaN(n)) body.speaker_num = n;
		}
		if (form.has("callback_id")) body.callback_id = String(form.get("callback_id") ?? "");
		if (form.has("enable_dynamic_duration")) {
			body.enable_dynamic_duration = String(
				form.get("enable_dynamic_duration") ?? "",
			);
		}
		if (form.has("brand_voice_id")) {
			body.brand_voice_id = String(form.get("brand_voice_id") ?? "");
		}
		if (form.has("callback_url")) {
			body.callback_url = String(form.get("callback_url") ?? "");
		}
		if (form.has("plan")) body.plan = String(form.get("plan") ?? "");
		if (form.has("user_plan")) body.user_plan = String(form.get("user_plan") ?? "");
		if (form.has("subscription_plan")) {
			body.subscription_plan = String(form.get("subscription_plan") ?? "");
		}
		if (form.has("tier")) body.tier = String(form.get("tier") ?? "");
		const modelField = form.get("model");
		if (modelField != null && String(modelField).trim() !== "") {
			body.model = String(modelField).trim();
		}
		const llmModelField = form.get("llm_model");
		if (llmModelField != null && String(llmModelField).trim() !== "") {
			body.llm_model = String(llmModelField).trim();
		}
		if (form.has("translation_engine")) {
			body.translation_engine = String(form.get("translation_engine") ?? "");
		}
		if (form.has("tts_engine")) {
			body.tts_engine = String(form.get("tts_engine") ?? "");
		}
		if (form.has("glossary_refinement")) {
			body.glossary_refinement = parseBool(form.get("glossary_refinement"));
		}
		if (form.has("piper_model")) {
			body.piper_model = String(form.get("piper_model") ?? "");
		}
		if (form.has("source_nllb")) {
			body.source_nllb = String(form.get("source_nllb") ?? "");
		}
		if (form.has("transcript_language")) {
			body.transcript_language = String(form.get("transcript_language") ?? "");
		}
		if (form.has("source_language")) {
			body.source_language = String(form.get("source_language") ?? "");
		}
	} else if (contentType.includes("application/json")) {
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		videoUrl = pickVideoUrlFromJsonBody(body);
	} else {
		return c.json(
			{
				error: "Unsupported Content-Type. Use application/json or multipart/form-data.",
			},
			415,
		);
	}

	if (!videoUrl || !String(videoUrl).trim()) {
		return c.json(
			{
				error:
					"Provide video_url, videoUrl, url, or video (string URL), or upload a file (field: file or video)",
			},
			400,
		);
	}

	if (!body.output_language && !body.output_languages) {
		return c.json(
			{ error: "Provide output_language or output_languages" },
			400,
		);
	}
	if (body.output_language && body.output_languages) {
		return c.json(
			{ error: "Use only one of output_language or output_languages" },
			400,
		);
	}

	const payload = {
		video_url: String(videoUrl).trim(),
		translate_audio_only: body.translate_audio_only ?? false,
		keep_the_same_format: body.keep_the_same_format ?? false,
		mode: body.mode ?? "fast",
	};
	if (body.output_language) {
		payload.output_language = body.output_language;
	} else {
		payload.output_languages = body.output_languages;
	}
	if (body.title) payload.title = body.title;
	if (body.speaker_num != null && !Number.isNaN(Number(body.speaker_num))) {
		payload.speaker_num = Number(body.speaker_num);
	}
	if (body.callback_id) payload.callback_id = body.callback_id;
	if (body.enable_dynamic_duration) {
		payload.enable_dynamic_duration = body.enable_dynamic_duration;
	}
	if (body.brand_voice_id) payload.brand_voice_id = body.brand_voice_id;
	if (body.callback_url) payload.callback_url = body.callback_url;

	const out = await createGroqVideoTranslateJobs({
		videoUrl: payload.video_url,
		body: {
			output_language: payload.output_language,
			output_languages: payload.output_languages,
			title: payload.title,
			callback_id: payload.callback_id,
			plan: body.plan,
			user_plan: body.user_plan,
			subscription_plan: body.subscription_plan,
			tier: body.tier,
			model: body.model,
			llm_model: body.llm_model,
			translation_engine: body.translation_engine,
			tts_engine: body.tts_engine,
			glossary_refinement: body.glossary_refinement,
			piper_model: body.piper_model,
			source_nllb: body.source_nllb,
			transcript_language: body.transcript_language,
			source_language: body.source_language,
		},
	});
	const status = out.httpStatus ?? 200;
	const { httpStatus: _gqh, ...rest } = out;
	const createdId =
		rest?.data?.video_translate_id ??
		(Array.isArray(rest?.data?.video_translate_ids)
			? rest.data.video_translate_ids[0]
			: null);
	applyVideoTranslateApiHeaders(c, {
		videoTranslateId: createdId,
		captionUrl: rest?.data?.caption_url,
	});
	return c.json(rest, status);
});

/** GET /api/groq/video-translate/:id — Groq job status (collection groqVideoTranslateJobs) */
app.get("/api/groq/video-translate/:id", async (c) => {
	const id = c.req.param("id");
	const out = await getGroqVideoTranslateJobStatus(id);
	const status = out.httpStatus ?? 200;
	const { httpStatus: _gqh2, ...rest } = out;
	const d = rest?.data;
	applyVideoTranslateApiHeaders(c, {
		videoTranslateId: id,
		captionUrl: d?.caption_url,
	});
	return c.json(rest, status);
});

/** GET /api/video-translate/:id — job status (Firestore); transcript, caption string, caption_url when success */
app.get("/api/video-translate/:id", async (c) => {
	const id = c.req.param("id");
	const out = await getVideoTranslateJobStatus(id);
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;
	const d = rest?.data;
	applyVideoTranslateApiHeaders(c, {
		videoTranslateId: id,
		captionUrl: d?.caption_url,
	});
	return c.json(rest, status);
});

app.get("/", (c) => {
	return c.json({ message: "Hello World" });
});

const port = Number(process.env.PORT) || 3000;

/** Vercel invokes `index.js` as a Node serverless function; default export must be a handler. */
export default handle(app);

if (!process.env.VERCEL) {
	console.log(`Server is running on port ${port}`);
	serve({
		fetch: app.fetch,
		port,
	});
}