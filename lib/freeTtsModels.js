/**
 * TTS model presets for the free POST /api/audio-to-text endpoint.
 * No paid Gemini TTS — Piper (local, $0) or low-cost Kokoro / Voxtral on OpenRouter.
 */
import { isPiperConfigured } from "./piperTts.js";

/** @type {Record<string, string>} preset key → OpenRouter model id (piper is local, not listed here) */
export const FREE_TTS_MODEL_PRESETS = {
	kokoro: "hexgrad/kokoro-82m",
	voxtral: "mistralai/voxtral-mini-tts-2603",
};

/** OpenRouter fallback order when `tts_model` is omitted (cheapest first; no Gemini). */
export const FREE_TTS_DEFAULT_MODEL_CHAIN = [
	FREE_TTS_MODEL_PRESETS.kokoro,
	FREE_TTS_MODEL_PRESETS.voxtral,
];

const ALIAS_TO_CANONICAL = {
	kokoro: "kokoro",
	"hexgrad/kokoro-82m": "kokoro",
	voxtral: "voxtral",
	"voxtral-mini": "voxtral",
	piper: "piper",
	local: "piper",
};

/**
 * Default engine: Piper when installed (truly free), else OpenRouter Kokoro.
 * @returns {"piper" | "openrouter"}
 */
export function getDefaultFreeTtsEngine() {
	const env = process.env.FREE_TTS_DEFAULT_ENGINE?.trim().toLowerCase();
	if (env === "piper" || env === "openrouter") return env;
	if (isPiperConfigured()) return "piper";
	return "openrouter";
}

/**
 * @param {unknown} raw - `tts_model` from POST body; omit → default chain
 * @returns {{ ok: true, chain: string[], preset: string | null, engine: "piper" | "openrouter" } | { ok: false, error: string, allowed: string[] }}
 */
export function resolveFreeTtsModelChain(raw) {
	const s = raw == null ? "" : String(raw).trim();
	const lower = s.toLowerCase();

	if (!s) {
		return {
			ok: true,
			chain: [...FREE_TTS_DEFAULT_MODEL_CHAIN],
			preset: null,
			engine: getDefaultFreeTtsEngine(),
		};
	}

	if (lower === "piper" || lower === "local") {
		return { ok: true, chain: [], preset: "piper", engine: "piper" };
	}

	const directKey = Object.keys(FREE_TTS_MODEL_PRESETS).find(
		(k) => k.toLowerCase() === lower,
	);
	const canonical =
		directKey ??
		ALIAS_TO_CANONICAL[lower] ??
		ALIAS_TO_CANONICAL[s.replace(/\s+/g, " ").toLowerCase()] ??
		null;

	if (canonical === "piper") {
		return { ok: true, chain: [], preset: "piper", engine: "piper" };
	}

	if (canonical && FREE_TTS_MODEL_PRESETS[canonical]) {
		const primary = FREE_TTS_MODEL_PRESETS[canonical];
		const chain = [primary];
		for (const m of FREE_TTS_DEFAULT_MODEL_CHAIN) {
			if (!chain.includes(m)) chain.push(m);
		}
		return { ok: true, chain, preset: canonical, engine: "openrouter" };
	}

	if (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(s)) {
		const chain = [s];
		for (const m of FREE_TTS_DEFAULT_MODEL_CHAIN) {
			if (!chain.includes(m)) chain.push(m);
		}
		return { ok: true, chain, preset: s, engine: "openrouter" };
	}

	return {
		ok: false,
		error: `Unknown tts_model preset: ${JSON.stringify(s)}`,
		allowed: ["piper", ...Object.keys(FREE_TTS_MODEL_PRESETS)],
	};
}

export function getFreeTtsModelsCatalog() {
	const defaultEngine = getDefaultFreeTtsEngine();
	return {
		default_preset: defaultEngine === "piper" ? "piper" : "kokoro",
		default_engine: defaultEngine,
		default_chain: [...FREE_TTS_DEFAULT_MODEL_CHAIN],
		models: [
			{
				id: "piper",
				openrouter_id: null,
				label: "Piper (local, free)",
				cost: "free",
			},
			...Object.entries(FREE_TTS_MODEL_PRESETS).map(([id, openrouter_id]) => ({
				id,
				openrouter_id,
				label: id === "kokoro" ? "Kokoro 82M" : "Voxtral Mini TTS",
				cost: "low",
			})),
		],
	};
}
