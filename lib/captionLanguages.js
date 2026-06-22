import { targetLanguageLabelToNllb } from "./nmtLanguages.js";
import { VIDEO_TRANSLATE_TARGET_LANGUAGES } from "./videoTranslateLanguages.js";

/** ISO 639-1 → display label for caption prompts. */
const ISO_TO_LABEL = {
	en: "English",
	es: "Spanish",
	fr: "French",
	de: "German",
	it: "Italian",
	pt: "Portuguese",
	hi: "Hindi",
	zh: "Chinese",
	ja: "Japanese",
	ko: "Korean",
	ar: "Arabic",
	ru: "Russian",
	nl: "Dutch",
	tr: "Turkish",
	pl: "Polish",
	bn: "Bengali",
	ta: "Tamil",
	te: "Telugu",
	mr: "Marathi",
	vi: "Vietnamese",
	id: "Indonesian",
	ms: "Malay",
	th: "Thai",
	fa: "Persian",
	he: "Hebrew",
	uk: "Ukrainian",
	el: "Greek",
	cs: "Czech",
	da: "Danish",
	fi: "Finnish",
	sv: "Swedish",
	no: "Norwegian",
	ro: "Romanian",
	hu: "Hungarian",
	bg: "Bulgarian",
	hr: "Croatian",
	sk: "Slovak",
	gu: "Gujarati",
	kn: "Kannada",
	ml: "Malayalam",
	ur: "Urdu",
};

/** libass Fontname hints by NLLB script suffix (Noto on Linux, system fonts on macOS). */
const SCRIPT_FONT = {
	_Deva: "Devanagari MT",
	_Beng: "Arial Unicode MS",
	_Arab: "Arial Unicode MS",
	_Hans: "Arial Unicode MS",
	_Hant: "Arial Unicode MS",
	_Hang: "Arial Unicode MS",
	_Jpan: "Arial Unicode MS",
	_Taml: "Noto Sans Tamil",
	_Telu: "Noto Sans Telugu",
	_Gujr: "Noto Sans Gujarati",
	_Mlym: "Noto Sans Malayalam",
	_Knda: "Noto Sans Kannada",
	_Thai: "Noto Sans Thai",
	_Hebr: "Arial Unicode MS",
	_Ethi: "Arial Unicode MS",
	_Armn: "Arial Unicode MS",
	_Grek: "Arial Unicode MS",
	_Cyrl: "Arial Unicode MS",
	_Latn: "Arial Unicode MS",
};

const SCRIPT_INSTRUCTION = {
	_Deva: "Use Devanagari script.",
	_Beng: "Use Bengali script.",
	_Arab: "Use Arabic script.",
	_Hans: "Use Simplified Chinese characters.",
	_Hant: "Use Traditional Chinese characters.",
	_Hang: "Use Korean (Hangul).",
	_Jpan: "Use Japanese (kanji/kana as appropriate).",
	_Taml: "Use Tamil script.",
	_Telu: "Use Telugu script.",
	_Gujr: "Use Gujarati script.",
	_Mlym: "Use Malayalam script.",
	_Knda: "Use Kannada script.",
	_Thai: "Use Thai script.",
	_Hebr: "Use Hebrew script.",
	_Ethi: "Use Ethiopic script.",
};

function pickLanguageField(body) {
	if (!body || typeof body !== "object") return "";
	return (
		body.language ??
		body.caption_language ??
		body.output_language ??
		body.captionLanguage ??
		body.outputLanguage ??
		""
	);
}

function matchVideoTranslateLabel(raw) {
	const t = String(raw || "").trim();
	if (!t) return null;
	const lower = t.toLowerCase();
	for (const label of VIDEO_TRANSLATE_TARGET_LANGUAGES) {
		if (label.toLowerCase() === lower) return label;
	}
	const head = lower.split("(")[0].trim();
	for (const label of VIDEO_TRANSLATE_TARGET_LANGUAGES) {
		if (label.toLowerCase().split("(")[0].trim() === head) return label;
	}
	return null;
}

/**
 * @param {string} raw language field from API (ISO, label, or "Hindi (India)")
 * @returns {{ label: string, nllb: string | null, iso: string | null, scriptHint: string }}
 */
export function resolveCaptionLanguage(raw) {
	const input = String(raw || "").trim();
	let label = input;

	if (!label) {
		label = "English";
	} else if (/^[a-z]{2}(-[a-z]{2})?$/i.test(label)) {
		const iso = label.toLowerCase().slice(0, 2);
		label = ISO_TO_LABEL[iso] || label;
	} else {
		const matched = matchVideoTranslateLabel(label);
		if (matched) label = matched;
	}

	const nllb = targetLanguageLabelToNllb(label);

	let scriptHint = "";
	if (nllb) {
		for (const [suffix, hint] of Object.entries(SCRIPT_INSTRUCTION)) {
			if (nllb.endsWith(suffix)) {
				scriptHint = hint;
				break;
			}
		}
	}

	return { label, nllb, scriptHint, raw: input || null };
}

export function resolveCaptionLanguageFromBody(body) {
	return resolveCaptionLanguage(pickLanguageField(body));
}

/** `target` = captions in requested language (translate if needed). `transcribe` = same language as speech. */
export function normalizeCaptionMode(body) {
	const raw = String(
		body?.caption_mode ?? body?.captionMode ?? body?.mode ?? "target",
	)
		.trim()
		.toLowerCase();
	if (raw === "transcribe" || raw === "source" || raw === "original") {
		return "transcribe";
	}
	return "target";
}

export function normalizeCaptionStyle(body) {
	const raw = String(
		body?.caption_style ?? body?.style ?? body?.caption_position ?? "bottom",
	)
		.trim()
		.toLowerCase();
	if (raw === "top" || raw === "upper") return "top";
	return "bottom";
}

export function captionFontForLanguage(nllbCode) {
	if (!nllbCode) return "Arial Unicode MS";
	for (const [suffix, font] of Object.entries(SCRIPT_FONT)) {
		if (nllbCode.endsWith(suffix)) return font;
	}
	return "Arial Unicode MS";
}

export function captionFontSizeForVideo(heightPx) {
	const h = Number(heightPx) || 640;
	if (h <= 480) return 20;
	if (h <= 720) return 22;
	return 24;
}
