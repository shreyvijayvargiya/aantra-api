/**
 * Free-tier OpenRouter TTS — Kokoro + Voxtral via /audio/speech only (no Gemini / gpt-audio).
 */
import { FREE_TTS_DEFAULT_MODEL_CHAIN } from "./freeTtsModels.js";

const OPENROUTER_API_V1 =
	process.env.OPENROUTER_API_BASE?.trim() || "https://openrouter.ai/api/v1";
const OPENROUTER_AUDIO_SPEECH =
	process.env.OPENROUTER_AUDIO_SPEECH_URL?.trim() ||
	`${OPENROUTER_API_V1}/audio/speech`;

/** @type {Record<string, { response_format: "pcm" | "mp3", output_format: "pcm16" | "mp3" }>} */
const FREE_SPEECH_MODEL_CONFIG = {
	"hexgrad/kokoro-82m": { response_format: "pcm", output_format: "pcm16" },
	"mistralai/voxtral-mini-tts-2603": {
		response_format: "mp3",
		output_format: "mp3",
	},
};

function openRouterFetchHeaders() {
	const key = process.env.OPENROUTER_API_KEY;
	const h = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${key}`,
	};
	const ref = process.env.OPENROUTER_HTTP_REFERER?.trim();
	if (ref) h.Referer = ref;
	else h.Referer = "https://ihatereading.in";
	const title = process.env.OPENROUTER_APP_TITLE?.trim();
	if (title) h["X-Title"] = title;
	return h;
}

/**
 * Voxtral uses OpenAI-style names; Kokoro uses af_/am_ ids.
 * @param {string} model
 * @param {string} kokoroVoice
 * @param {string} gender
 */
function voiceForFreeSpeechModel(model, kokoroVoice, gender) {
	const m = String(model || "").toLowerCase();
	if (m.includes("voxtral")) {
		return gender === "male" ? "marin" : "alloy";
	}
	return kokoroVoice || (gender === "male" ? "am_adam" : "af_bella");
}

/**
 * @param {{ text: string, model: string, voice: string, gender: string, signal?: AbortSignal }} opts
 */
async function freeSpeechApiAttempt({ text, model, voice, gender, signal }) {
	const cfg = FREE_SPEECH_MODEL_CONFIG[model] ?? {
		response_format: "pcm",
		output_format: "pcm16",
	};
	const resolvedVoice = voiceForFreeSpeechModel(model, voice, gender);
	const res = await fetch(OPENROUTER_AUDIO_SPEECH, {
		method: "POST",
		signal,
		headers: openRouterFetchHeaders(),
		body: JSON.stringify({
			model,
			input: text,
			voice: resolvedVoice,
			response_format: cfg.response_format,
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
			`OpenRouter free TTS (${model}) HTTP ${res.status}: ${String(errText).slice(0, 1500)}`,
		);
	}

	const buf = Buffer.from(await res.arrayBuffer());
	if (!buf.length) {
		throw new Error(`OpenRouter free TTS (${model}) returned empty body`);
	}
	return { buffer: buf, format: cfg.output_format, modelUsed: model };
}

/**
 * Synthesize speech using free OpenRouter models only (Kokoro → Voxtral fallback).
 * @param {{ text: string, voice: string, gender: string, signal?: AbortSignal, models?: string[] }} opts
 */
export async function freeTtsSynthesizeToBuffer(opts) {
	const { text, voice, gender, signal } = opts;
	const chain =
		Array.isArray(opts.models) && opts.models.length
			? opts.models
			: [...FREE_TTS_DEFAULT_MODEL_CHAIN];

	let lastErr = "";
	for (const model of chain) {
		try {
			return await freeSpeechApiAttempt({
				text,
				model,
				voice,
				gender,
				signal,
			});
		} catch (e) {
			lastErr = e?.message || String(e);
		}
	}

	throw new Error(
		`Free TTS failed after models (${chain.join(" → ")}). Last: ${lastErr}`,
	);
}
