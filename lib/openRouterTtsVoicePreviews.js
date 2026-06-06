/**
 * TTS voice catalog with cached UploadThing preview WAVs (`resources/tts-voices.json`).
 * First GET generates missing previews; subsequent GETs read the cache only.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { UTApi, UTFile } from "uploadthing/server";
import {
	GEMINI_OPENROUTER_TTS_VOICES,
	getDefaultOpenRouterTtsVoiceName,
	getDefaultOpenRouterTtsVoicePresetId,
} from "./openRouterTtsVoices.js";

const DEFAULT_OPENROUTER_TTS_MODEL = "google/gemini-3.1-flash-tts-preview";
const PREVIEW_TEXT =
	"Hello! This is a sample of how I will narrate your translated content.";

export const TTS_VOICES_CACHE_PATH = path.join(
	process.cwd(),
	"resources",
	"tts-voices.json",
);

/** @type {Promise<unknown> | null} */
let previewGenerationInFlight = null;

/**
 * @typedef {{ error: null, data: {
 *   tts_engine: string,
 *   model: string,
 *   default_voice_id: string,
 *   default_tts_voice: string,
 *   preview_text: string,
 *   voices: Array<{
 *     id: string,
 *     tts_voice: string,
 *     label: string,
 *     gender: string,
 *     style: string,
 *     audio_url?: string | null,
 *   }>,
 *   previews_complete?: boolean,
 *   previews_pending_count?: number,
 *   preview_generation_error?: string | null,
 * } }} OpenRouterTtsVoicesApiResponse
 */

function getUtApi() {
	const token = process.env.UPLOADTHING_TOKEN?.trim();
	if (!token) {
		throw new Error("UPLOADTHING_TOKEN not configured");
	}
	return new UTApi({ token });
}

export function buildOpenRouterTtsVoicesBaseResponse() {
	return {
		error: null,
		data: {
			tts_engine: "openrouter",
			model: DEFAULT_OPENROUTER_TTS_MODEL,
			default_voice_id: getDefaultOpenRouterTtsVoicePresetId(),
			default_tts_voice: getDefaultOpenRouterTtsVoiceName(),
			preview_text: PREVIEW_TEXT,
			voices: GEMINI_OPENROUTER_TTS_VOICES.map((v) => ({
				id: v.id,
				tts_voice: v.voice,
				label: `${v.label} — ${v.style}`,
				gender: v.gender,
				style: v.style,
				audio_url: null,
			})),
		},
	};
}

