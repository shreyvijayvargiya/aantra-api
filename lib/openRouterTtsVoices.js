/**
 * Gemini TTS voices for OpenRouter `POST /audio/speech` (google/gemini-3.1-flash-tts-preview).
 * @see https://ai.google.dev/gemini-api/docs/speech-generation
 */

export const DEFAULT_GEMINI_TTS_VOICE = "Puck";

/** @type {{ id: string, voice: string, label: string, gender: string, style: string }[]} */
export const GEMINI_OPENROUTER_TTS_VOICES = [
	{ id: "gemini-zephyr", voice: "Zephyr", label: "Zephyr", gender: "female", style: "Bright" },
	{ id: "gemini-puck", voice: "Puck", label: "Puck", gender: "male", style: "Upbeat" },
	{ id: "gemini-charon", voice: "Charon", label: "Charon", gender: "male", style: "Informative" },
	{ id: "gemini-kore", voice: "Kore", label: "Kore", gender: "female", style: "Firm" },
	{ id: "gemini-fenrir", voice: "Fenrir", label: "Fenrir", gender: "male", style: "Excitable" },
	{ id: "gemini-leda", voice: "Leda", label: "Leda", gender: "female", style: "Youthful" },
	{ id: "gemini-orus", voice: "Orus", label: "Orus", gender: "male", style: "Firm" },
	{ id: "gemini-aoede", voice: "Aoede", label: "Aoede", gender: "female", style: "Breezy" },
	{
		id: "gemini-callirrhoe",
		voice: "Callirrhoe",
		label: "Callirrhoe",
		gender: "female",
		style: "Easy-going",
	},
	{ id: "gemini-autonoe", voice: "Autonoe", label: "Autonoe", gender: "female", style: "Bright" },
	{
		id: "gemini-enceladus",
		voice: "Enceladus",
		label: "Enceladus",
		gender: "male",
		style: "Breathy",
	},
	{ id: "gemini-iapetus", voice: "Iapetus", label: "Iapetus", gender: "male", style: "Clear" },
	{
		id: "gemini-umbriel",
		voice: "Umbriel",
		label: "Umbriel",
		gender: "male",
		style: "Easy-going",
	},
	{ id: "gemini-algieba", voice: "Algieba", label: "Algieba", gender: "male", style: "Smooth" },
	{ id: "gemini-despina", voice: "Despina", label: "Despina", gender: "female", style: "Smooth" },
	{ id: "gemini-erinome", voice: "Erinome", label: "Erinome", gender: "female", style: "Clear" },
	{ id: "gemini-algenib", voice: "Algenib", label: "Algenib", gender: "male", style: "Gravelly" },
	{
		id: "gemini-rasalgethi",
		voice: "Rasalgethi",
		label: "Rasalgethi",
		gender: "male",
		style: "Informative",
	},
	{
		id: "gemini-laomedeia",
		voice: "Laomedeia",
		label: "Laomedeia",
		gender: "female",
		style: "Upbeat",
	},
	{ id: "gemini-achernar", voice: "Achernar", label: "Achernar", gender: "female", style: "Soft" },
	{ id: "gemini-alnilam", voice: "Alnilam", label: "Alnilam", gender: "male", style: "Firm" },
	{ id: "gemini-schedar", voice: "Schedar", label: "Schedar", gender: "male", style: "Even" },
	{ id: "gemini-gacrux", voice: "Gacrux", label: "Gacrux", gender: "female", style: "Mature" },
	{
		id: "gemini-pulcherrima",
		voice: "Pulcherrima",
		label: "Pulcherrima",
		gender: "female",
		style: "Forward",
	},
	{ id: "gemini-achird", voice: "Achird", label: "Achird", gender: "male", style: "Friendly" },
	{
		id: "gemini-zubenelgenubi",
		voice: "Zubenelgenubi",
		label: "Zubenelgenubi",
		gender: "male",
		style: "Casual",
	},
	{
		id: "gemini-vindemiatrix",
		voice: "Vindemiatrix",
		label: "Vindemiatrix",
		gender: "female",
		style: "Gentle",
	},
	{ id: "gemini-sadachbia", voice: "Sadachbia", label: "Sadachbia", gender: "male", style: "Lively" },
	{
		id: "gemini-sadaltager",
		voice: "Sadaltager",
		label: "Sadaltager",
		gender: "male",
		style: "Knowledgeable",
	},
	{ id: "gemini-sulafat", voice: "Sulafat", label: "Sulafat", gender: "female", style: "Warm" },
];

const byId = new Map(GEMINI_OPENROUTER_TTS_VOICES.map((v) => [v.id, v]));
const byVoiceLower = new Map(
	GEMINI_OPENROUTER_TTS_VOICES.map((v) => [v.voice.toLowerCase(), v]),
);

