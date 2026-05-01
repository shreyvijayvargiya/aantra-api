/**
 * Video dub pipeline (Groq): FFmpeg extract audio → Whisper → (LLM or NLLB) translate → (Groq TTS or Piper) → mux.
 * Default: chat translate + Groq Orpheus TTS. Optional `translation_engine: nllb` + `glossary_refinement`, `tts_engine: piper`.
 * Async Firestore jobs in `groqVideoTranslateJobs` (separate from OpenRouter jobs).
 */
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fsp from "fs/promises";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";
import {
	mergeOpenRouterUsage,
	normalizeOpenRouterUsage,
	buildUsageResponseFields,
	publicTranslateUsageFromDoc,
} from "./openRouterUsage.js";
import {
	downloadVideoToTempFile,
	ffmpegStripAudio,
	ffmpegExtractAudioForAsr,
	ffmpegMuxWavWithVideo,
	resolvePlanCaps,
	acquireVideoJobSlot,
	releaseVideoJobSlot,
	waitForTmpSpace,
	uploadMp4Buffer,
	uploadVttFromText,
	rmDirSafe,
	MAX_VIDEO_BYTES,
} from "./videoTranslateOpenRouter.js";
import {
	getGroqApiKey,
	transcribeBufferWithGroqWhisper,
	groqTtsToWavBuffer,
} from "./groqVoiceTranslateText.js";
import { translateTextWithNllb } from "./nllbTranslate.js";
import { piperSynthesizeWav, isPiperConfigured } from "./piperTts.js";
import { refineTranslationGlossaryGroq } from "./translationRefineGlossary.js";
import {
	targetLanguageLabelToNllb,
	looseIsoToNllbSource,
	whisperIsoToNllbSource,
} from "./nmtLanguages.js";

const GROQ_JOBS_COLL = "groqVideoTranslateJobs";
const GROQ_BASE = "https://api.groq.com/openai/v1";

const GROQ_VIDEO_TIMEOUT_MS =
	Number.parseInt(process.env.GROQ_VIDEO_TIMEOUT_MS || "", 10) ||
	Number.parseInt(process.env.OPENROUTER_VIDEO_TIMEOUT_MS || "", 10) ||
	600_000;

const TMP_SPACE_BASE_BUFFER_BYTES =
	Number.parseInt(process.env.VIDEO_TRANSLATE_TMP_SPACE_BUFFER_BYTES || "", 10) ||
	256 * 1024 * 1024;

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

async function translateTranscriptForDubbing({
	text,
	targetLanguage,
	model,
	signal,
}) {
	const system = `You translate video narration for dubbing. Reply with ONLY a JSON object (no markdown): {"translation":"<full translation in ${targetLanguage}>"} The translation must be natural for spoken delivery.`;
	const user = `Transcript:\n"""${text}"""`;

	let res = await fetch(`${GROQ_BASE}/chat/completions`, {
		method: "POST",
		signal,
		headers: groqHeadersJson(),
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature: 0.2,
			response_format: { type: "json_object" },
		}),
	});

	let data = await res.json().catch(() => ({}));
	if (!res.ok || data.error) {
		const msg = String(data?.error?.message || data?.error || "");
		const retryNoRf = /response_format|json_object|unsupported/i.test(msg);
		if (retryNoRf) {
			res = await fetch(`${GROQ_BASE}/chat/completions`, {
				method: "POST",
				signal,
				headers: groqHeadersJson(),
				body: JSON.stringify({
					model,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					temperature: 0.2,
				}),
			});
			data = await res.json().catch(() => ({}));
		}
	}

	if (!res.ok || data.error) {
		throw new Error(
			String(
				data?.error?.message ||
					data?.error ||
					`Groq translate HTTP ${res.status}`,
			),
		);
	}

	const content = data?.choices?.[0]?.message?.content;
	const raw = typeof content === "string" ? content : "";
	if (!raw) throw new Error("Empty translation from Groq");

	const parsed = parseJsonObjectFromModel(raw);
	const translation = String(parsed.translation ?? "").trim();
	if (!translation) {
		throw new Error("Groq JSON must include non-empty translation");
	}

	return {
		translation,
		usage: data.usage,
	};
}

function newGroqJobId() {
	return `gq_${uuidv4().replace(/-/g, "")}`;
}

