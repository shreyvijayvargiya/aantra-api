/**
 * Text or audio → target languages via Groq only: Whisper (audio) + chat completions
 * + Groq /audio/speech TTS (WAV). No OpenRouter.
 *
 * Orpheus TTS models require a one-time terms acceptance in Groq Cloud (org admin):
 * Playground or model page → accept terms, then API calls succeed.
 */
import path from "node:path";
import fsp from "fs/promises";
import os from "os";
import {
	mergeOpenRouterUsage,
	normalizeOpenRouterUsage,
	buildUsageResponseFields,
} from "./openRouterUsage.js";
import { execFfmpeg } from "./videoTranslateOpenRouter.js";
import {
	fetchAudioBufferFromUrl,
	guessAudioFormatFromFilename,
} from "./voiceTranslateText.js";

const GROQ_BASE = "https://api.groq.com/openai/v1";

const GROQ_TIMEOUT_MS =
	Number.parseInt(process.env.GROQ_TIMEOUT_MS || "", 10) || 90_000;

const MAX_TEXT_CHARS =
	Number.parseInt(process.env.VOICE_TRANSLATE_TEXT_MAX_CHARS || "", 10) || 12_000;
const MAX_LANGUAGES =
	Number.parseInt(process.env.VOICE_TRANSLATE_TEXT_MAX_LANGUAGES || "", 10) || 12;
const MAX_AUDIO_BYTES =
	Number.parseInt(process.env.VOICE_TRANSLATE_MAX_AUDIO_BYTES || "", 10) ||
	25 * 1024 * 1024;

/** Orpheus-style models often cap input length; stay under with margin. */
const GROQ_TTS_CHUNK_CHARS =
	Number.parseInt(process.env.GROQ_TTS_CHUNK_CHARS || "", 10) || 180;

export function getGroqApiKey() {
	return (
		process.env.GROK_API_KEY?.trim() ||
		process.env.GROQ_API_KEY?.trim() ||
		""
	);
}

