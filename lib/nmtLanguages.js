/**
 * Map video translate `output_language` labels (and Whisper ISO-639-1) to NLLB-200 FLORES codes
 * for bulk translation (e.g. Xenova NLLB / Marian-style MT), not for LLM calls.
 */
const TARGET_LABEL_TO_NLLB = new Map(
	Object.entries({
		English: "eng_Latn",
		"English (United States)": "eng_Latn",
		"English (UK)": "eng_Latn",
		"English (India)": "eng_Latn",
		Spanish: "spa_Latn",
		"Spanish (Spain)": "spa_Latn",
		"Spanish (Mexico)": "spa_Latn",
		"Spanish (United States)": "spa_Latn",
		French: "fra_Latn",
		"French (France)": "fra_Latn",
		"French (Canada)": "fra_Latn",
		Italian: "ita_Latn",
		"Italian (Italy)": "ita_Latn",
		German: "deu_Latn",
		"German (Germany)": "deu_Latn",
		"German (Austria)": "deu_Latn",
		Polish: "pol_Latn",
		"Polish (Poland)": "pol_Latn",
		"Portuguese (Brazil)": "por_Latn",
		"Portuguese (Portugal)": "por_Latn",
		Portuguese: "por_Latn",
		Chinese: "zho_Hans",
		Mandarin: "zho_Hans",
		"Chinese (Mandarin, Simplified)": "zho_Hans",
		"Chinese (Cantonese, Traditional)": "yue_Hant",
		"Chinese (Taiwanese Mandarin, Traditional)": "zho_Hant",
		Japanese: "jpn_Jpan",
		"Japanese (Japan)": "jpn_Jpan",
		Korean: "kor_Hang",
		"Korean (Korea)": "kor_Hang",
		Dutch: "nld_Latn",
		"Dutch (Netherlands)": "nld_Latn",
		"Dutch (Belgium)": "nld_Latn",
		Arabic: "arb_Arab",
		"Arabic (Egypt)": "arz_Arab",
		"Arabic (Saudi Arabia)": "arb_Arab",
		"Arabic (United Arab Emirates)": "acw_Arab",
		Hindi: "hin_Deva",
		"Hindi (India)": "hin_Deva",
		Russian: "rus_Cyrl",
		"Russian (Russia)": "rus_Cyrl",
		Turkish: "tur_Latn",
		"Turkish (Türkiye)": "tur_Latn",
		Indonesian: "ind_Latn",
		"Indonesian (Indonesia)": "ind_Latn",
		"Ukrainian (Ukraine)": "ukr_Cyrl",
		Ukrainian: "ukr_Cyrl",
		Greek: "ell_Grek",
		"Greek (Greece)": "ell_Grek",
		Czech: "ces_Latn",
		"Czech (Czechia)": "ces_Latn",
		Croatian: "hrv_Latn",
		"Croatian (Croatia)": "hrv_Latn",
		Slovak: "slk_Latn",
		Romanian: "ron_Latn",
		"Romanian (Romania)": "ron_Latn",
		Bulgarian: "bul_Cyrl",
		Swedish: "swe_Latn",
		"Swedish (Sweden)": "swe_Latn",
		Danish: "dan_Latn",
		"Danish (Denmark)": "dan_Latn",
		Finnish: "fin_Latn",
		"Finnish (Finland)": "fin_Latn",
		Hebrew: "heb_Hebr",
		"Hebrew (Israel)": "heb_Hebr",
		Hungarian: "hun_Latn",
		"Hungarian (Hungary)": "hun_Latn",
		Thai: "tha_Thai",
		"Thai (Thailand)": "tha_Thai",
		Vietnamese: "vie_Latn",
		"Vietnamese (Vietnam)": "vie_Latn",
		Filipino: "tgl_Latn",
		"Filipino (Philippines)": "tgl_Latn",
		Malay: "zsm_Latn",
		"Malay (Malaysia)": "zsm_Latn",
		Tamil: "tam_Taml",
		"Tamil (India)": "tam_Taml",
		Bengali: "ben_Beng",
		"Bengali (India)": "ben_Beng",
		"Bangla (Bangladesh)": "ben_Beng",
		"Norwegian Bokmål (Norway)": "nob_Latn",
		Persian: "pes_Arab",
		"Persian (Iran)": "pes_Arab",
		"Afrikaans (South Africa)": "afr_Latn",
		Catalan: "cat_Latn",
		"Marathi (India)": "mar_Deva",
		"Gujarati (India)": "guj_Gujr",
		"Telugu (India)": "tel_Telu",
		"Kannada (India)": "kan_Knda",
		"Malayalam (India)": "mal_Mlym",
		"Urdu (India)": "urd_Arab",
		"Amharic (Ethiopia)": "amh_Ethi",
		"Armenian (Armenia)": "hye_Armn",
		Welsh: "cym_Latn",
		"Welsh (United Kingdom)": "cym_Latn",
	}).map(([k, v]) => [k.toLowerCase().trim(), v]),
);

