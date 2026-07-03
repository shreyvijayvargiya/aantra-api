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
	getOpenRouterTtsVoicesWithPreviews,
	logYtDlpCookiesAtStartup,
} from "./lib/videoTranslateOpenRouter.js";
import {
	runVoiceTranslateText,
	guessAudioFormatFromFilename,
	uploadVoiceTranslateTtsToUploadThing,
} from "./lib/voiceTranslateText.js";
import { logger } from "hono/logger";
import { UTApi, UTFile } from "uploadthing/server";
import { openRouterTranslateAuthMiddleware } from "./lib/translateFirebaseAuth.js";
import {
	getVideoTranslateProxyManager,
	shouldUseVideoTranslateProxies,
	validateVideoTranslateProxyPoolAtStartup,
} from "./lib/proxyManager.js";
import {
	clientIpFromContext,
	getTranslateApiLogContext,
	scheduleTranslationApiLog,
	setTranslateApiLogContext,
	appendTranslateApiLogParams,
	buildFallbackTranslateApiLogContext,
} from "./lib/translateApiLogger.js";
import { createVideoCaptionJob, getVideoCaptionJobStatus } from "./lib/videoCaptionGenerator.js";
import { createViralClipCutJob, getViralClipCutJobStatus } from "./lib/viralClipCutter.js";
import { runFreeTextToAudio } from "./lib/freeTextToAudio.js";
import { getFreeTtsModelsCatalog } from "./lib/freeTtsModels.js";
import { getFreeKokoroVoicesResponse } from "./lib/freeKokoroVoices.js";
import { getPiperConfigStatus } from "./lib/piperTts.js";
import { getDefaultFreeTtsEngine } from "./lib/freeTtsModels.js";

dotenv.config();
const utapi = new UTApi({ token: process.env.UPLOADTHING_TOKEN });

const piperStartup = getPiperConfigStatus();
if (process.env.PIPER_MODEL?.trim() && !piperStartup.ready) {
	console.warn(
		`[free-tts] PIPER_MODEL is set but not usable: ${piperStartup.reason}. Default TTS engine: ${getDefaultFreeTtsEngine()}`,
	);
} else if (piperStartup.ready) {
	console.log(`[free-tts] Piper ready: ${piperStartup.model}`);
} else {
	console.log(`[free-tts] Piper not configured; default TTS engine: openrouter (Kokoro)`);
}

const videoTranslateProxyPool = getVideoTranslateProxyManager();
if (videoTranslateProxyPool.hasProxies()) {
	const useProxies = shouldUseVideoTranslateProxies();
	console.log(
		useProxies
			? `[proxy] video-translate pool ready: ${videoTranslateProxyPool.count} proxies (${videoTranslateProxyPool.getHealthyCount()} healthy)`
			: `[proxy] video-translate pool loaded: ${videoTranslateProxyPool.count} proxies (skipped locally — direct yt-dlp; set VIDEO_TRANSLATE_PROXY_ENABLED=1 to test proxy)`,
	);
	if (useProxies) {
		void validateVideoTranslateProxyPoolAtStartup(videoTranslateProxyPool);
	}
}
void logYtDlpCookiesAtStartup();

const app = new Hono();

