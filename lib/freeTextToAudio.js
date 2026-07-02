/**
 * Free tier text → speech (POST /api/audio-to-text).
 * Piper (local, $0) or Kokoro/Voxtral on OpenRouter — no Gemini TTS.
 */
import { pcm16ToWavBuffer } from "./videoTranslateOpenRouter.js";
import { piperSynthesizeWav, isPiperConfigured } from "./piperTts.js";
import {
	getDefaultFreeTtsEngine,
	resolveFreeTtsModelChain,
} from "./freeTtsModels.js";
import { resolveFreeKokoroVoice } from "./freeKokoroVoices.js";
import { freeTtsSynthesizeToBuffer } from "./freeOpenRouterTts.js";
import { translateTextForFreeTts } from "./freeTextTranslate.js";
import { openRouterErrorFromUnknown } from "./openRouterErrors.js";
import { resolveCaptionLanguage } from "./captionLanguages.js";
import { VIDEO_TRANSLATE_TARGET_LANGUAGES } from "./videoTranslateLanguages.js";

const FREE_TTS_TIMEOUT_MS =
	Number.parseInt(process.env.FREE_TTS_TIMEOUT_MS || "", 10) || 90_000;

const MAX_TEXT_CHARS =
	Number.parseInt(process.env.FREE_TTS_MAX_TEXT_CHARS || "", 10) || 5_000;

function normalizeTtsEngine(raw) {
	const s = String(raw || "").trim().toLowerCase();
	if (s === "piper" || s === "local") return "piper";
	if (s === "openrouter" || s === "kokoro" || s === "cloud") return "openrouter";
	if (!s || s === "auto") return getDefaultFreeTtsEngine();
	return getDefaultFreeTtsEngine();
}

function validateLanguage(raw) {
	if (raw == null || String(raw).trim() === "") return { ok: true, label: null };
	const resolved = resolveCaptionLanguage(raw);
	const lower = resolved.label.toLowerCase();
	const known = VIDEO_TRANSLATE_TARGET_LANGUAGES.some(
		(l) =>
			l.toLowerCase() === lower ||
			l.toLowerCase().split("(")[0].trim() === lower.split("(")[0].trim(),
	);
	if (!known && raw) {
		return {
			ok: false,
			error: `Unsupported language "${resolved.label}"`,
			httpStatus: 400,
			details: {
				hint: "Use GET /api/audio-to-text/languages or /api/video-translate/languages",
			},
		};
	}
	return { ok: true, label: resolved.label, resolved };
}

/**
 * @param {{
 *   text?: string,
 *   language?: string,
 *   output_language?: string,
 *   source_language?: string,
 *   source_nllb?: string,
 *   transcript_language?: string,
 *   translate_model?: string,
 *   tts_voice?: string,
 *   voice_id?: string,
 *   brand_voice_id?: string,
 *   tts_model?: string,
 *   tts_engine?: string,
 *   piper_model?: string,
 *   uploadAudioBufferToUploadThing: (buffer: Buffer, name: string) => Promise<string>,
 *   requestId?: string,
 * }} opts
 */
