import { execFile } from "node:child_process";
import {
	isYoutubeVideoUrl,
	normalizeYoutubeVideoUrl,
	resolveYoutubeRapidApiMedia,
} from "./rapidApiYoutubeDownload.js";
import { getFfprobeBin } from "./ffmpegBin.js";
import { VIDEO_TRANSLATE_TARGET_LANGUAGES } from "./videoTranslateLanguages.js";
import {
	normalizeOpenRouterTtsEngine,
	normalizeVideoTranslationEngine,
} from "./videoTranslateOpenRouter.js";
import {
	extractMessageText,
	parseJsonObjectFromModel,
} from "./parseModelJson.js";

const OPENROUTER_API_V1 =
	process.env.OPENROUTER_API_BASE?.trim() || "https://openrouter.ai/api/v1";
const OPENROUTER_CHAT = `${OPENROUTER_API_V1}/chat/completions`;
const ESTIMATE_MODEL =
	process.env.VIDEO_TRANSLATE_ESTIMATE_MODEL?.trim() ||
	"google/gemini-2.5-flash";
const ESTIMATE_TIMEOUT_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_ESTIMATE_TIMEOUT_MS || "", 10) ||
	60_000;
const FFPROBE_TIMEOUT_MS =
	Number.parseInt(process.env.VIDEO_TRANSLATE_FFPROBE_TIMEOUT_MS || "", 10) ||
	45_000;

/** YouTube URLs above this duration are rejected for cost estimation. */
export const MAX_YOUTUBE_ESTIMATE_MINUTES = 20;
export const MAX_YOUTUBE_ESTIMATE_SEC = MAX_YOUTUBE_ESTIMATE_MINUTES * 60;

function getOpenRouterKey() {
	return process.env.OPENROUTER_API_KEY?.trim() || "";
}