const WHISPER_ISO_TO_NLLB_SRC = {
	en: "eng_Latn",
	es: "spa_Latn",
	fr: "fra_Latn",
	de: "deu_Latn",
	it: "ita_Latn",
	pt: "por_Latn",
	ru: "rus_Cyrl",
	uk: "ukr_Cyrl",
	pl: "pol_Latn",
	nl: "nld_Latn",
	tr: "tur_Latn",
	ja: "jpn_Jpan",
	ko: "kor_Hang",
	zh: "zho_Hans",
	ar: "arb_Arab",
	hi: "hin_Deva",
	bn: "ben_Beng",
	ta: "tam_Taml",
	te: "tel_Telu",
	mr: "mar_Deva",
	fa: "pes_Arab",
	vi: "vie_Latn",
	id: "ind_Latn",
	ms: "zsm_Latn",
	th: "tha_Thai",
	cs: "ces_Latn",
	da: "dan_Latn",
	fi: "fin_Latn",
	he: "heb_Hebr",
	hu: "hun_Latn",
	sv: "swe_Latn",
	no: "nob_Latn",
	ro: "ron_Latn",
	el: "ell_Grek",
	bg: "bul_Cyrl",
	hr: "hrv_Latn",
	sk: "slk_Latn",
	sl: "slv_Latn",
};

/**
 * @param {string} label
 * @returns {string | null}
 */
export function targetLanguageLabelToNllb(label) {
	if (!label || typeof label !== "string") return null;
	const t = label.trim();
	if (!t) return null;
	const direct = TARGET_LABEL_TO_NLLB.get(t.toLowerCase());
	if (direct) return direct;
	// Fuzzy: first segment before "("
	const head = t.split("(")[0].trim().toLowerCase();
	for (const [k, v] of TARGET_LABEL_TO_NLLB) {
		if (k === head) return v;
	}
	// Substring: "Spanish" inside "Something Spanish"
	for (const [k, v] of TARGET_LABEL_TO_NLLB) {
		if (t.toLowerCase().includes(k) || k.includes(head)) {
			if (k.length > 3) return v;
		}
	}
	return null;
}

/**
 * @param {string | null | undefined} whisperLang ISO 639-1 from verbose Whisper
 * @returns {string | null}
 */
export function whisperIsoToNllbSource(whisperLang) {
	if (!whisperLang || typeof whisperLang !== "string") return null;
	const k = String(whisperLang).toLowerCase().trim().slice(0, 2);
	return WHISPER_ISO_TO_NLLB_SRC[k] ?? null;
}

/**
 * From ISO-like strings (e.g. "en", "en-US", "es") or empty; does not handle full language names.
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function looseIsoToNllbSource(raw) {
	if (raw == null || raw === "") return null;
	const t = String(raw).trim().toLowerCase();
	const m = /^([a-z]{2})/.exec(t);
	if (!m) return null;
	return whisperIsoToNllbSource(m[1]);
}

/**
 * Optional API hints: `source_nllb` (FLORES) or `transcript_language` / `source_language` (ISO 639-1).
 * @param {Record<string, unknown> | null | undefined} body
 * @returns {string | null}
 */
export function resolveTranscriptSourceNllbFromBody(body) {
	if (!body || typeof body !== "object") return null;
	const n = body.source_nllb;
	if (n != null && String(n).includes("_")) return String(n).trim();
	const iso = body.transcript_language ?? body.source_language;
	if (iso != null && String(iso).trim()) {
		return whisperIsoToNllbSource(String(iso).toLowerCase().slice(0, 2));
	}
	return null;
}
