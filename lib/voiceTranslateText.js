/**
 * Text or audio → multiple target languages: OpenRouter transcription (audio) +
 * JSON translation + optional OpenRouter TTS (pcm16) per language.
 */
import path from "node:path";
import {
	mergeOpenRouterUsage,
	normalizeOpenRouterUsage,
	buildUsageResponseFields,
} from "./openRouterUsage.js";
import {
	ttsSynthesizeToBuffer,
	pcm16ToWavBuffer,
	normalizeVideoTranslationEngine,
	normalizeOpenRouterTtsEngine,
} from "./videoTranslateOpenRouter.js";
import { translateTextWithNllb } from "./nllbTranslate.js";
import { piperSynthesizeWav, isPiperConfigured } from "./piperTts.js";
import { refineTranslationGlossaryOpenRouter } from "./translationRefineGlossary.js";
import {
	targetLanguageLabelToNllb,
	looseIsoToNllbSource,
} from "./nmtLanguages.js";
import {
	TRANSLATE_LLM_PRESETS,
	resolveTranslateLlmModel,
} from "./translateLlmModels.js";

const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";

const OPENROUTER_TIMEOUT_MS =
	Number.parseInt(process.env.OPENROUTER_TIMEOUT_MS || "", 10) || 90_000;

const MAX_TEXT_CHARS =
	Number.parseInt(process.env.VOICE_TRANSLATE_TEXT_MAX_CHARS || "", 10) || 12_000;
const MAX_LANGUAGES =
	Number.parseInt(process.env.VOICE_TRANSLATE_TEXT_MAX_LANGUAGES || "", 10) || 12;
const MAX_AUDIO_BYTES =
	Number.parseInt(process.env.VOICE_TRANSLATE_MAX_AUDIO_BYTES || "", 10) ||
	25 * 1024 * 1024;

const OPENROUTER_GLOSSARY_REFINE_MODEL =
	process.env.OPENROUTER_GLOSSARY_REFINE_MODEL?.trim() ||
	"openai/gpt-4o-mini";

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

function parseJsonObjectFromModel(raw) {
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

function normalizeLanguageList(raw) {
	if (!raw) return [];
	const arr = Array.isArray(raw) ? raw : [raw];
	const seen = new Set();
	const out = [];
	for (const x of arr) {
		const s = String(x ?? "").trim();
		if (!s || seen.has(s.toLowerCase())) continue;
		seen.add(s.toLowerCase());
		out.push(s);
	}
	return out;
}

/** Map file extension or OpenRouter input_audio format string. */
function extensionToAudioFormat(ext) {
	const e = String(ext || "").toLowerCase().replace(/^\./, "");
	const map = {
		mp3: "mp3",
		wav: "wav",
		m4a: "m4a",
		aac: "aac",
		ogg: "ogg",
		oga: "ogg",
		webm: "ogg",
		flac: "flac",
		aiff: "aiff",
		aif: "aiff",
		mp4: "m4a",
		pcm: "pcm16",
	};
	return map[e] || null;
}

export function guessAudioFormatFromFilename(filename) {
	const ext = path.extname(filename || "").toLowerCase();
	return extensionToAudioFormat(ext);
}

/**
 * Fetch remote audio bytes (e.g. UploadThing URL after upload).
 */
export async function fetchAudioBufferFromUrl(url, signal) {
	const res = await fetch(String(url).trim(), {
		signal,
		redirect: "follow",
		headers: {
			"User-Agent":
				process.env.VOICE_TRANSLATE_AUDIO_FETCH_UA?.trim() ||
				"Mozilla/5.0 (compatible; ihatereading-api/1.0)",
		},
	});
	if (!res.ok) {
		throw new Error(`Failed to fetch audio URL: HTTP ${res.status}`);
	}
	const len = res.headers.get("content-length");
	if (len && Number(len) > MAX_AUDIO_BYTES) {
		throw new Error(`Audio file too large (max ${MAX_AUDIO_BYTES} bytes)`);
	}
	const ab = await res.arrayBuffer();
	const buf = Buffer.from(ab);
	if (buf.length > MAX_AUDIO_BYTES) {
		throw new Error(`Audio file too large (max ${MAX_AUDIO_BYTES} bytes)`);
	}
	return buf;
}

async function transcribeAudioWithOpenRouter({
	buffer,
	format,
	signal,
	model: modelOverride,
}) {
	const model =
		modelOverride?.trim() ||
		process.env.OPENROUTER_VOICE_TRANSLATE_TRANSCRIBE_MODEL?.trim() ||
		TRANSLATE_LLM_PRESETS.gemini;

	const fmt = format || "mp3";
	const base64 = buffer.toString("base64");

	const userText =
		'Transcribe the spoken content verbatim in the original language. Reply with ONLY a JSON object: {"transcript":"<full transcript>","source_language":"<ISO 639-1 code for the primary spoken language, e.g. en or es>"}';

	const messages = [
		{
			role: "user",
			content: [
				{ type: "text", text: userText },
				{
					type: "input_audio",
					input_audio: {
						data: base64,
						format: fmt,
					},
				},
			],
		},
	];

	let chatRes = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterHeaders(),
		body: JSON.stringify({
			model,
			messages,
			temperature: 0.1,
			response_format: { type: "json_object" },
		}),
	});

	let chatData = await chatRes.json().catch(() => ({}));
	if (!chatRes.ok || chatData.error) {
		const msg = String(chatData?.error?.message || chatData?.error || "");
		const retryNoRf = /response_format|json_object|unsupported/i.test(msg);
		if (retryNoRf) {
			chatRes = await fetch(OPENROUTER_CHAT, {
				method: "POST",
				signal,
				headers: openRouterHeaders(),
				body: JSON.stringify({
					model,
					messages,
					temperature: 0.1,
				}),
			});
			chatData = await chatRes.json().catch(() => ({}));
		}
	}

	if (!chatRes.ok || chatData.error) {
		const msg =
			chatData.error?.message ||
			chatData.error ||
			`OpenRouter HTTP ${chatRes.status}`;
		throw new Error(String(msg));
	}

	const content = chatData.choices?.[0]?.message?.content;
	if (!content || typeof content !== "string") {
		throw new Error("Empty transcription from model");
	}

	let parsed;
	try {
		parsed = parseJsonObjectFromModel(content);
	} catch (e) {
		throw new Error(`Invalid transcription JSON: ${e?.message || String(e)}`);
	}

	const transcript = String(parsed?.transcript ?? "").trim();
	if (!transcript) {
		throw new Error("Transcription produced empty transcript");
	}
	const slRaw = parsed?.source_language;
	const sourceLanguage =
		slRaw != null && String(slRaw).trim() !== ""
			? String(slRaw).trim()
			: null;

	return {
		transcript,
		source_language: sourceLanguage,
		usage: chatData.usage,
		model,
	};
}