function openRouterFetchHeaders() {
	const key = getOpenRouterKey();
	const h = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${key}`,
	};
	const ref = process.env.OPENROUTER_HTTP_REFERER?.trim();
	h.Referer = ref || "https://openrouter.ai";
	const title = process.env.OPENROUTER_APP_TITLE?.trim();
	if (title) h["X-Title"] = title;
	return h;
}

export function resolveSupportedOutputLanguage(raw) {
	const s = String(raw || "").trim();
	if (!s) return null;
	const lower = s.toLowerCase();
	const exact = VIDEO_TRANSLATE_TARGET_LANGUAGES.find(
		(l) => l.toLowerCase() === lower,
	);
	if (exact) return exact;
	const starts = VIDEO_TRANSLATE_TARGET_LANGUAGES.find((l) =>
		l.toLowerCase().startsWith(lower),
	);
	if (starts) return starts;
	const contains = VIDEO_TRANSLATE_TARGET_LANGUAGES.find((l) =>
		l.toLowerCase().includes(lower),
	);
	return contains || null;
}

async function probeRemoteVideoDurationSeconds(url, signal) {
	const ffprobe = getFfprobeBin();
	const out = await new Promise((resolve, reject) => {
		const child = execFile(
			ffprobe,
			[
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"json",
				url,
			],
			{ timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
			(err, stdout) => {
				if (err) return reject(err);
				resolve(stdout);
			},
		);
		if (signal) {
			const onAbort = () => {
				child.kill();
				const e = new Error("Duration probe aborted");
				e.name = "AbortError";
				reject(e);
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	const parsed = JSON.parse(String(out || "{}"));
	const dur = Number(parsed?.format?.duration);
	return Number.isFinite(dur) && dur > 0 ? dur : null;
}

/**
 * Resolve video duration in seconds (YouTube via RapidAPI metadata; direct URLs via ffprobe).
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @param {number | null} [durationOverrideSec]
 */
export async function resolveVideoDurationSeconds(url, signal, durationOverrideSec) {
	const override = Number(durationOverrideSec);
	if (Number.isFinite(override) && override > 0) {
		return { durationSec: override, source: "client" };
	}

	const trimmed = String(url || "").trim();
	if (!trimmed) return { durationSec: null, source: null };

	if (isYoutubeVideoUrl(trimmed)) {
		const media = await resolveYoutubeRapidApiMedia(trimmed, signal);
		const durationSec =
			media.durationSec != null && Number.isFinite(media.durationSec)
				? media.durationSec
				: null;
		return { durationSec, source: "youtube_rapidapi" };
	}

	const durationSec = await probeRemoteVideoDurationSeconds(trimmed, signal);
	return { durationSec, source: "ffprobe" };
}

function buildEstimatePrompt({
	durationSec,
	outputLanguage,
	translationEngine,
	ttsEngine,
	glossaryRefinement,
}) {
	const durationMin = Math.round((durationSec / 60) * 10) / 10;
	return `You are a pricing estimator for an AI video dubbing API pipeline.

Pipeline for this job:
- Source video duration: ${Math.ceil(durationSec)} seconds (${durationMin} minutes)
- Target language: ${outputLanguage}
- Translation: ${translationEngine === "nllb" ? "local NLLB (no OpenRouter cost for translation text)" : "Gemini multimodal video LLM (transcribe + translate in one pass with full video as input)"}
- TTS: ${ttsEngine === "piper" ? "local Piper (no OpenRouter TTS cost)" : "OpenRouter Gemini TTS (/audio/speech), text chunked ~2800 chars"}
- Glossary refinement: ${glossaryRefinement ? "yes (extra OpenRouter LLM pass on translation)" : "no"}

Estimate total OpenRouter token usage and USD cost for this dubbing job, and wall-clock processing time on a typical cloud server (download + LLM + TTS + ffmpeg mux).

Reply with ONLY a JSON object (no markdown) with this exact shape:
{
  "estimated_tokens": { "prompt_tokens": number, "completion_tokens": number, "total_tokens": number },
  "estimated_cost_usd": { "low": number, "high": number },
  "estimated_time_minutes": { "low": number, "high": number },
  "summary": "one short sentence for the user"
}

Use realistic 2025–2026 OpenRouter pricing for google/gemini-2.5-flash video input and google/gemini TTS. Return conservative ranges (low/high). All USD amounts as numbers with 2–4 decimal places.`;
}

function normalizeEstimatePayload(raw) {
	const tokens = raw?.estimated_tokens || raw?.tokens || {};
	const cost = raw?.estimated_cost_usd || raw?.cost_usd || {};
	const time = raw?.estimated_time_minutes || raw?.time_minutes || {};

	const promptTokens = Number(tokens.prompt_tokens ?? tokens.promptTokens ?? 0);
	const completionTokens = Number(
		tokens.completion_tokens ?? tokens.completionTokens ?? 0,
	);
	const totalTokens = Number(
		tokens.total_tokens ??
			tokens.totalTokens ??
			promptTokens + completionTokens,
	);
	const costLow = Number(cost.low ?? cost.min ?? 0);
	const costHigh = Number(cost.high ?? cost.max ?? costLow);
	const timeLow = Number(time.low ?? time.min ?? 0);
	const timeHigh = Number(time.high ?? time.max ?? timeLow);

	if (
		!Number.isFinite(totalTokens) ||
		totalTokens <= 0 ||
		!Number.isFinite(costLow) ||
		!Number.isFinite(costHigh)
	) {
		throw new Error("Model returned invalid estimate fields");
	}

	return {
		estimated_tokens: {
			prompt_tokens: Math.max(0, Math.round(promptTokens)),
			completion_tokens: Math.max(0, Math.round(completionTokens)),
			total_tokens: Math.max(0, Math.round(totalTokens)),
		},
		estimated_cost_usd: {
			low: Math.max(0, Math.round(costLow * 10000) / 10000),
			high: Math.max(costLow, Math.round(costHigh * 10000) / 10000),
		},
		estimated_time_minutes: {
			low: Math.max(0, Math.round(timeLow * 10) / 10),
			high: Math.max(timeLow, Math.round(timeHigh * 10) / 10),
		},
		summary:
			typeof raw?.summary === "string" && raw.summary.trim()
				? raw.summary.trim()
				: "Estimated cost and processing time for video translation.",
	};
}

async function fetchLlmEstimate(params, signal) {
	const res = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterFetchHeaders(),
		body: JSON.stringify({
			model: ESTIMATE_MODEL,
			messages: [
				{
					role: "user",
					content: buildEstimatePrompt(params),
				},
			],
			temperature: 0.2,
			max_tokens: 1024,
			response_format: { type: "json_object" },
		}),
	});

	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.error) {
		const msg = String(
			data?.error?.message || data?.error || `HTTP ${res.status}`,
		);
		throw new Error(`Cost estimate LLM failed: ${msg}`);
	}

	const text = extractMessageText(data?.choices?.[0]?.message?.content);
	const parsed = parseJsonObjectFromModel(text);
	return normalizeEstimatePayload(parsed);
}

/**
 * @param {{ videoUrl: string, body: Record<string, unknown> }} input
 */
export async function estimateVideoTranslateCost({ videoUrl, body }) {
	if (!getOpenRouterKey()) {
		return {
			error: "OPENROUTER_API_KEY not configured",
			code: "MISSING_API_KEY",
			httpStatus: 503,
		};
	}

	const url = normalizeYoutubeVideoUrl(String(videoUrl || "").trim());
	if (!url) {
		return {
			error:
				"Provide video_url (or videoUrl, url, source_url, link) pointing to the source video",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const outputLanguage = resolveSupportedOutputLanguage(
		body.output_language ?? body.language,
	);
	if (!outputLanguage) {
		return {
			error: "Provide a supported output_language (see GET /api/video-translate/languages)",
			code: "BAD_REQUEST",
			httpStatus: 400,
			details: { supported_count: VIDEO_TRANSLATE_TARGET_LANGUAGES.length },
		};
	}

	const durationOverride = body.duration_sec ?? body.durationSec;
	const signal = AbortSignal.timeout(ESTIMATE_TIMEOUT_MS);

	let durationSec;
	let durationSource;
	try {
		const resolved = await resolveVideoDurationSeconds(
			url,
			signal,
			durationOverride != null ? Number(durationOverride) : null,
		);
		durationSec = resolved.durationSec;
		durationSource = resolved.source;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			error: `Unable to determine video duration: ${msg}`,
			code: "DURATION_UNAVAILABLE",
			httpStatus: 400,
			details: {
				hint: "For direct video URLs, optionally pass duration_sec in the request body.",
			},
		};
	}

	if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) {
		return {
			error: "Unable to determine video duration",
			code: "DURATION_UNAVAILABLE",
			httpStatus: 400,
			details: {
				hint: "Pass duration_sec in the request body if the URL cannot be probed.",
			},
		};
	}

	if (isYoutubeVideoUrl(url) && durationSec > MAX_YOUTUBE_ESTIMATE_SEC) {
		return {
			error: `Video is longer than supported maximum for YouTube URLs (${MAX_YOUTUBE_ESTIMATE_MINUTES} minutes).`,
			code: "VIDEO_TOO_LONG",
			httpStatus: 400,
			data: {
				video_url: url,
				output_language: outputLanguage,
				duration_sec: Math.ceil(durationSec),
				duration_min: Math.round((durationSec / 60) * 10) / 10,
				max_duration_sec: MAX_YOUTUBE_ESTIMATE_SEC,
				max_duration_min: MAX_YOUTUBE_ESTIMATE_MINUTES,
				source: "youtube",
			},
		};
	}

	const translationEngine = normalizeVideoTranslationEngine(
		body.translation_engine,
	);
	const ttsEngine = normalizeOpenRouterTtsEngine(body.tts_engine);
	const glossaryRefinement =
		body.glossary_refinement === true ||
		body.glossary_refinement === "true" ||
		body.glossary_refinement === "1";

	let estimate;
	try {
		estimate = await fetchLlmEstimate(
			{
				durationSec,
				outputLanguage,
				translationEngine,
				ttsEngine,
				glossaryRefinement,
			},
			signal,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			error: msg,
			code: "ESTIMATE_FAILED",
			httpStatus: 502,
		};
	}

	return {
		error: null,
		data: {
			video_url: url,
			output_language: outputLanguage,
			duration_sec: Math.ceil(durationSec),
			duration_min: Math.round((durationSec / 60) * 10) / 10,
			duration_source: durationSource,
			pipeline: {
				translation: translationEngine,
				tts: ttsEngine,
				glossary_refinement: glossaryRefinement,
			},
			...estimate,
		},
		httpStatus: 200,
	};
}