export async function runFreeTextToAudio(opts) {
	const {
		text: rawText,
		language,
		output_language,
		source_language,
		source_nllb,
		transcript_language,
		translate_model,
		tts_voice,
		voice_id,
		brand_voice_id,
		tts_model,
		tts_engine: ttsEngineOpt,
		piper_model,
		uploadAudioBufferToUploadThing,
		requestId,
	} = opts;

	if (!process.env.UPLOADTHING_TOKEN?.trim()) {
		return {
			error: "UPLOADTHING_TOKEN not configured (required for free TTS uploads)",
			code: "MISSING_UPLOAD_TOKEN",
			httpStatus: 503,
		};
	}

	const sourceText = String(rawText ?? "").trim();
	if (!sourceText) {
		return {
			error: "Provide non-empty text",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}
	if (sourceText.length > MAX_TEXT_CHARS) {
		return {
			error: `text exceeds ${MAX_TEXT_CHARS} characters`,
			code: "TEXT_TOO_LONG",
			httpStatus: 400,
			details: { max_chars: MAX_TEXT_CHARS },
		};
	}

	const langRaw = language ?? output_language ?? "";
	const langCheck = validateLanguage(langRaw);
	if (!langCheck.ok) {
		return {
			error: langCheck.error,
			code: "UNSUPPORTED_LANGUAGE",
			httpStatus: langCheck.httpStatus ?? 400,
			details: langCheck.details,
		};
	}

	const signal = AbortSignal.timeout(FREE_TTS_TIMEOUT_MS);
	let speakText = sourceText;
	let languageLabel = langCheck.label || "English";
	let translated = false;
	let translationEngine = null;
	let translationModel = null;

	if (langRaw) {
		try {
			const tr = await translateTextForFreeTts({
				text: sourceText,
				language: langRaw,
				output_language: langRaw,
				source_language,
				source_nllb,
				transcript_language,
				translate_model,
				signal,
			});
			speakText = tr.text;
			languageLabel = tr.language;
			translated = tr.translated;
			translationEngine = tr.translation_engine;
			translationModel = tr.translation_model ?? null;
		} catch (e) {
			const o = openRouterErrorFromUnknown(e);
			return {
				error: o.message,
				code: o.code,
				user_message: o.user_message,
				httpStatus: o.httpStatus ?? 502,
				retryable: o.retryable,
			};
		}
	}

	const modelChainRes = resolveFreeTtsModelChain(tts_model);
	if (!modelChainRes.ok) {
		return {
			error: modelChainRes.error,
			code: "UNKNOWN_TTS_MODEL",
			httpStatus: 400,
			details: { allowed: modelChainRes.allowed },
		};
	}

	let ttsEng = normalizeTtsEngine(ttsEngineOpt);
	if (modelChainRes.preset === "piper") {
		ttsEng = "piper";
	}

	if (ttsEng === "piper") {
		const modelPath = piper_model?.trim() || null;
		if (!modelPath && !isPiperConfigured()) {
			return {
				error:
					"Piper TTS is not configured on the server. Set PIPER_MODEL in .env (path to a .onnx voice model), or use tts_engine: \"openrouter\" with a Kokoro voice from GET /api/audio-to-text/voices.",
				code: "PIPER_NOT_CONFIGURED",
				httpStatus: 503,
				details: {
					hint: "Install piper (PIPER_BIN) and download a voice .onnx model, or omit tts_engine to use Kokoro on OpenRouter.",
				},
			};
		}
	}

	const voiceResolved = resolveFreeKokoroVoice({
		tts_voice,
		voice_id,
		brand_voice_id,
		language_label: languageLabel,
	});

	let audioBuffer;
	let audioFormat = "wav";
	let uploadExt = ".wav";
	let ttsModelUsed = null;
	let ttsPreset = modelChainRes.preset;
	let ttsEngine = ttsEng;

	try {
		if (ttsEng === "piper") {
			const modelPath = piper_model?.trim() || null;
			audioBuffer = await piperSynthesizeWav({
				text: speakText,
				modelPath,
				signal,
			});
			ttsEngine = "piper";
			ttsModelUsed = modelPath || process.env.PIPER_MODEL?.trim() || "piper";
		} else {
			if (!process.env.OPENROUTER_API_KEY?.trim()) {
				return {
					error: "OPENROUTER_API_KEY not configured",
					code: "MISSING_OPENROUTER_KEY",
					httpStatus: 503,
				};
			}
			const synth = await freeTtsSynthesizeToBuffer({
				text: speakText,
				signal,
				voice: voiceResolved.voice,
				gender: voiceResolved.gender,
				models: modelChainRes.chain,
			});
			if (synth.format === "mp3") {
				audioBuffer = synth.buffer;
				audioFormat = "mp3";
				uploadExt = ".mp3";
			} else {
				audioBuffer = pcm16ToWavBuffer(synth.buffer);
				audioFormat = "wav";
				uploadExt = ".wav";
			}
			ttsModelUsed = synth.modelUsed ?? modelChainRes.chain[0];
			ttsEngine = "openrouter";
		}
	} catch (e) {
		const o = openRouterErrorFromUnknown(e);
		return {
			error: o.message,
			code: o.code,
			user_message: o.user_message,
			httpStatus: o.httpStatus ?? 502,
			retryable: o.retryable,
		};
	}

	const rid = String(requestId ?? "")
		.replace(/[^a-zA-Z0-9-]/g, "")
		.slice(0, 36);
	const safeVoice = voiceResolved.voice_id.replace(/[^a-zA-Z0-9_-]/g, "_");
	const safeLang = String(languageLabel)
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.slice(0, 32);
	const fileName = `free-tts-${rid || "req"}-${safeLang}-${safeVoice}${uploadExt}`;

	let audioUrl;
	try {
		audioUrl = await uploadAudioBufferToUploadThing(audioBuffer, fileName);
	} catch (e) {
		return {
			error: e?.message || "Audio upload failed",
			code: "UPLOAD_FAILED",
			httpStatus: 502,
		};
	}

	return {
		error: null,
		data: {
			text: speakText,
			source_text: sourceText,
			language: languageLabel,
			output_language: languageLabel,
			translated,
			translation_engine: translationEngine,
			translation_model: translationModel,
			audio_url: audioUrl,
			audioUrl,
			audio_format: audioFormat,
			tts_voice: ttsEng === "piper" ? "piper" : voiceResolved.voice,
			tts_voice_id: ttsEng === "piper" ? "piper" : voiceResolved.voice_id,
			voice_id: ttsEng === "piper" ? "piper" : voiceResolved.voice_id,
			gender: voiceResolved.gender,
			tts_engine: ttsEngine,
			tts_model: ttsModelUsed,
			tts_model_preset: ttsPreset,
			tier: "free",
			request_id: requestId ?? null,
		},
	};
}