/**
 * @param {{
 *   text?: string,
 *   audioUrl?: string,
 *   audioBuffer?: Buffer,
 *   audioFormat?: string,
 *   languages: unknown,
 *   includeAudio?: boolean,
 *   model?: string,
 *   llmModel?: string,
 *   signal?: AbortSignal,
 *   afterTranslatedTts?: (results: Array<Record<string, unknown>>) => Promise<void>,
 *   translation_engine?: string,
 *   tts_engine?: string,
 *   glossary_refinement?: boolean | string,
 *   piper_model?: string,
 *   source_nllb?: string,
 *   transcript_language?: string,
 *   source_language?: string,
 *   glossary_refine_model?: string,
 * }} opts
 *
 * Provide one of: non-empty `text`, or `audioUrl`, or `audioBuffer` (after server upload).
 * If both text and audio are supplied, audio wins.
 * When `afterTranslatedTts` is set (e.g. UploadThing), it runs after pcm16 TTS so `results` can be replaced with URLs before the response is built.
 * `translation_engine`: llm (default) | nllb; `tts_engine`: openrouter (default) | piper; `glossary_refinement` runs a small OpenRouter call after NLLB.
 */
export async function runVoiceTranslateText({
	text,
	audioUrl,
	audioBuffer,
	audioFormat,
	languages,
	includeAudio = true,
	model: modelParam,
	llmModel: llmModelParam,
	signal: outerSignal,
	afterTranslatedTts,
	translation_engine: translationEngineOpt,
	tts_engine: ttsEngineOpt,
	glossary_refinement: glossaryRefinementOpt,
	piper_model: piperModelOpt,
	source_nllb: sourceNllbOpt,
	transcript_language: transcriptLanguageOpt,
	source_language: sourceLanguageOpt,
	glossary_refine_model: glossaryRefineModelOpt,
}) {
	if (!process.env.OPENROUTER_API_KEY?.trim()) {
		return {
			error: "OPENROUTER_API_KEY not configured",
			code: "MISSING_API_KEY",
			httpStatus: 503,
		};
	}

	const rawModel = modelParam ?? llmModelParam;
	let translationModelId;
	let transcribeModelId;
	let llmPresetName;

	if (rawModel != null && String(rawModel).trim() !== "") {
		const r = resolveTranslateLlmModel(rawModel);
		if (!r.ok) {
			return {
				error: r.error,
				code: "BAD_REQUEST",
				details: { allowed_models: r.allowed },
				httpStatus: 400,
			};
		}
		translationModelId = r.openrouterId;
		transcribeModelId = r.openrouterId;
		llmPresetName = r.preset;
	} else {
		translationModelId =
			process.env.OPENROUTER_VOICE_TRANSLATE_MODEL?.trim() ||
			process.env.OPENROUTER_MODEL?.trim() ||
			TRANSLATE_LLM_PRESETS.gemini;
		transcribeModelId =
			process.env.OPENROUTER_VOICE_TRANSLATE_TRANSCRIBE_MODEL?.trim() ||
			TRANSLATE_LLM_PRESETS.gemini;
	}

	const langs = normalizeLanguageList(languages);
	if (!langs.length) {
		return {
			error:
				"Provide languages as a non-empty array of language names (e.g. [\"Spanish\",\"French\"])",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}
	if (langs.length > MAX_LANGUAGES) {
		return {
			error: `At most ${MAX_LANGUAGES} languages per request`,
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const signal =
		outerSignal ||
		AbortSignal.timeout(Math.max(OPENROUTER_TIMEOUT_MS, 180_000));

	const hasAudio =
		(audioBuffer && audioBuffer.length > 0) ||
		(audioUrl && String(audioUrl).trim());

	let source = "";
	let sourceType = "text";
	let transcribeModel = null;
	let audioInputUrl = null;
	let asrSourceLanguage = null;
	let mergedUsage = normalizeOpenRouterUsage(null);

	if (hasAudio) {
		sourceType = "audio";
		let buf = audioBuffer;
		let fmt =
			(audioFormat && extensionToAudioFormat(audioFormat)) ||
			(typeof audioFormat === "string" && audioFormat.length <= 8
				? audioFormat.toLowerCase()
				: null);

		if (audioUrl) {
			audioInputUrl = String(audioUrl).trim();
		}
		if (!buf && audioUrl) {
			buf = await fetchAudioBufferFromUrl(String(audioUrl).trim(), signal);
		}

		if (!buf?.length) {
			return {
				error: "Missing or empty audio buffer",
				code: "BAD_REQUEST",
				httpStatus: 400,
			};
		}
		if (buf.length > MAX_AUDIO_BYTES) {
			return {
				error: `Audio file too large (max ${MAX_AUDIO_BYTES} bytes)`,
				code: "BAD_REQUEST",
				httpStatus: 400,
			};
		}

		if (!fmt && audioUrl) {
			try {
				const p = new URL(String(audioUrl)).pathname;
				fmt = guessAudioFormatFromFilename(p) || "mp3";
			} catch {
				fmt = "mp3";
			}
		}
		if (!fmt) fmt = "mp3";

		try {
			const tr = await transcribeAudioWithOpenRouter({
				buffer: buf,
				format: fmt,
				signal,
				model: transcribeModelId,
			});
			source = tr.transcript;
			asrSourceLanguage = tr.source_language;
			transcribeModel = tr.model;
			mergedUsage = mergeOpenRouterUsage(
				mergedUsage,
				normalizeOpenRouterUsage(tr.usage),
			);
		} catch (e) {
			return {
				error: e?.message || String(e),
				code: "TRANSCRIBE_ERROR",
				httpStatus: 502,
			};
		}
	} else {
		source = String(text ?? "").trim();
		if (!source) {
			return {
				error:
					"Provide non-empty text, or a media URL (audio_url, audioUrl, url, link, …), or upload an audio file (field: audio or file)",
				code: "BAD_REQUEST",
				httpStatus: 400,
			};
		}
	}

	if (!hasAudio && source.length > MAX_TEXT_CHARS) {
		return {
			error: `text exceeds ${MAX_TEXT_CHARS} characters`,
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const transEng = normalizeVideoTranslationEngine(translationEngineOpt);
	const ttsEng = normalizeOpenRouterTtsEngine(ttsEngineOpt);
	const glossaryRef =
		glossaryRefinementOpt === true ||
		glossaryRefinementOpt === "true" ||
		glossaryRefinementOpt === "1";
	const piperModel = piperModelOpt ? String(piperModelOpt).trim() : null;
	const transcriptSourceNllb =
		sourceNllbOpt != null && String(sourceNllbOpt).includes("_")
			? String(sourceNllbOpt).trim()
			: null;
	const transcriptLangHint =
		transcriptLanguageOpt != null
			? String(transcriptLanguageOpt).trim()
			: sourceLanguageOpt != null
				? String(sourceLanguageOpt).trim()
				: null;
	const glossaryRefineModel = glossaryRefineModelOpt
		? String(glossaryRefineModelOpt).trim()
		: null;

	if (transEng === "nllb") {
		for (const label of langs) {
			if (!targetLanguageLabelToNllb(label)) {
				return {
					error: `Language "${label}" is not supported for translation_engine nllb (extend lib/nmtLanguages.js or use llm).`,
					code: "BAD_REQUEST",
					httpStatus: 400,
				};
			}
		}
	}
	if (ttsEng === "piper" && !piperModel && !isPiperConfigured()) {
		return {
			error:
				"Piper TTS requires PIPER_MODEL in the environment or piper_model in the request body.",
			code: "MISSING_PIPER_MODEL",
			httpStatus: 503,
		};
	}

	const model = translationModelId;

	let results = [];
	let bulkMtModel = null;

	if (transEng === "nllb") {
		let srcNllb = transcriptSourceNllb;
		if (!srcNllb && transcriptLangHint) {
			srcNllb = looseIsoToNllbSource(transcriptLangHint.slice(0, 2));
		}
		if (!srcNllb && hasAudio && asrSourceLanguage) {
			srcNllb = looseIsoToNllbSource(asrSourceLanguage);
		}
		if (!srcNllb) srcNllb = "eng_Latn";

		for (const label of langs) {
			const tgtNllb = targetLanguageLabelToNllb(label);
			const nllbOut = await translateTextWithNllb({
				text: source,
				srcLang: srcNllb,
				tgtLang: tgtNllb,
				signal,
			});
			if (!bulkMtModel) bulkMtModel = nllbOut.model;
			let translated = nllbOut.translation;
			if (glossaryRef) {
				const gM = glossaryRefineModel || OPENROUTER_GLOSSARY_REFINE_MODEL;
				const ref = await refineTranslationGlossaryOpenRouter({
					translation: translated,
					targetLanguage: label,
					model: gM,
					signal,
				});
				translated = ref.translation;
				mergedUsage = mergeOpenRouterUsage(
					mergedUsage,
					normalizeOpenRouterUsage(ref.usage),
				);
			}
			results.push({ language: label, transcript: translated });
		}
	} else {
		const system = `You translate prose for voice dubbing. Reply with ONLY a JSON object (no markdown) with this exact shape:
{"translations":[{"language":"<exact label from the request>","transcript":"<full translation>"}]}
Include one object per requested language. The "language" value must match the requested label exactly (case-sensitive). "transcript" must be the complete translation, natural for spoken delivery.`;

		const user = `Source text:\n"""${source}"""\n\nTarget languages (use these exact strings for "language"): ${JSON.stringify(langs)}`;

		const chatRes = await fetch(OPENROUTER_CHAT, {
			method: "POST",
			signal,
			headers: openRouterHeaders(),
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				temperature: 0.25,
				response_format: { type: "json_object" },
			}),
		});

		const chatData = await chatRes.json().catch(() => ({}));
		if (!chatRes.ok || chatData.error) {
			const msg =
				chatData.error?.message ||
				chatData.error ||
				`OpenRouter HTTP ${chatRes.status}`;
			const upstream = chatRes.status;
			/** Do not forward 404 — clients mistake it for a missing API route. */
			let httpStatus = 502;
			if (upstream === 429) httpStatus = 429;
			else if (upstream === 401 || upstream === 403) httpStatus = upstream;
			return {
				error: String(msg),
				code: "OPENROUTER_ERROR",
				upstream_status: upstream,
				httpStatus,
			};
		}

		const content = chatData.choices?.[0]?.message?.content;
		if (!content || typeof content !== "string") {
			return {
				error: "Empty translation from model",
				code: "OPENROUTER_ERROR",
				httpStatus: 502,
			};
		}

		let parsed;
		try {
			parsed = parseJsonObjectFromModel(content);
		} catch (e) {
			return {
				error: `Invalid JSON from model: ${e?.message || String(e)}`,
				code: "PARSE_ERROR",
				httpStatus: 502,
			};
		}

		const rows = Array.isArray(parsed?.translations)
			? parsed.translations
			: null;
		if (!rows?.length) {
			return {
				error:
					'Model must return { "translations": [ { "language", "transcript" }, ... ] }',
				code: "PARSE_ERROR",
				httpStatus: 502,
			};
		}

		mergedUsage = mergeOpenRouterUsage(
			mergedUsage,
			normalizeOpenRouterUsage(chatData.usage),
		);

		const byLang = new Map();
		for (const row of rows) {
			const lang = String(row?.language ?? "").trim();
			const tr = String(row?.transcript ?? "").trim();
			if (lang && tr) byLang.set(lang.toLowerCase(), { language: lang, transcript: tr });
		}

		for (const label of langs) {
			const hit = byLang.get(label.toLowerCase());
			if (!hit) {
				return {
					error: `Missing translation for language "${label}" in model output`,
					code: "TRANSLATION_INCOMPLETE",
					httpStatus: 502,
				};
			}
			results.push({ ...hit });
		}
	}

	if (includeAudio) {
		for (let i = 0; i < results.length; i++) {
			const t = results[i].transcript;
			try {
				if (ttsEng === "piper") {
					const wavBuf = await piperSynthesizeWav({
						text: t,
						modelPath: piperModel || null,
						signal,
					});
					results[i] = {
						...results[i],
						audio_base64: wavBuf.toString("base64"),
						audio_format: "wav",
					};
				} else {
					const { buffer, format, usage: ttsUsage } = await ttsSynthesizeToBuffer(
						{
							text: t,
							signal,
						},
					);
					mergedUsage = mergeOpenRouterUsage(
						mergedUsage,
						normalizeOpenRouterUsage(ttsUsage),
					);
					results[i] = {
						...results[i],
						audio_base64: buffer.toString("base64"),
						audio_format: format || "pcm16",
					};
				}
			} catch (e) {
				return {
					error: e?.message || String(e),
					code: "TTS_ERROR",
					httpStatus: 502,
				};
			}
		}
	}

	if (
		includeAudio &&
		results.length &&
		typeof afterTranslatedTts === "function"
	) {
		try {
			await afterTranslatedTts(results);
		} catch (e) {
			return {
				error: e?.message || "TTS audio upload failed",
				code: "UPLOAD_ERROR",
				httpStatus: 502,
			};
		}
	}

	const usagePayload = buildUsageResponseFields(mergedUsage);
	return {
		error: null,
		data: {
			source_type: sourceType,
			source_text: source,
			...(typeof llmPresetName === "string"
				? { llm_preset: llmPresetName }
				: {}),
			...(sourceType === "audio" && {
				audio_input_url: audioInputUrl,
				transcribe_model: transcribeModel,
			}),
			model,
			results,
			pipeline: {
				translation: transEng,
				tts: ttsEng,
				glossary_refinement: glossaryRef,
				bulk_mt_model: bulkMtModel,
			},
		},
		httpStatus: 200,
		...usagePayload,
	};
}

/**
 * Upload translated TTS (`results[].audio_base64`: pcm16 for OpenRouter TTS, or wav for Piper) to UploadThing.
 * Sets `audio_url` / `audioUrl`; removes `audio_base64` so the client gets real URLs.
 */
export async function uploadVoiceTranslateTtsToUploadThing(
	results,
	uploadAudioBufferToUploadThing,
	requestId,
) {
	if (!process.env.UPLOADTHING_TOKEN?.trim() || !Array.isArray(results)) {
		return;
	}
	const rid = String(requestId ?? "")
		.replace(/[^a-zA-Z0-9-]/g, "")
		.slice(0, 36);
	for (let i = 0; i < results.length; i++) {
		const row = results[i];
		const b64 = row?.audio_base64;
		if (!b64 || typeof b64 !== "string") continue;
		let pcmBuf;
		try {
			pcmBuf = Buffer.from(b64.trim(), "base64");
		} catch (e) {
			throw new Error(
				`Invalid TTS audio_base64 for row ${i}: ${e?.message || String(e)}`,
			);
		}
		if (!pcmBuf.length) {
			throw new Error(`Empty TTS audio payload after base64 decode (row ${i})`);
		}
		const isWav = row?.audio_format === "wav";
		const wav = isWav ? pcmBuf : pcm16ToWavBuffer(pcmBuf);
		const safeLang = String(row.language ?? "lang")
			.replace(/[^a-zA-Z0-9_-]/g, "_")
			.slice(0, 64);
		const name = `voice-translate-tts-${rid || "req"}-${i}-${safeLang}.wav`;
		const url = await uploadAudioBufferToUploadThing(wav, name);
		if (!url || typeof url !== "string") {
			throw new Error("UploadThing returned no URL for translated TTS");
		}
		const { audio_base64: _b64, ...withoutB64 } = row;
		results[i] = {
			...withoutB64,
			audio_url: url,
			audioUrl: url,
			audio_format: isWav ? "wav" : "pcm16",
		};
	}
}
