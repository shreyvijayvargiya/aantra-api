/**
 * Free OpenRouter LLM presets for translating text before free TTS.
 * Used when NLLB is unavailable and `language` / `output_language` is set.
 */

/** @type {string[]} OpenRouter models with :free or zero prompt pricing — tried in order. */
export const FREE_TRANSLATE_LLM_CHAIN = [
	"google/gemma-4-26b-a4b-it:free",
	"meta-llama/llama-3.3-70b-instruct:free",
	"qwen/qwen3-next-80b-a3b-instruct:free",
	"openai/gpt-oss-20b:free",
	"nvidia/nemotron-3-nano-30b-a3b:free",
];

/** @type {Record<string, string>} optional preset key → model id */
export const FREE_TRANSLATE_LLM_PRESETS = {
	gemma: "google/gemma-4-26b-a4b-it:free",
	llama: "meta-llama/llama-3.3-70b-instruct:free",
	qwen: "qwen/qwen3-next-80b-a3b-instruct:free",
};

/**
 * @param {unknown} raw - optional `translate_model` body field
 * @returns {{ ok: true, chain: string[], preset: string | null } | { ok: false, error: string, allowed: string[] }}
 */
export function resolveFreeTranslateModelChain(raw) {
	if (raw == null || String(raw).trim() === "") {
		return { ok: true, chain: [...FREE_TRANSLATE_LLM_CHAIN], preset: null };
	}
	const s = String(raw).trim();
	const lower = s.toLowerCase();
	const presetKey = Object.keys(FREE_TRANSLATE_LLM_PRESETS).find(
		(k) => k.toLowerCase() === lower,
	);
	if (presetKey) {
		const primary = FREE_TRANSLATE_LLM_PRESETS[presetKey];
		const chain = [primary];
		for (const m of FREE_TRANSLATE_LLM_CHAIN) {
			if (!chain.includes(m)) chain.push(m);
		}
		return { ok: true, chain, preset: presetKey };
	}
	if (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(s)) {
		const chain = [s];
		for (const m of FREE_TRANSLATE_LLM_CHAIN) {
			if (!chain.includes(m)) chain.push(m);
		}
		return { ok: true, chain, preset: s };
	}
	return {
		ok: false,
		error: `Unknown translate_model preset: ${JSON.stringify(s)}`,
		allowed: Object.keys(FREE_TRANSLATE_LLM_PRESETS),
	};
}
