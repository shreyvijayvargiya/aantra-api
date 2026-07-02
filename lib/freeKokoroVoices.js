/**
 * Kokoro TTS voices for the free /api/audio-to-text endpoint (hexgrad/kokoro-82m on OpenRouter).
 * @see https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
 */

/** @type {{ id: string, voice: string, label: string, gender: string, style: string, lang: string }[]} */
export const FREE_KOKORO_TTS_VOICES = [
	{ id: "kokoro-af-bella", voice: "af_bella", label: "Bella", gender: "female", style: "Warm", lang: "en" },
	{ id: "kokoro-af-sarah", voice: "af_sarah", label: "Sarah", gender: "female", style: "Professional", lang: "en" },
	{ id: "kokoro-af-sky", voice: "af_sky", label: "Sky", gender: "female", style: "Bright", lang: "en" },
	{ id: "kokoro-af-heart", voice: "af_heart", label: "Heart", gender: "female", style: "Neutral", lang: "en" },
	{ id: "kokoro-am-adam", voice: "am_adam", label: "Adam", gender: "male", style: "Friendly", lang: "en" },
	{ id: "kokoro-am-michael", voice: "am_michael", label: "Michael", gender: "male", style: "Deep", lang: "en" },
	{ id: "kokoro-bf-emma", voice: "bf_emma", label: "Emma", gender: "female", style: "British", lang: "en" },
	{ id: "kokoro-bm-george", voice: "bm_george", label: "George", gender: "male", style: "British", lang: "en" },
	{ id: "kokoro-ef-dora", voice: "ef_dora", label: "Dora", gender: "female", style: "Spanish", lang: "es" },
	{ id: "kokoro-em-alex", voice: "em_alex", label: "Alex", gender: "male", style: "Spanish", lang: "es" },
	{ id: "kokoro-ff-siwis", voice: "ff_siwis", label: "Siwis", gender: "female", style: "French", lang: "fr" },
	{ id: "kokoro-hf-alpha", voice: "hf_alpha", label: "Alpha", gender: "female", style: "Hindi", lang: "hi" },
	{ id: "kokoro-hm-omega", voice: "hm_omega", label: "Omega", gender: "male", style: "Hindi", lang: "hi" },
	{ id: "kokoro-if-sara", voice: "if_sara", label: "Sara", gender: "female", style: "Italian", lang: "it" },
	{ id: "kokoro-im-nicola", voice: "im_nicola", label: "Nicola", gender: "male", style: "Italian", lang: "it" },
	{ id: "kokoro-jf-alpha", voice: "jf_alpha", label: "Alpha", gender: "female", style: "Japanese", lang: "ja" },
	{ id: "kokoro-jm-kumo", voice: "jm_kumo", label: "Kumo", gender: "male", style: "Japanese", lang: "ja" },
	{ id: "kokoro-pf-dora", voice: "pf_dora", label: "Dora", gender: "female", style: "Portuguese", lang: "pt" },
	{ id: "kokoro-pm-alex", voice: "pm_alex", label: "Alex", gender: "male", style: "Portuguese", lang: "pt" },
	{ id: "kokoro-zf-xiaobei", voice: "zf_xiaobei", label: "Xiaobei", gender: "female", style: "Mandarin", lang: "zh" },
	{ id: "kokoro-zm-yunjian", voice: "zm_yunjian", label: "Yunjian", gender: "male", style: "Mandarin", lang: "zh" },
];

/** Legacy display names → Kokoro voice (no paid-provider voices). */
const LEGACY_VOICE_ALIASES = {
	puck: "am_adam",
	charon: "am_michael",
	fenrir: "am_adam",
	kore: "af_bella",
	zephyr: "af_sky",
	leda: "af_sarah",
	aoede: "af_heart",
};

const byId = new Map(FREE_KOKORO_TTS_VOICES.map((v) => [v.id, v]));
const byVoiceLower = new Map(
	FREE_KOKORO_TTS_VOICES.map((v) => [v.voice.toLowerCase(), v]),
);