function isNonEmptyUrl(value) {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {OpenRouterTtsVoicesApiResponse} response
 */
function allVoicesHaveAudioUrl(response) {
	const voices = response?.data?.voices;
	if (!Array.isArray(voices) || voices.length === 0) return false;
	return voices.every((v) => isNonEmptyUrl(v.audio_url));
}

function pendingPreviewCount(response) {
	return (response?.data?.voices || []).filter((v) => !isNonEmptyUrl(v.audio_url))
		.length;
}

/**
 * @param {OpenRouterTtsVoicesApiResponse} response
 */
function finalizeVoicesResponse(response) {
	const pending = pendingPreviewCount(response);
	response.data.previews_complete = pending === 0;
	response.data.previews_pending_count = pending;
	if (pending > 0 && !response.data.preview_generation_error) {
		if (!process.env.OPENROUTER_API_KEY?.trim()) {
			response.data.preview_generation_error = "OPENROUTER_API_KEY not configured";
		} else if (!process.env.UPLOADTHING_TOKEN?.trim()) {
			response.data.preview_generation_error = "UPLOADTHING_TOKEN not configured";
		}
	}
	return response;
}

/**
 * @param {OpenRouterTtsVoicesApiResponse} cached
 * @param {OpenRouterTtsVoicesApiResponse} base
 */
function mergeCachedAudioUrls(base, cached) {
	const byId = new Map(
		(cached?.data?.voices || []).map((v) => [v.id, v.audio_url]),
	);
	return {
		...base,
		data: {
			...base.data,
			voices: base.data.voices.map((v) => ({
				...v,
				audio_url: isNonEmptyUrl(byId.get(v.id)) ? String(byId.get(v.id)).trim() : null,
			})),
		},
	};
}

export async function readVoicesCacheFile() {
	try {
		const raw = await fsp.readFile(TTS_VOICES_CACHE_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (
			parsed?.data?.voices &&
			Array.isArray(parsed.data.voices) &&
			parsed.data.voices.length > 0
		) {
			return /** @type {OpenRouterTtsVoicesApiResponse} */ (parsed);
		}
	} catch (e) {
		if (e && typeof e === "object" && "code" in e && e.code !== "ENOENT") {
			console.warn("[tts-voices] cache read failed:", e);
		}
	}
	return null;
}

/**
 * @param {OpenRouterTtsVoicesApiResponse} response
 */
export async function writeVoicesCacheFile(response) {
	const dir = path.dirname(TTS_VOICES_CACHE_PATH);
	await fsp.mkdir(dir, { recursive: true });
	const payload = finalizeVoicesResponse({
		...response,
		data: { ...response.data, preview_generation_error: null },
	});
	await fsp.writeFile(
		TTS_VOICES_CACHE_PATH,
		`${JSON.stringify(payload, null, 2)}\n`,
		"utf8",
	);
}

async function uploadVoicePreviewWav(buffer, voiceId) {
	const fileName = `${voiceId}.wav`;
	const utFile = new UTFile([buffer], fileName, { type: "audio/wav" });
	const [response] = await getUtApi().uploadFiles([utFile]);
	if (response.error) {
		throw new Error(
			`UploadThing upload failed for ${voiceId}: ${response.error.message}`,
		);
	}
	return response.data.ufsUrl;
}

/**
 * @param {OpenRouterTtsVoicesApiResponse} response
 */
export async function generateMissingVoicePreviews(response) {
	if (!process.env.OPENROUTER_API_KEY?.trim()) {
		response.data.preview_generation_error = "OPENROUTER_API_KEY not configured";
		console.warn("[tts-voices] OPENROUTER_API_KEY missing; skipping preview generation");
		return response;
	}
	if (!process.env.UPLOADTHING_TOKEN?.trim()) {
		response.data.preview_generation_error = "UPLOADTHING_TOKEN not configured";
		console.warn("[tts-voices] UPLOADTHING_TOKEN missing; skipping preview generation");
		return response;
	}

	const signal = AbortSignal.timeout(600_000);
	const voices = response.data.voices;
	let changed = false;
	let lastError = null;

	const { ttsSynthesizeToBuffer, pcm16ToWavBuffer } = await import(
		"./videoTranslateOpenRouter.js"
	);

	for (let i = 0; i < voices.length; i++) {
		const row = voices[i];
		if (isNonEmptyUrl(row.audio_url)) continue;

		console.log(
			`[tts-voices] generating preview ${i + 1}/${voices.length}: ${row.id} (${row.tts_voice})`,
		);
		try {
			const { buffer } = await ttsSynthesizeToBuffer({
				text: PREVIEW_TEXT,
				voice: row.tts_voice,
				signal,
			});
			const wav = pcm16ToWavBuffer(buffer);
			const url = await uploadVoicePreviewWav(wav, row.id);
			voices[i] = { ...row, audio_url: url };
			changed = true;
			lastError = null;
			response.data.preview_generation_error = null;
			await writeVoicesCacheFile(response);
		} catch (e) {
			lastError = e?.message || String(e);
			console.error(`[tts-voices] preview failed for ${row.id}:`, lastError);
			response.data.preview_generation_error = lastError;
		}
	}

	if (changed) {
		response.data.preview_generation_error = null;
		await writeVoicesCacheFile(response);
	} else if (lastError) {
		response.data.preview_generation_error = lastError;
	}

	return response;
}

async function loadMergedVoicesResponse() {
	const base = buildOpenRouterTtsVoicesBaseResponse();
	const cached = await readVoicesCacheFile();
	return cached ? mergeCachedAudioUrls(base, cached) : base;
}

/**
 * Full catalog with `audio_url` on each voice (cached in resources/tts-voices.json).
 * @returns {Promise<OpenRouterTtsVoicesApiResponse>}
 */
export async function getOpenRouterTtsVoicesWithPreviews() {
	let merged = await loadMergedVoicesResponse();

	if (allVoicesHaveAudioUrl(merged)) {
		return finalizeVoicesResponse(merged);
	}

	if (!previewGenerationInFlight) {
		previewGenerationInFlight = (async () => {
			const snapshot = await loadMergedVoicesResponse();
			return generateMissingVoicePreviews(snapshot);
		})().finally(() => {
			previewGenerationInFlight = null;
		});
	}

	await previewGenerationInFlight;
	merged = await loadMergedVoicesResponse();
	return finalizeVoicesResponse(merged);
}

/** CLI / npm script entry — generate all missing previews without HTTP. */
export async function seedTtsVoicePreviewsFromCli() {
	console.log(`[tts-voices] cache path: ${TTS_VOICES_CACHE_PATH}`);
	const out = await getOpenRouterTtsVoicesWithPreviews();
	const pending = out.data.previews_pending_count ?? 0;
	const complete = out.data.previews_complete === true;
	console.log(
		`[tts-voices] done: ${out.data.voices.length - pending}/${out.data.voices.length} previews, complete=${complete}`,
	);
	if (out.data.preview_generation_error) {
		console.error("[tts-voices] error:", out.data.preview_generation_error);
		process.exitCode = 1;
	}
	return out;
}
