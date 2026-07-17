/**
 * Local NLLB loads heavy ONNX/Hugging Face deps from disk only when NLLB_MODULE_PATH is set.
 * Vercel traces cannot follow a runtime file URL, so translation_engine "nllb" is unavailable
 * there unless you attach a layer or separate service — use "llm" (default) on serverless.
 *
 * Self‑hosted / local: set NLLB_MODULE_PATH=./lib/nllbTranslate.local.js (or absolute path),
 * e.g. in `.env`, or your process manager / Docker ENV.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

function resolveNllbModuleUrl() {
	const raw = process.env.NLLB_MODULE_PATH?.trim();
	if (!raw) return "";
	const abs = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
	return pathToFileURL(abs).href;
}

/** True when local NLLB module path is set (model may still fail to load on first run). */
export function isNllbModuleConfigured() {
	return Boolean(process.env.NLLB_MODULE_PATH?.trim());
}

/** @type {boolean | null} */
let nllbRuntimeReady = null;
/** @type {string | null} */
let nllbRuntimeError = null;

/**
 * Load NLLB ONNX weights once; cache success/failure for the process lifetime.
 * @returns {Promise<boolean>}
 */
export async function isNllbRuntimeReady() {
	if (!isNllbModuleConfigured()) return false;
	if (nllbRuntimeReady != null) return nllbRuntimeReady;
	try {
		const href = resolveNllbModuleUrl();
		const mod = await import(href);
		if (typeof mod.probeNllbPipeline === "function") {
			await mod.probeNllbPipeline();
		} else {
			await mod.translateTextWithNllb({
				text: "ok",
				srcLang: "eng_Latn",
				tgtLang: "hin_Deva",
			});
		}
		nllbRuntimeReady = true;
		nllbRuntimeError = null;
		console.log("[nllb] Local translation model loaded and ready");
		return true;
	} catch (e) {
		nllbRuntimeReady = false;
		nllbRuntimeError = e?.message || String(e);
		console.warn(
			`[nllb] Model failed to load (${nllbRuntimeError}). ` +
				"Translation will use LLM. To fix: ensure network access to Hugging Face, " +
				"set TRANSFORMERS_CACHE to a persistent directory, or pass translation_engine: llm.",
		);
		return false;
	}
}

export function getNllbRuntimeError() {
	return nllbRuntimeError;
}

/**
 * @param {{ text: string, srcLang: string, tgtLang: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ translation: string, model: string, chunks: number }>}
 */
export async function translateTextWithNllb(opts) {
	const href = resolveNllbModuleUrl();
	if (!href) {
		const e = new Error(
			"Local NLLB is not configured. Set NLLB_MODULE_PATH to lib/nllbTranslate.local.js (relative to cwd or absolute), or use translation_engine llm instead of nllb.",
		);
		e.code = "NLLB_NOT_CONFIGURED";
		throw e;
	}
	const mod = await import(href);
	return mod.translateTextWithNllb(opts);
}
