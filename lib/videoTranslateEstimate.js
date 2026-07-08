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

function buildEstimatePrompt(params, heuristic) {
	const {
		durationSec,
		outputLanguage,
		translationEngine,
		ttsEngine,
		glossaryRefinement,
	} = params;
	const durationMin = Math.round((durationSec / 60) * 10) / 10;
	return `You are a pricing estimator for an AI video dubbing API. Always return positive numeric estimates (never zero tokens or zero cost).

Pipeline:
- Duration: ${Math.ceil(durationSec)} seconds (${durationMin} minutes)
- Target language: ${outputLanguage}
- Translation: ${translationEngine === "nllb" ? "NLLB local MT after Gemini transcribe" : "Gemini multimodal (transcribe + translate, full video input)"}
- TTS: ${ttsEngine === "piper" ? "local Piper (no OpenRouter TTS cost)" : "OpenRouter Gemini TTS"}
- Glossary refinement: ${glossaryRefinement ? "yes" : "no"}

Planning ballpark (adjust slightly, but stay in this range):
- ~${heuristic.estimated_tokens.total_tokens} total tokens
- ~$${heuristic.estimated_cost_usd.low}–$${heuristic.estimated_cost_usd.high} USD
- ~${heuristic.estimated_time_minutes.low}–${heuristic.estimated_time_minutes.high} minutes processing

Reply with ONLY JSON (no markdown):
{
  "estimated_tokens": { "prompt_tokens": number, "completion_tokens": number, "total_tokens": number },
  "estimated_cost_usd": { "low": number, "high": number },
  "estimated_time_minutes": { "low": number, "high": number },
  "summary": "one short sentence"
}`;
}

/** Deterministic fallback when the LLM refuses or returns zeros. */
function buildHeuristicEstimate(params) {
	const {
		durationSec,
		outputLanguage,
		translationEngine,
		ttsEngine,
		glossaryRefinement,
	} = params;
	const durationMin = durationSec / 60;
	const speechChars = Math.ceil(durationMin * 750);
	const translationChars = Math.ceil(speechChars * 1.12);

	let promptTokens = 0;
	let completionTokens = 0;

	if (translationEngine === "nllb") {
		promptTokens += Math.ceil(durationSec * 190);
		completionTokens += Math.ceil(speechChars * 0.28);
	} else {
		promptTokens += Math.ceil(durationSec * 220);
		completionTokens += Math.ceil((speechChars + translationChars) * 0.28);
	}

	if (glossaryRefinement) {
		promptTokens += Math.ceil(translationChars * 0.25);
		completionTokens += Math.ceil(translationChars * 0.15);
	}

	const ttsTokens =
		ttsEngine === "piper" ? 0 : Math.ceil(translationChars * 0.32);
	const totalTokens = promptTokens + completionTokens + ttsTokens;

	const videoUsd = (promptTokens / 1_000_000) * 0.35;
	const outputUsd = (completionTokens / 1_000_000) * 0.75;
	const ttsUsd = (ttsTokens / 1_000_000) * 0.2;
	const baseUsd = videoUsd + outputUsd + ttsUsd + 0.008;
	const costLow = Math.max(0.01, Math.round(baseUsd * 0.9 * 10_000) / 10_000);
	const costHigh = Math.max(
		costLow,
		Math.round(baseUsd * 1.5 * 10_000) / 10_000,
	);

	const timeLow = Math.max(2, Math.round((durationMin * 0.85 + 2) * 10) / 10);
	const timeHigh = Math.max(
		timeLow + 1,
		Math.round((durationMin * 1.55 + 4) * 10) / 10,
	);

	return {
		estimated_tokens: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: totalTokens,
		},
		estimated_cost_usd: { low: costLow, high: costHigh },
		estimated_time_minutes: { low: timeLow, high: timeHigh },
		summary: `Estimated cost for dubbing a ${Math.round(durationMin * 10) / 10}-minute video to ${outputLanguage}.`,
		estimate_source: "heuristic",
	};
}

