/**
 * One small LLM call to polish bulk-MT output: names, brands, glossary — not full re-translation.
 */
import { getGroqApiKey } from "./groqVoiceTranslateText.js";

const GROQ_BASE = "https://api.groq.com/openai/v1";
const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";

function groqHeadersJson() {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${getGroqApiKey()}`,
	};
}

function getOpenRouterKey() {
	return process.env.OPENROUTER_API_KEY?.trim() || "";
}

function openRouterFetchHeaders() {
	const key = getOpenRouterKey();
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${key}`,
		Referer: process.env.OPENROUTER_HTTP_REFERER?.trim() || "https://openrouter.ai",
		...(process.env.OPENROUTER_APP_TITLE?.trim()
			? { "X-Title": process.env.OPENROUTER_APP_TITLE.trim() }
			: {}),
	};
}

function parseJsonObjectFromModel_(raw) {
	if (!raw || typeof raw !== "string") {
		throw new SyntaxError("Empty model output");
	}
	let t = raw.trim();
	t = t
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/m, "")
		.trim();
	const start = t.indexOf("{");
	if (start === -1) throw new SyntaxError("No JSON object in model output");
	let depth = 0;
	let end = -1;
	for (let i = start; i < t.length; i++) {
		if (t[i] === "{") depth++;
		else if (t[i] === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) throw new SyntaxError("Unterminated JSON in model output");
	return JSON.parse(t.slice(start, end + 1));
}

/**
 * @param {{ translation: string, targetLanguage: string, model: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ translation: string, usage: import("./openRouterUsage.js") }>}
 */
export async function refineTranslationGlossaryGroq({
	translation,
	targetLanguage,
	model,
	signal,
}) {
	const key = getGroqApiKey();
	if (!key) {
		throw new Error("GROQ_API_KEY required for glossary refinement on Groq jobs");
	}
	const system = `You fix person names, place names, brand names, and technical terms in a machine translation for dubbing. Do not change meaning or rephrase for style. Reply with ONLY JSON: {"translation":"<polished text in ${targetLanguage}>"} — same length and structure as the input where possible.`;
	const user = `Text to polish (already in ${targetLanguage}):\n"""${String(translation).slice(0, 14_000)}"""`;

	const res = await fetch(`${GROQ_BASE}/chat/completions`, {
		method: "POST",
		signal,
		headers: groqHeadersJson(),
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature: 0.1,
			response_format: { type: "json_object" },
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.error) {
		throw new Error(
			String(
				data?.error?.message ||
					data?.error ||
					`Groq glossary refine HTTP ${res.status}`,
			),
		);
	}
	const content = data?.choices?.[0]?.message?.content;
	const raw = typeof content === "string" ? content : "";
	if (!raw) throw new Error("Empty glossary refinement from Groq");
	const parsed = parseJsonObjectFromModel_(raw);
	const out = String(parsed.translation ?? "").trim();
	if (!out) throw new Error("Glossary JSON must include non-empty translation");
	return { translation: out, usage: data.usage };
}

/**
 * @param {{ translation: string, targetLanguage: string, model: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ translation: string, usage: import("./openRouterUsage.js") }>}
 */
export async function refineTranslationGlossaryOpenRouter({
	translation,
	targetLanguage,
	model,
	signal,
}) {
	if (!getOpenRouterKey()) {
		throw new Error("OPENROUTER_API_KEY required for glossary refinement");
	}
	const system = `You fix person names, place names, brand names, and technical terms in a machine translation for dubbing. Do not change meaning or rephrase for style. Reply with ONLY JSON: {"translation":"<polished text in ${targetLanguage}>"} — same length and structure as the input where possible.`;
	const user = `Text to polish (already in ${targetLanguage}):\n"""${String(translation).slice(0, 14_000)}"""`;

	let res = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterFetchHeaders(),
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature: 0.1,
			response_format: { type: "json_object" },
		}),
	});
	let data = await res.json();
	if (!res.ok || data.error) {
		const msg = String(data?.error?.message || data?.error || "");
		if (/response_format|json_object|unsupported/i.test(msg)) {
			res = await fetch(OPENROUTER_CHAT, {
				method: "POST",
				signal,
				headers: openRouterFetchHeaders(),
				body: JSON.stringify({
					model,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					temperature: 0.1,
				}),
			});
			data = await res.json();
		}
	}
	if (!res.ok || data.error) {
		throw new Error(
			data?.error?.message ||
				data?.error ||
				`OpenRouter glossary refine HTTP ${res.status}`,
		);
	}
	const content = data?.choices?.[0]?.message?.content;
	const raw = typeof content === "string" ? content : "";
	if (!raw) throw new Error("Empty glossary refinement from OpenRouter");
	const parsed = parseJsonObjectFromModel_(raw);
	const out = String(parsed.translation ?? "").trim();
	if (!out) throw new Error("Glossary JSON must include non-empty translation");
	return { translation: out, usage: data.usage };
}