function normalizeGroqTranslationEngine(raw) {
	const s = String(raw || "llm").trim().toLowerCase();
	if (
		s === "nllb" ||
		s === "opus" ||
		s === "opus_mt" ||
		s === "marian" ||
		s === "bulk"
	) {
		return "nllb";
	}
	return "llm";
}

function normalizeGroqTtsEngine(raw) {
	const s = String(raw || "groq").trim().toLowerCase();
	if (s === "piper" || s === "local") return "piper";
	return "groq";
}

async function writeGroqJob(docId, data) {
	await firestore.collection(GROQ_JOBS_COLL).doc(docId).set(data, { merge: true });
}

async function patchGroqJob(docId, data) {
	await firestore.collection(GROQ_JOBS_COLL).doc(docId).update(data);
}

function queueProcessGroqVideoJob(jobId) {
	setImmediate(() => {
		processGroqVideoTranslateJob(jobId).catch((err) => {
			console.error(`[groqVideoTranslate] job ${jobId} failed:`, err);
			patchGroqJob(jobId, {
				status: "failed",
				error: err?.message || String(err),
				updatedAt: FieldValue.serverTimestamp(),
			}).catch(() => {});
		});
	});
}

async function processGroqVideoTranslateJob(jobId) {
	const signal = AbortSignal.timeout(GROQ_VIDEO_TIMEOUT_MS);
	await acquireVideoJobSlot(signal);
	let tmpDir;
	let bulkMtModel = null;
	try {
		const snap = await firestore.collection(GROQ_JOBS_COLL).doc(jobId).get();
		if (!snap.exists) return;
		const job = snap.data();
		const maxVideoBytes =
			Number.parseInt(String(job.max_video_bytes || ""), 10) || MAX_VIDEO_BYTES;
		const maxMinutes =
			Number.parseInt(String(job.max_minutes || ""), 10) ||
			resolvePlanCaps(job.plan).maxMinutes;

		await patchGroqJob(jobId, {
			status: "running",
			updatedAt: FieldValue.serverTimestamp(),
		});

		const { videoPath, tmpDir: tDir, buffer } = await downloadVideoToTempFile(
			job.video_url,
			signal,
			maxVideoBytes,
			maxMinutes,
		);
		tmpDir = tDir;

		const asrWavPath = path.join(tmpDir, "groq_asr.wav");
		await ffmpegExtractAudioForAsr(videoPath, asrWavPath);
		const asrBuf = await fsp.readFile(asrWavPath);

		const transEngine = normalizeGroqTranslationEngine(job.translation_engine);
		const ttsEng = normalizeGroqTtsEngine(job.tts_engine);
		const glossaryRef = job.glossary_refinement === true;

		const whisperModel =
			String(job.whisper_model || "").trim() || defaultWhisperModel();
		const asr = await transcribeBufferWithGroqWhisper({
			buffer: asrBuf,
			filename: "speech.wav",
			signal,
			model: whisperModel,
			verbose: transEngine === "nllb",
		});
		const transcript = asr.transcript;
		const whisperLang = "language" in asr ? asr.language : null;

		const chatModel =
			String(job.groq_chat_model || "").trim() || defaultChatModel();
		let translation;
		let translateUsage = null;
		if (transEngine === "nllb") {
			const tgtNllb = targetLanguageLabelToNllb(job.output_language);
			if (!tgtNllb) {
				throw new Error(
					"Target language is not supported for translation_engine nllb (see lib/nmtLanguages.js or use llm).",
				);
			}
			let srcNllb = null;
			if (
				job.transcript_source_nllb &&
				String(job.transcript_source_nllb).includes("_")
			) {
				srcNllb = String(job.transcript_source_nllb).trim();
			} else if (job.transcript_language_hint) {
				srcNllb = whisperIsoToNllbSource(
					String(job.transcript_language_hint).toLowerCase().slice(0, 2),
				);
			}
			if (!srcNllb) {
				srcNllb = looseIsoToNllbSource(whisperLang) || "eng_Latn";
			}
			const nllbOut = await translateTextWithNllb({
				text: transcript,
				srcLang: srcNllb,
				tgtLang: tgtNllb,
				signal,
			});
			translation = nllbOut.translation;
			bulkMtModel = nllbOut.model;
			if (glossaryRef) {
				const r = await refineTranslationGlossaryGroq({
					translation,
					targetLanguage: job.output_language,
					model: chatModel,
					signal,
				});
				translation = r.translation;
				translateUsage = r.usage;
			}
		} else {
			const t = await translateTranscriptForDubbing({
				text: transcript,
				targetLanguage: job.output_language,
				model: chatModel,
				signal,
			});
			translation = t.translation;
			translateUsage = t.usage;
		}

		let mergedUsage = mergeOpenRouterUsage(
			normalizeOpenRouterUsage(null),
			normalizeOpenRouterUsage(translateUsage),
		);
		const usagePayload = buildUsageResponseFields(mergedUsage);

		let ttsWavBuf;
		if (ttsEng === "piper") {
			ttsWavBuf = await piperSynthesizeWav({
				text: translation,
				modelPath: job.piper_model || null,
				signal,
			});
		} else {
			ttsWavBuf = await groqTtsToWavBuffer({
				text: translation,
				signal,
			});
		}
		const ttsPath = path.join(tmpDir, "groq_tts.wav");
		await fsp.writeFile(ttsPath, ttsWavBuf);

		const mutedPath = path.join(tmpDir, "muted_video.mp4");
		const finalPath = path.join(tmpDir, "final_output.mp4");

		await waitForTmpSpace(
			Math.floor(
				buffer.length * 1.5 + ttsWavBuf.length + TMP_SPACE_BASE_BUFFER_BYTES,
			),
			"ffmpeg mux (Groq)",
			signal,
		);
		await ffmpegStripAudio(videoPath, mutedPath);
		await ffmpegMuxWavWithVideo(mutedPath, ttsPath, finalPath);

		const finalBuf = await fsp.readFile(finalPath);
		const translatedVideoUrl = await uploadMp4Buffer(finalBuf, jobId);
		const captionUrl = await uploadVttFromText(translation, jobId).catch(
			() => null,
		);

		await patchGroqJob(jobId, {
			status: "success",
			transcript_original: transcript,
			translated_transcript: translation,
			caption_text: translation,
			translated_video_url: translatedVideoUrl,
			final_video_url: translatedVideoUrl,
			caption_url: captionUrl,
			...usagePayload,
			translation_engine: transEngine,
			tts_engine: ttsEng,
			glossary_refinement: glossaryRef,
			bulk_mt_model: bulkMtModel,
			error: null,
			status_message: null,
			updatedAt: FieldValue.serverTimestamp(),
		});
	} catch (e) {
		await patchGroqJob(jobId, {
			status: "failed",
			error: e?.message || String(e),
			updatedAt: FieldValue.serverTimestamp(),
		});
	} finally {
		if (tmpDir) await rmDirSafe(tmpDir);
		releaseVideoJobSlot();
	}
}