// Add CORS middleware
app.use(
	"*",
	cors({
		origin: [
			"http://localhost:4001",
			"http://localhost:3000",
			"http://localhost:3001",
			"http://localhost:3002",
			"http://localhost:3003",
			"https://ihatereading.in",
			"https://www.inkgest.com",
			"https://aantraa.com",
			"https://www.aantraa.com",
			"https://www.aantraa.site",
			"https://gettemplate.app/",
			"https://swipe-emails.vercel.app",
		], // Allow specific origins
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		// Do not set allowHeaders to a fixed list: browsers send Access-Control-Request-Headers
		// (e.g. authorization, sentry-trace, baggage). Hono mirrors those when allowHeaders is empty.
		exposeHeaders: [
			"X-Video-Translate-Id",
			"X-Caption-Url",
			"X-Audio-Input-Url",
			"X-Audio-Url",
			"X-Free-Tts-Request-Id",
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
	const logCtx =
		getTranslateApiLogContext(c) ?? buildFallbackTranslateApiLogContext(c, routeLabel);
	scheduleTranslationApiLog(c, routeLabel, payload, status, logCtx);
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

/** OpenRouter Gemini TTS voice catalog + cached UploadThing preview WAVs (`resources/tts-voices.json`). */
app.get("/api/translate/tts-voices", async (c) => {
	const out = await getOpenRouterTtsVoicesWithPreviews();
	c.header("Cache-Control", out.data?.previews_complete ? "public, max-age=3600" : "no-store");
	return c.json(out);
});
app.get("/api/video-translate/tts-voices", async (c) => {
	const out = await getOpenRouterTtsVoicesWithPreviews();
	c.header("Cache-Control", out.data?.previews_complete ? "public, max-age=3600" : "no-store");
	return c.json(out);
});

// ─── Free text → speech (OpenRouter TTS + UploadThing) ─────────────────────────
//
// POST /api/audio-to-text — { text, language?, tts_voice?, voice_id?, tts_model?, tts_engine? }
// GET  /api/audio-to-text/voices — Kokoro voice catalog (male/female) + free TTS model presets
// GET  /api/audio-to-text/languages — same language list as video-translate

const FREE_TTS_POST_RATE_LIMIT = 30;
const FREE_TTS_POST_RATE_WINDOW_MS = 10 * 60 * 1000;

function applyFreeTtsApiHeaders(c, opts = {}) {
	const { requestId, audioUrl } = opts;
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Cache-Control", "no-store, private, max-age=0");
	if (requestId) c.header("X-Free-Tts-Request-Id", String(requestId));
	if (audioUrl) c.header("X-Audio-Url", String(audioUrl).slice(0, 2048));
}

app.get("/api/audio-to-text/languages", async (c) => {
	applyVideoTranslateApiHeaders(c, { cacheLanguages: true });
	return c.json(getVideoTranslateLanguagesResponse());
});

app.get("/api/audio-to-text/voices", async (c) => {
	const kokoro = getFreeKokoroVoicesResponse();
	const models = getFreeTtsModelsCatalog();
	c.header("Cache-Control", "public, max-age=3600");
	return c.json({
		error: null,
		data: {
			tier: "free",
			tts_engine: models.default_engine,
			model: models.default_preset === "piper" ? "piper" : models.default_chain[0],
			default_voice_id: kokoro.default_voice_id,
			default_tts_voice: kokoro.default_tts_voice,
			preview_text:
				"Hello! This is a sample of how I will narrate your content.",
			voices: kokoro.voices,
			voices_by_gender: kokoro.voices_by_gender,
			tts_models: models.models,
			default_tts_model: models.default_preset,
			default_tts_engine: models.default_engine,
			cost_note:
				"Free tier uses Piper (local) when configured, else Kokoro on OpenRouter. Gemini TTS is not used on this endpoint.",
		},
	});
});

app.post("/api/audio-to-text", async (c) => {
	const reqId = uuidv4();
	const clientIp = clientIpFromContext(c);
	const rl = rateLimit(
		clientIp,
		FREE_TTS_POST_RATE_LIMIT,
		FREE_TTS_POST_RATE_WINDOW_MS,
	);
	if (!rl.allowed) {
		c.header("Retry-After", String(rl.retryAfter));
		c.header("X-RateLimit-Limit", String(FREE_TTS_POST_RATE_LIMIT));
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Window", "10 minutes");
		return c.json(
			{
				success: false,
				error: "Rate limit exceeded",
				code: "RATE_LIMITED",
				retryAfter: rl.retryAfter,
			},
			429,
		);
	}
	c.header("X-RateLimit-Limit", String(FREE_TTS_POST_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(rl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");

	const contentType = c.req.header("content-type") || "";
	let text;
	let ttsVoiceOpt;
	let voiceIdOpt;
	let brandVoiceIdOpt;
	let ttsModelOpt;
	let ttsEngineOpt;
	let piperModelOpt;
	let languageOpt;
	let outputLanguageOpt;
	let sourceLanguageOpt;
	let sourceNllbOpt;
	let transcriptLanguageOpt;
	let translateModelOpt;

	if (contentType.includes("application/json")) {
		let body = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
		}
		text = body.text ?? body.source_text;
		languageOpt = body.language;
		outputLanguageOpt = body.output_language;
		sourceLanguageOpt = body.source_language;
		sourceNllbOpt = body.source_nllb;
		transcriptLanguageOpt = body.transcript_language;
		translateModelOpt = body.translate_model;
		ttsVoiceOpt = body.tts_voice;
		voiceIdOpt = body.voice_id;
		brandVoiceIdOpt = body.brand_voice_id;
		ttsModelOpt = body.tts_model ?? body.model;
		ttsEngineOpt = body.tts_engine;
		piperModelOpt = body.piper_model;
	} else if (contentType.includes("multipart/form-data")) {
		let form;
		try {
			form = await c.req.formData();
		} catch {
			return c.json(
				{ error: "Invalid multipart/form-data payload", code: "BAD_REQUEST" },
				400,
			);
		}
		const tf = form.get("text") ?? form.get("source_text");
		if (tf != null) text = String(tf);
		if (form.has("language")) languageOpt = String(form.get("language") ?? "");
		if (form.has("output_language")) {
			outputLanguageOpt = String(form.get("output_language") ?? "");
		}
		if (form.has("source_language")) {
			sourceLanguageOpt = String(form.get("source_language") ?? "");
		}
		if (form.has("source_nllb")) {
			sourceNllbOpt = String(form.get("source_nllb") ?? "");
		}
		if (form.has("transcript_language")) {
			transcriptLanguageOpt = String(form.get("transcript_language") ?? "");
		}
		if (form.has("translate_model")) {
			translateModelOpt = String(form.get("translate_model") ?? "");
		}
		if (form.has("tts_voice")) ttsVoiceOpt = String(form.get("tts_voice") ?? "");
		if (form.has("voice_id")) voiceIdOpt = String(form.get("voice_id") ?? "");
		if (form.has("brand_voice_id")) {
			brandVoiceIdOpt = String(form.get("brand_voice_id") ?? "");
		}
		if (form.has("tts_model")) ttsModelOpt = String(form.get("tts_model") ?? "");
		if (form.has("model")) ttsModelOpt = String(form.get("model") ?? "");
		if (form.has("tts_engine")) ttsEngineOpt = String(form.get("tts_engine") ?? "");
		if (form.has("piper_model")) {
			piperModelOpt = String(form.get("piper_model") ?? "");
		}
	} else {
		return c.json(
			{
				error:
					"Unsupported Content-Type. Use application/json or multipart/form-data.",
				code: "UNSUPPORTED_MEDIA_TYPE",
			},
			415,
		);
	}

	const out = await runFreeTextToAudio({
		text,
		language: languageOpt,
		output_language: outputLanguageOpt,
		source_language: sourceLanguageOpt,
		source_nllb: sourceNllbOpt,
		transcript_language: transcriptLanguageOpt,
		translate_model: translateModelOpt,
		tts_voice: ttsVoiceOpt,
		voice_id: voiceIdOpt,
		brand_voice_id: brandVoiceIdOpt,
		tts_model: ttsModelOpt,
		tts_engine: ttsEngineOpt,
		piper_model: piperModelOpt,
		uploadAudioBufferToUploadThing,
		requestId: reqId,
	});
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;
	applyFreeTtsApiHeaders(c, {
		requestId: reqId,
		audioUrl: rest?.data?.audio_url,
	});
	return c.json(rest, status);
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
	const vtIp = clientIpFromContext(c);
	const voiceRouteLabel = c.req.path.includes("/video-translate/text")
		? "video-translate/text"
		: "voice-translate/text";
	setTranslateApiLogContext(c, {
		routeLabel: voiceRouteLabel,
		provider: "openrouter",
		apiKind: "voice_translate",
		requestId: vtReqId,
		clientIp: vtIp,
	});

	const authHdr =
		c.req.header("Authorization") || c.req.header("authorization");
	const authToken = authHdr?.startsWith("Bearer ")
		? authHdr.slice(7).trim()
		: authHdr?.trim();
	if (!authToken) {
		return jsonTranslateApi(
			c,
			voiceRouteLabel,
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide a Bearer token in the Authorization header",
			},
			401,
		);
	}

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
			voiceRouteLabel,
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
	let ttsVoiceOpt;
	let brandVoiceIdOpt;
	let voiceIdOpt;

	const contentType = c.req.header("content-type") || "";
	appendTranslateApiLogParams(c, { content_type: contentType || null });

	if (contentType.includes("multipart/form-data")) {
		let form;
		try {
			form = await c.req.formData();
		} catch {
			return jsonTranslateApi(
				c,
				voiceRouteLabel,
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
					voiceRouteLabel,
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
					voiceRouteLabel,
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
		if (form.has("tts_voice")) {
			ttsVoiceOpt = String(form.get("tts_voice") ?? "");
		}
		if (form.has("brand_voice_id")) {
			brandVoiceIdOpt = String(form.get("brand_voice_id") ?? "");
		}
		if (form.has("voice_id")) {
			voiceIdOpt = String(form.get("voice_id") ?? "");
		}
	} else if (contentType.includes("application/json")) {
		let body = {};
		try {
			body = await c.req.json();
		} catch {
			return jsonTranslateApi(
				c,
				voiceRouteLabel,
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
		ttsVoiceOpt = body.tts_voice;
		brandVoiceIdOpt = body.brand_voice_id;
		voiceIdOpt = body.voice_id;
	} else {
		return jsonTranslateApi(
			c,
			voiceRouteLabel,
			{
				error:
					"Unsupported Content-Type. Use application/json or multipart/form-data.",
			},
			415,
		);
	}

	const utTok = process.env.UPLOADTHING_TOKEN?.trim();
	appendTranslateApiLogParams(c, {
		text_length: typeof text === "string" ? text.length : 0,
		has_text: Boolean(String(text ?? "").trim()),
		audio_url: audioUrl ? String(audioUrl).trim() : null,
		audio_upload_byte_length: audioBuffer?.length ?? null,
		audio_format: audioFormat ?? null,
		languages,
		include_audio: includeAudio,
		model: modelOpt ?? null,
		llm_model: llmModelOpt ?? null,
		translation_engine: translationEngineOpt ?? null,
		tts_engine: ttsEngineOpt ?? null,
		glossary_refinement: glossaryRefinementOpt ?? null,
		piper_model: piperModelOpt ?? null,
		source_nllb: sourceNllbOpt ?? null,
		transcript_language: transcriptLanguageOpt ?? null,
		source_language: sourceLanguageOpt ?? null,
		glossary_refine_model: glossaryRefineModelOpt ?? null,
		tts_voice: ttsVoiceOpt ?? null,
		brand_voice_id: brandVoiceIdOpt ?? null,
		voice_id: voiceIdOpt ?? null,
	});
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
		tts_voice: ttsVoiceOpt,
		brand_voice_id: brandVoiceIdOpt,
		voice_id: voiceIdOpt,
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
	return jsonTranslateApi(c, voiceRouteLabel, rest, status);
};

app.post("/api/voice-translate/text", handleVoiceTranslateTextPost);
/** Same as /api/voice-translate/text — avoids 404 when clients use "video" instead of "voice". */
app.post("/api/video-translate/text", handleVoiceTranslateTextPost);

const VIDEO_TRANSLATE_POST_RATE_LIMIT = 10;
const VIDEO_TRANSLATE_POST_RATE_WINDOW_MS = 10 * 60 * 1000;

function normalizeVideoUrlString(v) {
	if (v == null) return "";
	const s = String(v).trim();
	return s;
}

/** JSON body keys for a remote video URL (same for /api/video-translate). */
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
	const vtVideoReqId = uuidv4();
	const vtVideoIp = clientIpFromContext(c);
	setTranslateApiLogContext(c, {
		routeLabel: "video-translate",
		provider: "openrouter",
		apiKind: "video_translate",
		requestId: vtVideoReqId,
		clientIp: vtVideoIp,
	});

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
	c.header("X-Video-Translate-Request-Id", vtVideoReqId);

	const contentType = c.req.header("content-type") || "";
	let videoUrl;
	let body = {};

	const parseBool = (v) => v === true || v === "true" || v === "1";
	appendTranslateApiLogParams(c, { content_type: contentType || null });

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
		if (form.has("tts_voice")) {
			body.tts_voice = String(form.get("tts_voice") ?? "");
		}
		if (form.has("voice_id")) {
			body.voice_id = String(form.get("voice_id") ?? "");
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

	appendTranslateApiLogParams(c, {
		video_url: payload.video_url,
		output_language: payload.output_language ?? null,
		output_languages: payload.output_languages ?? null,
		title: payload.title ?? body.title ?? null,
		translate_audio_only: payload.translate_audio_only ?? null,
		keep_the_same_format: payload.keep_the_same_format ?? null,
		mode: payload.mode ?? null,
		speaker_num: payload.speaker_num ?? null,
		callback_id: payload.callback_id ?? null,
		plan: body.plan ?? null,
		user_plan: body.user_plan ?? null,
		subscription_plan: body.subscription_plan ?? null,
		tier: body.tier ?? null,
		model: body.model ?? null,
		llm_model: body.llm_model ?? null,
		translation_engine: body.translation_engine ?? null,
		tts_engine: body.tts_engine ?? null,
		glossary_refinement: body.glossary_refinement ?? null,
		piper_model: body.piper_model ?? null,
		source_nllb: body.source_nllb ?? null,
		transcript_language: body.transcript_language ?? null,
		source_language: body.source_language ?? null,
		glossary_refine_model: body.glossary_refine_model ?? null,
		brand_voice_id: body.brand_voice_id ?? null,
		tts_voice: body.tts_voice ?? null,
		voice_id: body.voice_id ?? null,
	});

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
			brand_voice_id: body.brand_voice_id,
			tts_voice: body.tts_voice,
			voice_id: body.voice_id,
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
	return c.json({
		message: "Hello World",
		api_version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local",
		free_tts: true,
	});
});

// ─── AI video caption generator (OpenRouter + FFmpeg + UploadThing) ─────────────
//
// POST /api/video-caption — { video_url, language | output_language | caption_language, caption_style?, caption_mode?, burn_captions?, model? }
// multipart: file or video + optional fields above
// GET  /api/video-caption/:id — job status; returns captioned video URL, summary, titles, thumbnail_texts, hooks when success

function applyVideoCaptionApiHeaders(c, opts = {}) {
	const { videoCaptionId, captionUrl, captionedVideoUrl } = opts;
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Cache-Control", "no-store, private, max-age=0");
	if (videoCaptionId) {
		c.header("X-Video-Caption-Id", String(videoCaptionId));
	}
	if (captionUrl) {
		c.header("X-Caption-Url", String(captionUrl));
	}
	if (captionedVideoUrl) {
		c.header("X-Captioned-Video-Url", String(captionedVideoUrl));
	}
}

const VIDEO_CAPTION_POST_RATE_LIMIT = 10;
const VIDEO_CAPTION_POST_RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * POST /api/video-caption
 * JSON: { video_url | videoUrl, language | output_language | caption_language, caption_style?, caption_mode?, burn_captions?, model | llm_model? }
 * multipart: file or video (uploads to UploadThing), optional video_url, language, output_language, caption_style (top|bottom), etc.
 * Auth: non-empty Authorization (Bearer token). Rate limited per IP.
 */
app.post("/api/video-caption", async (c) => {
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
	const clientIp =
		xff?.split(",")?.[0]?.trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const rl = rateLimit(
		clientIp,
		VIDEO_CAPTION_POST_RATE_LIMIT,
		VIDEO_CAPTION_POST_RATE_WINDOW_MS,
	);
	if (!rl.allowed) {
		c.header("Retry-After", String(rl.retryAfter));
		c.header("X-RateLimit-Limit", String(VIDEO_CAPTION_POST_RATE_LIMIT));
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
	c.header("X-RateLimit-Limit", String(VIDEO_CAPTION_POST_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(rl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");

	const contentType = c.req.header("content-type") || "";
	let videoUrl;
	let body = {};

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
				return c.json(
					{ error: e?.message || "Video upload failed" },
					502,
				);
			}
		}
		if (!videoUrl) {
			videoUrl = form.get("video_url") || form.get("videoUrl");
		}
		if (form.has("language")) body.language = String(form.get("language") ?? "");
		if (form.has("caption_language")) {
			body.caption_language = String(form.get("caption_language") ?? "");
		}
		if (form.has("output_language")) {
			body.output_language = String(form.get("output_language") ?? "");
		}
		if (form.has("caption_style")) {
			body.caption_style = String(form.get("caption_style") ?? "");
		}
		if (form.has("caption_position")) {
			body.caption_position = String(form.get("caption_position") ?? "");
		}
		if (form.has("caption_mode")) {
			body.caption_mode = String(form.get("caption_mode") ?? "");
		}
		if (form.has("style")) body.style = String(form.get("style") ?? "");
		if (form.has("burn_captions")) {
			body.burn_captions = form.get("burn_captions");
		}
		if (form.has("burnCaptions")) {
			body.burnCaptions = form.get("burnCaptions");
		}
		const modelField = form.get("model");
		if (modelField != null && String(modelField).trim() !== "") {
			body.model = String(modelField).trim();
		}
		const llmModelField = form.get("llm_model");
		if (llmModelField != null && String(llmModelField).trim() !== "") {
			body.llm_model = String(llmModelField).trim();
		}
	} else if (contentType.includes("application/json")) {
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		videoUrl = body.video_url || body.videoUrl;
	} else {
		return c.json(
			{
				error:
					"Unsupported Content-Type. Use application/json or multipart/form-data.",
			},
			415,
		);
	}

	if (!videoUrl || !String(videoUrl).trim()) {
		return c.json(
			{
				error:
					"Provide video_url (or videoUrl) or upload a video file (field: file or video)",
			},
			400,
		);
	}

	const out = await createVideoCaptionJob({
		videoUrl: String(videoUrl).trim(),
		body,
	});
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;
	const createdId = rest?.data?.video_caption_id ?? null;
	applyVideoCaptionApiHeaders(c, { videoCaptionId: createdId });
	return c.json(rest, status);
});

/** GET /api/video-caption/:id — job status; captioned video + caption URLs when success */
app.get("/api/video-caption/:id", async (c) => {
	const id = c.req.param("id");
	const out = await getVideoCaptionJobStatus(id);
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;
	const d = rest?.data;
	applyVideoCaptionApiHeaders(c, {
		videoCaptionId: id,
		captionUrl: d?.caption_url,
		captionedVideoUrl: d?.captioned_video_url || d?.videoUrl,
	});
	return c.json(rest, status);
});


// ─── Viral clip cutter (OpenRouter + FFmpeg + UploadThing) ────────────────────
//
// POST /api/viral-clip-cut — { video_url, prompt?, clip_count?, max_clips?, ... }
// GET  /api/viral-clip-cut/:id — job status; returns clips[] with video URLs when success

function applyViralClipCutApiHeaders(c, opts = {}) {
	const { viralClipCutId, clipCount } = opts;
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Cache-Control", "no-store, private, max-age=0");
	if (viralClipCutId) {
		c.header("X-Viral-Clip-Cut-Id", String(viralClipCutId));
	}
	if (clipCount != null) {
		c.header("X-Clip-Count", String(clipCount));
	}
}

const VIRAL_CLIP_CUT_POST_RATE_LIMIT = 10;
const VIRAL_CLIP_CUT_POST_RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * POST /api/viral-clip-cut
 * JSON: { video_url | videoUrl, prompt?, clip_count?, max_clips?, min_clip_sec?, max_clip_sec?, target_aspect?, model? }
 * multipart: file or video + optional fields above
 */
app.post("/api/viral-clip-cut", async (c) => {
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
	const clientIp =
		xff?.split(",")?.[0]?.trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown";
	const rl = rateLimit(
		clientIp,
		VIRAL_CLIP_CUT_POST_RATE_LIMIT,
		VIRAL_CLIP_CUT_POST_RATE_WINDOW_MS,
	);
	if (!rl.allowed) {
		c.header("Retry-After", String(rl.retryAfter));
		c.header("X-RateLimit-Limit", String(VIRAL_CLIP_CUT_POST_RATE_LIMIT));
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
	c.header("X-RateLimit-Limit", String(VIRAL_CLIP_CUT_POST_RATE_LIMIT));
	c.header("X-RateLimit-Remaining", String(rl.remaining));
	c.header("X-RateLimit-Window", "10 minutes");

	const contentType = c.req.header("content-type") || "";
	let videoUrl;
	let body = {};

	const parseNumField = (form, ...keys) => {
		for (const k of keys) {
			if (!form.has(k)) continue;
			const v = form.get(k);
			if (v == null || String(v).trim() === "") continue;
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
		return undefined;
	};

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
				return c.json(
					{ error: e?.message || "Video upload failed" },
					502,
				);
			}
		}
		if (!videoUrl) {
			videoUrl = form.get("video_url") || form.get("videoUrl");
		}
		if (form.has("prompt")) body.prompt = String(form.get("prompt") ?? "");
		if (form.has("context")) body.context = String(form.get("context") ?? "");
		if (form.has("language")) body.language = String(form.get("language") ?? "");
		const clipCount = parseNumField(form, "clip_count", "clipCount");
		if (clipCount != null) body.clip_count = clipCount;
		const maxClips = parseNumField(form, "max_clips", "maxClips");
		if (maxClips != null) body.max_clips = maxClips;
		const minClipSec = parseNumField(form, "min_clip_sec", "minClipSec");
		if (minClipSec != null) body.min_clip_sec = minClipSec;
		const maxClipSec = parseNumField(form, "max_clip_sec", "maxClipSec");
		if (maxClipSec != null) body.max_clip_sec = maxClipSec;
		const secondsPerClip = parseNumField(
			form,
			"seconds_per_clip",
			"secondsPerClip",
		);
		if (secondsPerClip != null) body.seconds_per_clip = secondsPerClip;
		if (form.has("target_aspect")) {
			body.target_aspect = String(form.get("target_aspect") ?? "");
		}
		if (form.has("targetAspect")) {
			body.targetAspect = String(form.get("targetAspect") ?? "");
		}
		const modelField = form.get("model");
		if (modelField != null && String(modelField).trim() !== "") {
			body.model = String(modelField).trim();
		}
		const llmModelField = form.get("llm_model");
		if (llmModelField != null && String(llmModelField).trim() !== "") {
			body.llm_model = String(llmModelField).trim();
		}
	} else if (contentType.includes("application/json")) {
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		videoUrl = body.video_url || body.videoUrl;
	} else {
		return c.json(
			{
				error:
					"Unsupported Content-Type. Use application/json or multipart/form-data.",
			},
			415,
		);
	}

	if (!videoUrl || !String(videoUrl).trim()) {
		return c.json(
			{
				error:
					"Provide video_url (or videoUrl) or upload a video file (field: file or video)",
			},
			400,
		);
	}

	const out = await createViralClipCutJob({
		videoUrl: String(videoUrl).trim(),
		body,
	});
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;
	const createdId = rest?.data?.viral_clip_cut_id ?? null;
	applyViralClipCutApiHeaders(c, { viralClipCutId: createdId });
	return c.json(rest, status);
});

/** GET /api/viral-clip-cut/:id — job status; clips[] with video URLs when success */
app.get("/api/viral-clip-cut/:id", async (c) => {
	const id = c.req.param("id");
	const out = await getViralClipCutJobStatus(id);
	const status = out.httpStatus ?? 200;
	const { httpStatus: _h, ...rest } = out;
	const d = rest?.data;
	applyViralClipCutApiHeaders(c, {
		viralClipCutId: id,
		clipCount: d?.clip_count,
	});
	return c.json(rest, status);
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