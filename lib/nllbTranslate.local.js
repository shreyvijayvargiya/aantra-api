/**
 * Bulk neural MT via @huggingface/transformers (NLLB / Marian-style ONNX), for cost-sensitive
 * video dubbing: translate full transcript in-process instead of a chat LLM per block.
 *
 * Loaded only when NLLB_MODULE_PATH points at this file (kept out of Vercel serverless traces).
 */
import { env, pipeline } from "@huggingface/transformers";

env.useWebWorkers = false;
env.useBrowserCache = false;
if (!env.cacheDir) {
	env.cacheDir = process.env.TRANSFORMERS_CACHE?.trim() || "/tmp/hf-transformers";
}

const DEFAULT_NLLB_MODEL =
	process.env.NLLB_MODEL?.trim() || "Xenova/nllb-200-distilled-600M";

/** ~220 chars is safe for 512 token budget on NLLB without mid-sentence cuts at scale. */
const NLLB_CHUNK_SOFT_MAX =
	Number.parseInt(process.env.NLLB_TRANSLATE_CHUNK_CHARS || "", 10) || 220;

let _pipe = null;
let _pipeModelId = null;

/**
 * @param {string} modelId
 * @returns {Promise<import("@huggingface/transformers").TextTranslationPipeline>}
 */
async function getTranslationPipeline(modelId) {
	if (_pipe && _pipeModelId === modelId) return _pipe;
	_pipeModelId = modelId;
	_pipe = await pipeline("translation", modelId);
	return _pipe;
}

function splitForTranslation(text) {
	const t = String(text || "").replace(/\r\n/g, "\n").trim();
	if (!t) return [];
	if (t.length <= NLLB_CHUNK_SOFT_MAX) return [t];
	const out = [];
	let rest = t;
	while (rest.length) {
		if (rest.length <= NLLB_CHUNK_SOFT_MAX) {
			out.push(rest.trim());
			break;
		}
		const slice = rest.slice(0, NLLB_CHUNK_SOFT_MAX);
		let breakAt = Math.max(
			slice.lastIndexOf(". "),
			slice.lastIndexOf("! "),
			slice.lastIndexOf("? "),
			slice.lastIndexOf("\n"),
		);
		if (breakAt < NLLB_CHUNK_SOFT_MAX * 0.35) {
			breakAt = slice.lastIndexOf(" ");
		}
		if (breakAt < 8) breakAt = NLLB_CHUNK_SOFT_MAX;
		const chunk = rest.slice(0, breakAt + 1).trim();
		rest = rest.slice(breakAt + 1).trim();
		if (chunk) out.push(chunk);
	}
	return out.filter(Boolean);
}

/**
 * @param {{ text: string, srcLang: string, tgtLang: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ translation: string, model: string, chunks: number }>}
 */
export async function translateTextWithNllb({ text, srcLang, tgtLang, signal }) {
	if (signal?.aborted) {
		const e = new Error("NLLB translate aborted");
		e.name = "AbortError";
		throw e;
	}
	const model = DEFAULT_NLLB_MODEL;
	const pipe = await getTranslationPipeline(model);
	const parts = splitForTranslation(text);
	const translatedParts = [];
	for (const p of parts) {
		if (signal?.aborted) {
			const e = new Error("NLLB translate aborted");
			e.name = "AbortError";
			throw e;
		}
		/** @type {unknown} */
		const out = await pipe(p, { src_lang: srcLang, tgt_lang: tgtLang });
		let t = "";
		if (Array.isArray(out) && out[0] && out[0].translation_text) {
			t = String(out[0].translation_text);
		} else if (out && typeof out === "object" && "translation_text" in out) {
			t = String(/** @type {{ translation_text?: string }} */ (out).translation_text);
		} else {
			t = String(out ?? "");
		}
		translatedParts.push(t.trim());
	}
	return {
		translation: translatedParts.join(" ").replace(/\s+/g, " ").trim(),
		model,
		chunks: parts.length,
	};
}
