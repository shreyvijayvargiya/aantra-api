/**
 * OpenRouter model presets for voice/video translation POST bodies.
 * Default when `model` is omitted: Gemini (google/gemini-2.5-flash).
 */

/** @type {Record<string, string>} canonical preset key → OpenRouter model id */
export const TRANSLATE_LLM_PRESETS = {
	gemini: "google/gemini-2.5-flash",
	"gpt-4o-mini": "openai/gpt-4o-mini",
	sonnet: "anthropic/claude-3.5-sonnet",
	kimi: "moonshotai/kimi-k2-0905",
	grok: "x-ai/grok-2-1212",
};

/** Preset keys accepted in API (case-insensitive; aliases map here). */
const ALIAS_TO_CANONICAL = {
	gemini: "gemini",
	"gpt-4o-mini": "gpt-4o-mini",
	gpt_4o_mini: "gpt-4o-mini",
	gpt4omini: "gpt-4o-mini",
	gpt_o_mini: "gpt-4o-mini",
	"gpt o mini": "gpt-4o-mini",
	"gpt-4o mini": "gpt-4o-mini",
	openai_gpt_4o_mini: "gpt-4o-mini",
	sonnet: "sonnet",
	claude: "sonnet",
	"claude-sonnet": "sonnet",
	"claude-3.5-sonnet": "sonnet",
	kimi: "kimi",
	moonshot: "kimi",
	grok: "grok",
	"grok-2": "grok",
};

/**
 * @param {unknown} raw - `model` or `llm_model` from POST body; omit/null → default Gemini
 * @returns {{ ok: true, openrouterId: string, preset: string } | { ok: false, error: string, allowed: string[] }}
 */
export function resolveTranslateLlmModel(raw) {
	if (raw == null || String(raw).trim() === "") {
		return {
			ok: true,
			openrouterId: TRANSLATE_LLM_PRESETS.gemini,
			preset: "gemini",
		};
	}

	const s = String(raw).trim();
	const lower = s.toLowerCase();
	const directKey = Object.keys(TRANSLATE_LLM_PRESETS).find(
		(k) => k.toLowerCase() === lower,
	);
	if (directKey) {
		return {
			ok: true,
			openrouterId: TRANSLATE_LLM_PRESETS[directKey],
			preset: directKey,
		};
	}
	const canonical =
		ALIAS_TO_CANONICAL[lower] ??
		(ALIAS_TO_CANONICAL[s.replace(/\s+/g, " ").toLowerCase()] ?? null);

	if (canonical && TRANSLATE_LLM_PRESETS[canonical]) {
		return {
			ok: true,
			openrouterId: TRANSLATE_LLM_PRESETS[canonical],
			preset: canonical,
		};
	}

	return {
		ok: false,
		error: `Unknown model preset: ${JSON.stringify(s)}`,
		allowed: Object.keys(TRANSLATE_LLM_PRESETS),
	};
}
