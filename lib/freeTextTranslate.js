/**
 * Free text translation for /api/audio-to-text — NLLB (local) then free OpenRouter LLM chain.
 */
import { translateTextWithNllb } from "./nllbTranslate.js";
import {
	looseIsoToNllbSource,
	resolveTranscriptSourceNllbFromBody,
	targetLanguageLabelToNllb,
} from "./nmtLanguages.js";
import { resolveCaptionLanguage } from "./captionLanguages.js";
import { resolveFreeTranslateModelChain } from "./freeTranslateModels.js";
import { openRouterErrorFromUnknown } from "./openRouterErrors.js";

const OPENROUTER_CHAT =
	process.env.OPENROUTER_API_BASE?.trim()
		? `${process.env.OPENROUTER_API_BASE.trim()}/chat/completions`
		: "https://openrouter.ai/api/v1/chat/completions";

function openRouterHeaders() {
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

function isEnglishLabel(label) {
	return /^english(\b|\s|\(|$)/i.test(String(label || "").trim());
}

/**
 * @param {string} text
 * @param {string} targetLabel
 * @param {string} scriptHint
 * @param {string[]} modelChain
 * @param {AbortSignal} signal
 */
async function translateWithFreeOpenRouterLlm(
	text,
	targetLabel,
	scriptHint,
	modelChain,
	signal,
) {
	const scriptLine = scriptHint ? ` ${scriptHint}` : "";
	const system = `You translate prose for voice narration. Reply with ONLY a JSON object: {"transcript":"<full translation in ${targetLabel}>"}. Natural spoken delivery.${scriptLine}`;
	const user = `Translate into ${targetLabel}:\n"""${text}"""`;

	let lastErr = "";
	for (const model of modelChain) {
		try {
			const res = await fetch(OPENROUTER_CHAT, {
				method: "POST",
				signal,
				headers: openRouterHeaders(),
				body: JSON.stringify({
					model,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					temperature: 0.2,
				}),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				lastErr =
					data?.error?.message ||
					data?.error ||
					`OpenRouter HTTP ${res.status}`;
				continue;
			}
			const raw = data?.choices?.[0]?.message?.content;
			if (!raw) {
				lastErr = "Empty model output";
				continue;
			}
			let parsed;
			try {
				const t = String(raw)
					.trim()
					.replace(/^```(?:json)?\s*/i, "")
					.replace(/\s*```$/m, "")
					.trim();
				parsed = JSON.parse(t);
			} catch {
				lastErr = "Invalid JSON from translation model";
				continue;
			}
			const tr = String(parsed?.transcript ?? "").trim();
			if (!tr) {
				lastErr = "Missing transcript in model output";
				continue;
			}
			return { translation: tr, model };
		} catch (e) {
			lastErr = e?.message || String(e);
		}
	}
	throw openRouterErrorFromUnknown(new Error(lastErr || "Free translation failed"));
}

/**
 * @param {{
 *   text: string,
 *   language?: string,
 *   output_language?: string,
 *   source_language?: string,
 *   source_nllb?: string,
 *   transcript_language?: string,
 *   translate_model?: string,
 *   signal?: AbortSignal,
 * }} opts
 */
export async function translateTextForFreeTts(opts) {
	const rawLang =
		opts.language ??
		opts.output_language ??
		"";
	const resolved = resolveCaptionLanguage(rawLang);
	const targetLabel = resolved.label;
	const tgtNllb = resolved.nllb;

	if (!rawLang || isEnglishLabel(targetLabel)) {
		return {
			text: opts.text,
			language: targetLabel || "English",
			translated: false,
			translation_engine: null,
		};
	}

	const signal = opts.signal ?? AbortSignal.timeout(60_000);
	const bodyLike = {
		source_nllb: opts.source_nllb,
		transcript_language: opts.transcript_language ?? opts.source_language,
		source_language: opts.source_language,
	};
	const srcNllb =
		resolveTranscriptSourceNllbFromBody(bodyLike) ||
		looseIsoToNllbSource(opts.source_language) ||
		"eng_Latn";

	if (tgtNllb && process.env.NLLB_MODULE_PATH?.trim()) {
		try {
			const out = await translateTextWithNllb({
				text: opts.text,
				srcLang: srcNllb,
				tgtLang: tgtNllb,
				signal,
			});
			return {
				text: out.translation,
				language: targetLabel,
				translated: true,
				translation_engine: "nllb",
				translation_model: out.model,
			};
		} catch {
			/* fall through to free OpenRouter LLMs */
		}
	}

	const chainRes = resolveFreeTranslateModelChain(opts.translate_model);
	if (!chainRes.ok) {
		throw new Error(chainRes.error);
	}

	const llm = await translateWithFreeOpenRouterLlm(
		opts.text,
		targetLabel,
		resolved.scriptHint,
		chainRes.chain,
		signal,
	);
	return {
		text: llm.translation,
		language: targetLabel,
		translated: true,
		translation_engine: "openrouter-free",
		translation_model: llm.model,
	};
}