function isValidNormalizedEstimate(payload) {
	return (
		payload?.estimated_tokens?.total_tokens > 0 &&
		payload?.estimated_cost_usd?.high > 0
	);
}

function normalizeEstimatePayload(raw) {
	const tokens = raw?.estimated_tokens || raw?.tokens || {};
	const cost = raw?.estimated_cost_usd || raw?.cost_usd || {};
	const time = raw?.estimated_time_minutes || raw?.time_minutes || {};

	const promptTokens = Number(tokens.prompt_tokens ?? tokens.promptTokens ?? 0);
	const completionTokens = Number(
		tokens.completion_tokens ?? tokens.completionTokens ?? 0,
	);
	let totalTokens = Number(
		tokens.total_tokens ??
			tokens.totalTokens ??
			promptTokens + completionTokens,
	);
	const costLow = Number(
		cost.low ?? cost.min ?? cost.low_usd ?? cost.minimum ?? 0,
	);
	const costHigh = Number(
		cost.high ?? cost.max ?? cost.high_usd ?? cost.maximum ?? costLow,
	);
	const timeLow = Number(time.low ?? time.min ?? 0);
	const timeHigh = Number(time.high ?? time.max ?? timeLow);

	if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
		if (promptTokens + completionTokens > 0) {
			totalTokens = promptTokens + completionTokens;
		}
	}

	if (
		!Number.isFinite(totalTokens) ||
		totalTokens <= 0 ||
		!Number.isFinite(costLow) ||
		!Number.isFinite(costHigh) ||
		costHigh <= 0
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
			low: Math.max(0.0001, Math.round(costLow * 10_000) / 10_000),
			high: Math.max(costLow, Math.round(costHigh * 10_000) / 10_000),
		},
		estimated_time_minutes: {
			low: Math.max(0.5, Math.round(timeLow * 10) / 10),
			high: Math.max(timeLow, Math.round(timeHigh * 10) / 10),
		},
		summary:
			typeof raw?.summary === "string" && raw.summary.trim()
				? raw.summary.trim()
				: "Estimated cost and processing time for video translation.",
	};
}

async function fetchLlmEstimateOnce(params, heuristic, signal) {
	const res = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterFetchHeaders(),
		body: JSON.stringify({
			model: ESTIMATE_MODEL,
			messages: [
				{
					role: "user",
					content: buildEstimatePrompt(params, heuristic),
				},
			],
			temperature: 0.15,
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
	const normalized = normalizeEstimatePayload(parsed);
	if (!isValidNormalizedEstimate(normalized)) {
		throw new Error("Model returned invalid estimate fields");
	}
	return normalized;
}

async function fetchEstimate(params) {
	const heuristic = buildHeuristicEstimate(params);
	const llmSignal = AbortSignal.timeout(ESTIMATE_TIMEOUT_MS);
	let lastErr;

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const llm = await fetchLlmEstimateOnce(params, heuristic, llmSignal);
			return { ...llm, estimate_source: "llm" };
		} catch (e) {
			lastErr = e;
		}
	}

	console.warn(
		"[video-translate/estimate] LLM estimate unavailable, using heuristic:",
		lastErr instanceof Error ? lastErr.message : lastErr,
	);
	return heuristic;
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
	const durationSignal = AbortSignal.timeout(ESTIMATE_TIMEOUT_MS);

	let durationSec;
	let durationSource;
	try {
		const resolved = await resolveVideoDurationSeconds(
			url,
			durationSignal,
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

	const estimateParams = {
		durationSec,
		outputLanguage,
		translationEngine,
		ttsEngine,
		glossaryRefinement,
	};

	const estimate = await fetchEstimate(estimateParams);

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
				...(body.brand_voice_id || body.tts_voice || body.voice_id
					? {
							tts_voice:
								body.brand_voice_id ?? body.tts_voice ?? body.voice_id,
						}
					: {}),
			},
			...estimate,
		},
		httpStatus: 200,
	};
}
