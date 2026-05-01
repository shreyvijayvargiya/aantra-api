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