const LABEL_LANG_PREFIX = [
	[/spanish/i, "e"],
	[/french/i, "f"],
	[/hindi/i, "h"],
	[/italian/i, "i"],
	[/japanese/i, "j"],
	[/portuguese/i, "p"],
	[/chinese|mandarin|cantonese/i, "z"],
];

function langPrefixForLabel(languageLabel) {
	const t = String(languageLabel || "").trim();
	for (const [re, prefix] of LABEL_LANG_PREFIX) {
		if (re.test(t)) return prefix;
	}
	return "a";
}

function langPrefixForVoice(voiceEntry) {
	if (!voiceEntry?.voice) return "a";
	return voiceEntry.voice.charAt(0);
}

function defaultVoiceForGender(gender, langPrefix) {
	const g = gender === "male" ? "m" : "f";
	const hit = FREE_KOKORO_TTS_VOICES.find(
		(v) => v.voice.startsWith(`${langPrefix}${g}_`),
	);
	return hit ?? (gender === "male" ? byId.get("kokoro-am-adam") : byId.get("kokoro-af-bella"));
}

/** Pick a voice that matches the target language when possible. */
function alignVoiceWithLanguage(voiceEntry, languageLabel) {
	const targetPrefix = langPrefixForLabel(languageLabel);
	const voicePrefix = langPrefixForVoice(voiceEntry);
	if (voicePrefix === targetPrefix) return voiceEntry;
	return defaultVoiceForGender(voiceEntry.gender, targetPrefix);
}

function lookupVoiceRaw(raw) {
	if (!raw) return null;
	const lower = raw.toLowerCase();
	const alias = LEGACY_VOICE_ALIASES[lower];
	if (alias) return byVoiceLower.get(alias);
	const byName = byVoiceLower.get(lower);
	if (byName) return byName;
	const slug = lower.replace(/^kokoro-/, "").replace(/-/g, "_");
	const bySlug = byVoiceLower.get(slug);
	if (bySlug) return bySlug;
	const byPreset = byId.get(raw) ?? byId.get(`kokoro-${slug.replace(/_/g, "-")}`);
	if (byPreset) return byPreset;
	return null;
}

/**
 * Resolve Kokoro voice for free TTS.
 * Priority: voice_id > tts_voice > brand_voice_id.
 * @param {{ tts_voice?: string, voice_id?: string, brand_voice_id?: string, language_label?: string }} opts
 */
export function resolveFreeKokoroVoice(opts = {}) {
	const rawId = opts.voice_id != null ? String(opts.voice_id).trim() : "";
	const rawVoice = opts.tts_voice != null ? String(opts.tts_voice).trim() : "";
	const rawBrand = opts.brand_voice_id != null ? String(opts.brand_voice_id).trim() : "";
	const languageLabel = opts.language_label || "English";

	let hit = null;
	for (const raw of [rawId, rawVoice, rawBrand]) {
		hit = lookupVoiceRaw(raw);
		if (hit) break;
	}

	if (!hit) {
		hit = defaultVoiceForGender("female", langPrefixForLabel(languageLabel));
	}

	const aligned = alignVoiceWithLanguage(hit, languageLabel);

	return {
		ok: true,
		voice: aligned.voice,
		voice_id: aligned.id,
		gender: aligned.gender,
		lang: aligned.lang,
	};
}

export function getFreeKokoroVoicesResponse() {
	const voices = FREE_KOKORO_TTS_VOICES.map((v) => ({
		id: v.id,
		tts_voice: v.voice,
		label: `${v.label} — ${v.style}`,
		gender: v.gender,
		style: v.style,
		lang: v.lang,
	}));
	return {
		voices,
		voices_by_gender: {
			male: voices.filter((v) => v.gender === "male"),
			female: voices.filter((v) => v.gender === "female"),
		},
		default_voice_id: "kokoro-af-bella",
		default_tts_voice: "af_bella",
	};
}