export function getDefaultOpenRouterTtsVoiceName() {
	return (
		process.env.OPENROUTER_VIDEO_TTS_VOICE?.trim() ||
		process.env.OPENROUTER_TTS_VOICE?.trim() ||
		DEFAULT_GEMINI_TTS_VOICE
	);
}

export function getDefaultOpenRouterTtsVoicePresetId() {
	const envName = getDefaultOpenRouterTtsVoiceName();
	const hit = byVoiceLower.get(envName.toLowerCase());
	return hit?.id ?? "gemini-puck";
}

/**
 * Resolve narrator voice for OpenRouter Gemini TTS.
 * Priority: `tts_voice` > `brand_voice_id` > `voice_id` > env default.
 * @param {{ tts_voice?: string, brand_voice_id?: string, voice_id?: string }} opts
 * @returns {{ ok: true, voice: string, voice_id: string } | { ok: false, error: string, httpStatus: number }}
 */
export function resolveOpenRouterTtsVoice(opts = {}) {
	const rawVoice = opts.tts_voice != null ? String(opts.tts_voice).trim() : "";
	const rawBrand = opts.brand_voice_id != null ? String(opts.brand_voice_id).trim() : "";
	const rawId = opts.voice_id != null ? String(opts.voice_id).trim() : "";

	if (rawBrand) {
		const preset = byId.get(rawBrand.toLowerCase()) ?? byId.get(rawBrand);
		if (preset) {
			return { ok: true, voice: preset.voice, voice_id: preset.id };
		}
		return {
			ok: false,
			error: `Unknown brand_voice_id "${rawBrand}"`,
			httpStatus: 400,
			details: { allowed_voice_ids: GEMINI_OPENROUTER_TTS_VOICES.map((v) => v.id) },
		};
	}

	if (rawId) {
		const preset = byId.get(rawId.toLowerCase()) ?? byId.get(rawId);
		if (preset) {
			return { ok: true, voice: preset.voice, voice_id: preset.id };
		}
		return {
			ok: false,
			error: `Unknown voice_id "${rawId}"`,
			httpStatus: 400,
			details: { allowed_voice_ids: GEMINI_OPENROUTER_TTS_VOICES.map((v) => v.id) },
		};
	}

	if (rawVoice) {
		const byName = byVoiceLower.get(rawVoice.toLowerCase());
		if (byName) {
			return { ok: true, voice: byName.voice, voice_id: byName.id };
		}
		const slug = rawVoice.toLowerCase().replace(/^gemini-/, "");
		const bySlug = byVoiceLower.get(slug);
		if (bySlug) {
			return { ok: true, voice: bySlug.voice, voice_id: bySlug.id };
		}
		const byPresetSlug = byId.get(`gemini-${slug}`);
		if (byPresetSlug) {
			return { ok: true, voice: byPresetSlug.voice, voice_id: byPresetSlug.id };
		}
		// Allow raw Gemini voice name passthrough if it matches known voice casing
		for (const v of GEMINI_OPENROUTER_TTS_VOICES) {
			if (v.voice.toLowerCase() === rawVoice.toLowerCase()) {
				return { ok: true, voice: v.voice, voice_id: v.id };
			}
		}
		return {
			ok: false,
			error: `Unknown tts_voice "${rawVoice}"`,
			httpStatus: 400,
			details: {
				allowed_tts_voices: GEMINI_OPENROUTER_TTS_VOICES.map((v) => v.voice),
				allowed_voice_ids: GEMINI_OPENROUTER_TTS_VOICES.map((v) => v.id),
			},
		};
	}

	const defaultName = getDefaultOpenRouterTtsVoiceName();
	const preset =
		byVoiceLower.get(defaultName.toLowerCase()) ??
		byId.get(getDefaultOpenRouterTtsVoicePresetId());
	return {
		ok: true,
		voice: preset?.voice ?? defaultName,
		voice_id: preset?.id ?? getDefaultOpenRouterTtsVoicePresetId(),
	};
}

/** For gpt-audio fallback models (OpenAI voice names only). */
export function voiceForOpenAiChatTts(geminiVoice) {
	const openAi = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
	const lower = String(geminiVoice || "").toLowerCase();
	if (openAi.has(lower)) return lower;
	return "alloy";
}

export function getOpenRouterTtsVoicesResponse() {
	return {
		error: null,
		data: {
			tts_engine: "openrouter",
			model: "google/gemini-3.1-flash-tts-preview",
			default_voice_id: getDefaultOpenRouterTtsVoicePresetId(),
			default_tts_voice: getDefaultOpenRouterTtsVoiceName(),
			preview_text:
				"Hello! This is a sample of how I will narrate your translated content.",
			voices: GEMINI_OPENROUTER_TTS_VOICES.map((v) => ({
				id: v.id,
				tts_voice: v.voice,
				label: `${v.label} — ${v.style}`,
				gender: v.gender,
				style: v.style,
			})),
		},
	};
}