export async function getGroqVideoTranslateJobStatus(videoTranslateId) {
	if (!videoTranslateId || !String(videoTranslateId).trim()) {
		return {
			error: "Missing video_translate_id",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}
	const snap = await firestore
		.collection(GROQ_JOBS_COLL)
		.doc(String(videoTranslateId).trim())
		.get();
	if (!snap.exists) {
		return {
			error: null,
			data: {
				video_translate_id: videoTranslateId,
				status: "failed",
				message: "Unknown job id",
				url: null,
				caption_url: null,
				caption: null,
				usage: null,
				tokenUsage: null,
			},
			httpStatus: 404,
		};
	}
	const d = snap.data();
	const captionStr =
		d.caption_text != null && d.caption_text !== ""
			? String(d.caption_text)
			: d.translated_transcript != null
				? String(d.translated_transcript)
				: null;
	const heygenLike = {
		video_translate_id: d.id || videoTranslateId,
		title: d.title || null,
		output_language: d.output_language || null,
		status:
			d.status === "pending" || d.status === "running"
				? d.status === "pending"
					? "pending"
					: "running"
				: d.status === "success"
					? "success"
					: "failed",
		url:
			d.translated_video_url ||
			d.final_video_url ||
			d.source_video_url ||
			d.video_url ||
			null,
		caption_url: d.caption_url || null,
		caption: captionStr,
		message: d.error || d.status_message || null,
		callback_id: d.callback_id || null,
		transcript_original: d.transcript_original ?? null,
		translated_transcript: d.translated_transcript ?? null,
		source_video_url: d.source_video_url || d.video_url || null,
		...publicTranslateUsageFromDoc(d),
		engine: "groq-whisper-dub",
		pipeline: {
			translation: d.translation_engine || "llm",
			tts: d.tts_engine || "groq",
			glossary_refinement: d.glossary_refinement === true,
			bulk_mt_model: d.bulk_mt_model ?? null,
		},
	};
	return { error: null, data: heygenLike, httpStatus: 200 };
}

export async function createGroqVideoTranslateJobs({ videoUrl, body }) {
	if (!getGroqApiKey()) {
		return {
			error: "GROK_API_KEY or GROQ_API_KEY not configured",
			code: "MISSING_API_KEY",
			httpStatus: 503,
		};
	}
	if (!process.env.UPLOADTHING_TOKEN) {
		return {
			error:
				"UPLOADTHING_TOKEN not configured (required to upload dubbed video)",
			code: "MISSING_UPLOAD_TOKEN",
			httpStatus: 503,
		};
	}

	const video_url = String(videoUrl || "").trim();
	const langs = body.output_language
		? [body.output_language]
		: Array.isArray(body.output_languages)
			? body.output_languages
			: [];

	if (!video_url) {
		return {
			error:
				"Provide video_url (or videoUrl) or upload a video file (field: file or video)",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}
	if (!langs.length) {
		return {
			error: "Provide output_language or output_languages",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const { plan, maxVideoBytes, maxMinutes } = resolvePlanCaps(
		body.plan ?? body.user_plan ?? body.subscription_plan ?? body.tier,
	);

	const rawLlm = body.model ?? body.llm_model;
	const groqChatModel =
		rawLlm != null && String(rawLlm).trim() !== ""
			? String(rawLlm).trim()
			: defaultChatModel();
	const whisperModel = defaultWhisperModel();
	const ttsModel =
		process.env.GROQ_TTS_MODEL?.trim() || "canopylabs/orpheus-v1-english";

	const translation_engine = normalizeGroqTranslationEngine(
		body.translation_engine,
	);
	const tts_engine = normalizeGroqTtsEngine(body.tts_engine);
	const glossary_refinement =
		body.glossary_refinement === true ||
		body.glossary_refinement === "true" ||
		body.glossary_refinement === "1";
	const piper_model = body.piper_model
		? String(body.piper_model).trim()
		: null;
	const transcript_source_nllb =
		body.source_nllb != null && String(body.source_nllb).includes("_")
			? String(body.source_nllb).trim()
			: null;
	const transcript_language_hint =
		body.transcript_language != null
			? String(body.transcript_language).trim()
			: body.source_language != null
				? String(body.source_language).trim()
				: null;

	if (translation_engine === "nllb") {
		for (const lang of langs) {
			if (!targetLanguageLabelToNllb(String(lang))) {
				return {
					error: `output_language "${lang}" is not supported for translation_engine nllb (extend lib/nmtLanguages.js or use translation_engine llm).`,
					code: "BAD_REQUEST",
					httpStatus: 400,
				};
			}
		}
	}
	if (tts_engine === "piper" && !piper_model && !isPiperConfigured()) {
		return {
			error:
				"Piper TTS requires PIPER_MODEL in the environment or piper_model in the request body.",
			code: "MISSING_PIPER_MODEL",
			httpStatus: 503,
		};
	}

	const baseMeta = {
		video_url,
		title: body.title || null,
		callback_id: body.callback_id || null,
		plan,
		max_video_bytes: maxVideoBytes,
		max_minutes: maxMinutes,
		groq_chat_model: groqChatModel,
		whisper_model: whisperModel,
		tts_model: ttsModel,
		translation_engine,
		tts_engine,
		glossary_refinement,
		piper_model: piper_model || null,
		transcript_source_nllb,
		transcript_language_hint: transcript_language_hint || null,
	};

	const ids = [];
	for (const output_language of langs) {
		const id = newGroqJobId();
		await writeGroqJob(id, {
			id,
			status: "pending",
			video_url,
			source_video_url: video_url,
			output_language: String(output_language),
			...baseMeta,
			createdAt: FieldValue.serverTimestamp(),
			updatedAt: FieldValue.serverTimestamp(),
		});
		ids.push(id);
		queueProcessGroqVideoJob(id);
	}

	const pipeline = {
		translation: translation_engine,
		tts: tts_engine,
		glossary_refinement,
	};
	if (ids.length === 1) {
		return {
			error: null,
			data: {
				video_translate_id: ids[0],
				video_translate_ids: null,
				engine: "groq-whisper-dub",
				pipeline,
			},
			httpStatus: 200,
		};
	}
	return {
		error: null,
		data: {
			video_translate_id: null,
			video_translate_ids: ids,
			engine: "groq-whisper-dub",
			pipeline,
		},
		httpStatus: 200,
	};
}