function groqHeadersJson() {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${getGroqApiKey()}`,
	};
}

function defaultChatModel() {
	return (
		process.env.GROQ_CHAT_MODEL?.trim() || "llama-3.3-70b-versatile"
	);
}

function defaultWhisperModel() {
	return (
		process.env.GROQ_WHISPER_MODEL?.trim() || "whisper-large-v3-turbo"
	);
}

/** Default Orpheus English; set `GROQ_TTS_MODEL` after terms are accepted for your org. */
function defaultTtsModel() {
	return (
		process.env.GROQ_TTS_MODEL?.trim() || "canopylabs/orpheus-v1-english"
	);
}

/** Orpheus English: `autumn` | `diana` | `hannah` | `austin` | `daniel` | `troy` (see Groq TTS docs). */
function defaultTtsVoice() {
	return process.env.GROQ_TTS_VOICE?.trim() || "austin";
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

function extensionToFilenameForAsr(ext) {
	const e = String(ext || "").toLowerCase().replace(/^\./, "");
	const map = {
		mp3: "audio.mp3",
		wav: "audio.wav",
		m4a: "audio.m4a",
		aac: "audio.aac",
		ogg: "audio.ogg",
		webm: "audio.webm",
		flac: "audio.flac",
		mp4: "audio.m4a",
	};
	return map[e] || "audio.mp3";
}

export async function transcribeBufferWithGroqWhisper({
	buffer,
	filename,
	signal,
	model,
	verbose = false,
}) {
	const key = getGroqApiKey();
	const form = new FormData();
	form.append("model", model);
	form.append("response_format", verbose ? "verbose_json" : "json");
	const blob = new Blob([buffer]);
	form.append("file", blob, filename);

	const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
		method: "POST",
		signal,
		headers: { Authorization: `Bearer ${key}` },
		body: form,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.error) {
		const msg =
			(typeof data.error === "object" && data.error?.message) ||
			data.error ||
			`Groq Whisper HTTP ${res.status}`;
		throw new Error(String(msg));
	}
	const text = String(data.text ?? "").trim();
	if (!text) throw new Error("Whisper returned empty transcript");
	if (verbose) {
		const lang = data.language != null ? String(data.language).trim() : null;
		return { transcript: text, language: lang, usage: null };
	}
	return { transcript: text, usage: null };
}

export class GroqTtsError extends Error {
	/**
	 * @param {string} message
	 * @param {{ groqCode?: string | null, httpStatus?: number, details?: Record<string, unknown> | null }} [meta]
	 */
	constructor(message, meta = {}) {
		super(message);
		this.name = "GroqTtsError";
		this.groqCode = meta.groqCode ?? null;
		this.httpStatus = meta.httpStatus;
		this.details = meta.details ?? null;
	}
}

function extractTermsUrl(message) {
	const m = String(message).match(/https:\/\/[^\s"'<>]+/);
	if (!m) return null;
	return m[0].replace(/[.,;)]+$/, "");
}

function parseGroqErrorPayload(errText) {
	try {
		const j = JSON.parse(errText);
		const e = j?.error;
		if (e && typeof e === "object") {
			return {
				message: String(e.message || ""),
				code: e.code != null ? String(e.code) : null,
			};
		}
	} catch {
		/* ignore */
	}
	return { message: String(errText || "").slice(0, 800), code: null };
}

async function throwGroqTtsIfNotOk(res) {
	if (res.ok) return;
	const errText = await res.text();
	const { message: upstreamMsg, code } = parseGroqErrorPayload(errText);
	if (code === "model_terms_required") {
		const termsUrl = extractTermsUrl(upstreamMsg);
		const hint =
			"Groq Orpheus TTS is blocked until an organization admin accepts the model terms in Groq Cloud. Open the link below (Playground / model page), accept terms, then retry.";
		const full = termsUrl ? `${hint} ${termsUrl}` : `${hint} ${upstreamMsg}`;
		throw new GroqTtsError(full, {
			groqCode: code,
			httpStatus: res.status,
			details: {
				groq_message: upstreamMsg,
				...(termsUrl ? { accept_terms_url: termsUrl } : {}),
			},
		});
	}
	throw new GroqTtsError(upstreamMsg || `Groq TTS HTTP ${res.status}`, {
		groqCode: code,
		httpStatus: res.status,
		details: { raw: errText.slice(0, 1200) },
	});
}

function splitTtsText(text, maxLen) {
	const t = String(text || "").trim();
	if (t.length <= maxLen) return [t];
	const chunks = [];
	let i = 0;
	while (i < t.length) {
		let end = Math.min(i + maxLen, t.length);
		if (end < t.length) {
			const cut = t.lastIndexOf(". ", end);
			const cut2 = t.lastIndexOf("\n", end);
			const best = Math.max(cut, cut2);
			if (best > i + maxLen * 0.4) end = best + 1;
		}
		chunks.push(t.slice(i, end).trim());
		i = end;
	}
	return chunks.filter(Boolean);
}

export async function groqTtsToWavBuffer({ text, signal }) {
	const model = defaultTtsModel();
	const voice = defaultTtsVoice();
	const chunks = splitTtsText(text, GROQ_TTS_CHUNK_CHARS);
	if (chunks.length === 1) {
		const res = await fetch(`${GROQ_BASE}/audio/speech`, {
			method: "POST",
			signal,
			headers: groqHeadersJson(),
			body: JSON.stringify({
				model,
				voice,
				input: chunks[0],
				response_format: "wav",
			}),
		});
		if (!res.ok) await throwGroqTtsIfNotOk(res);
		return Buffer.from(await res.arrayBuffer());
	}

	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "groq-tts-"));
	try {
		const partPaths = [];
		for (let i = 0; i < chunks.length; i++) {
			const res = await fetch(`${GROQ_BASE}/audio/speech`, {
				method: "POST",
				signal,
				headers: groqHeadersJson(),
				body: JSON.stringify({
					model,
					voice,
					input: chunks[i],
					response_format: "wav",
				}),
			});
			if (!res.ok) await throwGroqTtsIfNotOk(res);
			const buf = Buffer.from(await res.arrayBuffer());
			const p = path.join(tmpDir, `p${i}.wav`);
			await fsp.writeFile(p, buf);
			partPaths.push(p);
		}
		const listPath = path.join(tmpDir, "list.txt");
		const listBody = partPaths
			.map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
			.join("\n");
		await fsp.writeFile(listPath, listBody, "utf8");
		const outPath = path.join(tmpDir, "merged.wav");
		await execFfmpeg(
			["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath],
			"ffmpeg concat Groq TTS wav",
		);
		return await fsp.readFile(outPath);
	} finally {
		await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Upload Groq TTS WAV bytes per result row (replaces audio_base64 with UploadThing URLs).
 */
export async function uploadGroqVoiceTranslateTtsToUploadThing(
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
		let wavBuf;
		try {
			wavBuf = Buffer.from(b64.trim(), "base64");
		} catch (e) {
			throw new Error(
				`Invalid TTS audio_base64 for row ${i}: ${e?.message || String(e)}`,
			);
		}
		if (!wavBuf.length) {
			throw new Error(`Empty TTS audio payload after base64 decode (row ${i})`);
		}
		const safeLang = String(row.language ?? "lang")
			.replace(/[^a-zA-Z0-9_-]/g, "_")
			.slice(0, 64);
		const name = `groq-voice-translate-tts-${rid || "req"}-${i}-${safeLang}.wav`;
		const url = await uploadAudioBufferToUploadThing(wavBuf, name);
		if (!url || typeof url !== "string") {
			throw new Error("UploadThing returned no URL for translated TTS");
		}
		const { audio_base64: _b64, ...withoutB64 } = row;
		results[i] = {
			...withoutB64,
			audio_url: url,
			audioUrl: url,
			audio_format: "wav",
		};
	}
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
 * }} opts
 */
export async function runGroqVoiceTranslateText({
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
}) {
	if (!getGroqApiKey()) {
		return {
			error: "GROK_API_KEY or GROQ_API_KEY not configured",
			code: "MISSING_API_KEY",
			httpStatus: 503,
		};
	}

	const chatModel =
		(modelParam && String(modelParam).trim()) ||
		(llmModelParam && String(llmModelParam).trim()) ||
		defaultChatModel();
	const whisperModel = defaultWhisperModel();

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
		outerSignal || AbortSignal.timeout(Math.max(GROQ_TIMEOUT_MS, 180_000));

	const hasAudio =
		(audioBuffer && audioBuffer.length > 0) ||
		(audioUrl && String(audioUrl).trim());

	let source = "";
	let sourceType = "text";
	let audioInputUrl = null;
	let mergedUsage = normalizeOpenRouterUsage(null);

	if (hasAudio) {
		sourceType = "audio";
		let buf = audioBuffer;
		let fname = "audio.mp3";

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

		if (audioFormat) {
			fname = extensionToFilenameForAsr(audioFormat);
		} else if (audioUrl) {
			try {
				fname = extensionToFilenameForAsr(
					path.extname(new URL(String(audioUrl)).pathname),
				);
			} catch {
				fname = "audio.mp3";
			}
		}

		try {
			const tr = await transcribeBufferWithGroqWhisper({
				buffer: buf,
				filename: fname,
				signal,
				model: whisperModel,
			});
			source = tr.transcript;
		} catch (e) {
			console.log(e, "e")
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

	const system = `You translate prose for voice dubbing. Reply with ONLY a JSON object (no markdown) with this exact shape:
{"translations":[{"language":"<exact label from the request>","transcript":"<full translation>"}]}
Include one object per requested language. The "language" value must match the requested label exactly (case-sensitive). "transcript" must be the complete translation, natural for spoken delivery.`;

	const user = `Source text:\n"""${source}"""\n\nTarget languages (use these exact strings for "language"): ${JSON.stringify(langs)}`;

	let chatRes = await fetch(`${GROQ_BASE}/chat/completions`, {
		method: "POST",
		signal,
		headers: groqHeadersJson(),
		body: JSON.stringify({
			model: chatModel,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature: 0.25,
			response_format: { type: "json_object" },
		}),
	});

	let chatData = await chatRes.json().catch(() => ({}));
	if (!chatRes.ok || chatData.error) {
		const msg = String(chatData?.error?.message || chatData?.error || "");
		const retryNoRf = /response_format|json_object|unsupported/i.test(msg);
		if (retryNoRf) {
			chatRes = await fetch(`${GROQ_BASE}/chat/completions`, {
				method: "POST",
				signal,
				headers: groqHeadersJson(),
				body: JSON.stringify({
					model: chatModel,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					temperature: 0.25,
				}),
			});
			chatData = await chatRes.json().catch(() => ({}));
		}
	}

	if (!chatRes.ok || chatData.error) {
		const msg =
			chatData.error?.message ||
			chatData.error ||
			`Groq HTTP ${chatRes.status}`;
		const upstream = chatRes.status;
		let httpStatus = 502;
		if (upstream === 429) httpStatus = 429;
		else if (upstream === 401 || upstream === 403) httpStatus = upstream;
		return {
			error: String(msg),
			code: "GROQ_ERROR",
			upstream_status: upstream,
			httpStatus,
		};
	}

	const content = chatData.choices?.[0]?.message?.content;
	if (!content || typeof content !== "string") {
		return {
			error: "Empty translation from model",
			code: "GROQ_ERROR",
			httpStatus: 502,
		};
	}

	mergedUsage = mergeOpenRouterUsage(
		mergedUsage,
		normalizeOpenRouterUsage(chatData.usage),
	);

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

	const byLang = new Map();
	for (const row of rows) {
		const lang = String(row?.language ?? "").trim();
		const transcript = String(row?.transcript ?? "").trim();
		if (lang && transcript)
			byLang.set(lang.toLowerCase(), { language: lang, transcript });
	}

	const results = [];
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

	if (includeAudio) {
		for (let i = 0; i < results.length; i++) {
			const t = results[i].transcript;
			try {
				const wavBuf = await groqTtsToWavBuffer({ text: t, signal });
				results[i] = {
					...results[i],
					audio_base64: wavBuf.toString("base64"),
					audio_format: "wav",
				};
			} catch (e) {
				if (
					e instanceof GroqTtsError &&
					e.groqCode === "model_terms_required"
				) {
					return {
						error: e.message,
						code: "GROQ_TTS_TERMS_REQUIRED",
						details: e.details,
						httpStatus: 400,
					};
				}
				const upstream =
					e instanceof GroqTtsError ? e.httpStatus : undefined;
				let httpStatus = 502;
				if (upstream === 429) httpStatus = 429;
				else if (upstream === 401 || upstream === 403) httpStatus = upstream;
				return {
					error: e?.message || String(e),
					code: "TTS_ERROR",
					...(e instanceof GroqTtsError && e.details
						? { details: e.details }
						: {}),
					httpStatus,
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
			engine: "groq",
			...(sourceType === "audio" && {
				audio_input_url: audioInputUrl,
				transcribe_model: whisperModel,
			}),
			model: chatModel,
			results,
		},
		httpStatus: 200,
		...usagePayload,
	};
}
