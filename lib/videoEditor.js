/**
 * Short-form video editor API: AI generate → frames[] timeline → FFmpeg export (MP4 bytes).
 * No UploadThing. Max ~10 minutes / 25 frames.
 */
import { v4 as uuidv4 } from "uuid";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";
import {
	runBlogToVideoGenerationPipeline,
	scrapeBlogContent,
	pickCenterContent,
	renderSceneClip,
	synthesizeSegmentAudio,
	concatMediaFiles,
	muxVideoAudio,
	rmDirSafe,
	parseVideoStyleFromBody,
	DEFAULT_VIDEO_STYLE,
	VIDEO_STYLE_THEME_PRESETS,
} from "./blogToVideo.js";
import {
	buildUsageResponseFields,
	mergeOpenRouterUsage,
	normalizeOpenRouterUsage,
	publicTranslateUsageFromDoc,
} from "./openRouterUsage.js";
import { resolveTranslateLlmModel, TRANSLATE_LLM_PRESETS } from "./translateLlmModels.js";
import {
	logOpenRouterErrorDev,
	jobFailureFieldsFromError,
	publicJobErrorFromDoc,
} from "./openRouterErrors.js";
import { resolveOpenRouterTtsVoice } from "./openRouterTtsVoices.js";
import { execFfmpeg } from "./videoTranslateOpenRouter.js";

/** Firestore doc ~1 MiB; base64 + metadata → cap stored audio binary size. */
const MAX_FRAME_AUDIO_BYTES =
	Number.parseInt(process.env.VIDEO_EDITOR_MAX_AUDIO_BYTES || "", 10) || 700_000;

/** Split long narrations before TTS (~35–45s speech per frame). */
const MAX_NARRATION_CHARS_PER_FRAME =
	Number.parseInt(process.env.VIDEO_EDITOR_MAX_NARRATION_CHARS || "", 10) || 420;

const OPENROUTER_TIMEOUT_MS =
	Number.parseInt(process.env.VIDEO_EDITOR_TIMEOUT_MS || "", 10) ||
	Number.parseInt(process.env.OPENROUTER_VIDEO_TIMEOUT_MS || "", 10) ||
	900_000;

/** Max target duration clients may request (10 minutes). */
export const VIDEO_EDITOR_MAX_DURATION_SEC = 600;
export const VIDEO_EDITOR_DEFAULT_DURATION_SEC = 180;
export const VIDEO_EDITOR_MAX_FRAMES =
	Number.parseInt(process.env.VIDEO_EDITOR_MAX_FRAMES || "", 10) || 50;
export const VIDEO_EDITOR_FPS = 30;

const DEFAULT_WIDTH =
	Number.parseInt(process.env.VIDEO_EDITOR_WIDTH || "", 10) ||
	Number.parseInt(process.env.BLOG_TO_VIDEO_WIDTH || "", 10) ||
	1920;
const DEFAULT_HEIGHT =
	Number.parseInt(process.env.VIDEO_EDITOR_HEIGHT || "", 10) ||
	Number.parseInt(process.env.BLOG_TO_VIDEO_HEIGHT || "", 10) ||
	1080;

function getOpenRouterKey() {
	return process.env.OPENROUTER_API_KEY?.trim() || "";
}

function stripUndefinedDeep(value) {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (Array.isArray(value)) return value.map((item) => stripUndefinedDeep(item));
	if (typeof value === "object") {
		if (value.constructor && value.constructor !== Object) return value;
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (v === undefined) continue;
			out[k] = stripUndefinedDeep(v);
		}
		return out;
	}
	return value;
}

async function writeProject(docId, data) {
	await firestore
		.collection(JOBS_COLL)
		.doc(docId)
		.set(stripUndefinedDeep(data), { merge: true });
}

async function patchProject(docId, data) {
	await firestore.collection(JOBS_COLL).doc(docId).update(stripUndefinedDeep(data));
}

function newProjectId() {
	return `ve_${uuidv4().replace(/-/g, "")}`;
}

function parsePositiveInt(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
	if (raw == null || String(raw).trim() === "") return fallback;
	const n = Number.parseInt(String(raw), 10);
	if (!Number.isFinite(n) || n < min) return fallback;
	return Math.min(max, n);
}

function resolveDimensions(body) {
	const aspect = String(body.aspect ?? body.target_aspect ?? body.targetAspect ?? "")
		.trim()
		.toLowerCase();
	if (aspect === "9:16" || aspect === "vertical" || aspect === "portrait") {
		return { width: 1080, height: 1920 };
	}
	if (aspect === "1:1" || aspect === "square") {
		return { width: 1080, height: 1080 };
	}
	const w = parsePositiveInt(body.width, DEFAULT_WIDTH, { min: 320, max: 3840 });
	const h = parsePositiveInt(body.height, DEFAULT_HEIGHT, { min: 320, max: 3840 });
	return { width: w, height: h };
}

function resolveBlogModel(raw) {
	if (raw != null && String(raw).trim() !== "") {
		const r = resolveTranslateLlmModel(raw);
		if (!r.ok) return r;
		return { ok: true, openrouterId: r.openrouterId, preset: r.preset };
	}
	return {
		ok: true,
		openrouterId:
			process.env.VIDEO_EDITOR_LLM_MODEL?.trim() ||
			process.env.BLOG_TO_VIDEO_LLM_MODEL?.trim() ||
			TRANSLATE_LLM_PRESETS.gemini,
		preset: "gemini",
	};
}

function defaultLayoutRatios(width, height) {
	const portrait = height > width;
	return portrait
		? {
				centerY: 0.16,
				centerFontSize: Math.max(26, Math.floor(Math.min(width, height) * 0.034)),
				centerMaxLines: 4,
				waveY: 0.5,
				waveWidth: 0.86,
				waveHeight: 0.14,
				captionY: 0.885,
				captionFontSize: Math.max(20, Math.floor(Math.min(width, height) * 0.024)),
				captionMaxLines: 2,
			}
		: {
				centerY: 0.14,
				centerFontSize: Math.max(24, Math.floor(Math.min(width, height) * 0.028)),
				centerMaxLines: 5,
				waveY: 0.52,
				waveWidth: 0.62,
				waveHeight: 0.12,
				captionY: 0.86,
				captionFontSize: Math.max(18, Math.floor(Math.min(width, height) * 0.02)),
				captionMaxLines: 2,
			};
}

function hexFromTheme(theme) {
	const map = {
		dark_blue: "#1a1a2e",
		dark: "#0f0f0f",
		light: "#f0f0f0",
		minimal: "#2d2d2d",
		tech: "#0d1117",
		gradient_blue: "#16213e",
	};
	return map[theme] || map.dark_blue;
}

function themeTextColors(theme) {
	const isLight = theme === "light";
	return {
		center: isLight ? "#1a1a2e" : "#ffffff",
		caption: isLight ? "#212121" : "#eceff1",
		wave: isLight ? ["#0288d1", "#4fc3f7"] : ["#4fc3f7", "#81d4fa"],
		captionBox: isLight ? "rgba(255,255,255,0.72)" : "rgba(0,0,0,0.55)",
	};
}

/** Build editor layer list from global video_style (POST body style). */
export function buildFrameStyleFromVideoStyle(videoStyle, width, height) {
	const theme = videoStyle?.theme || DEFAULT_VIDEO_STYLE.theme;
	const colors = themeTextColors(theme);
	const layout = defaultLayoutRatios(width, height);
	const bgColor =
		videoStyle?.background?.color || hexFromTheme(theme);
	const waveColors =
		Array.isArray(videoStyle?.waveform?.colors) && videoStyle.waveform.colors.length
			? videoStyle.waveform.colors
			: colors.wave;

	return {
		background: {
			color: bgColor,
			theme,
		},
		layers: [
			{
				id: "center_text",
				type: "text",
				x: 0.5,
				y: videoStyle?.centerText?.yRatio ?? layout.centerY,
				anchor: "center",
				width: 0.9,
				font_size: videoStyle?.centerText?.fontSize ?? layout.centerFontSize,
				color: videoStyle?.centerText?.color || colors.center,
				max_lines: videoStyle?.centerText?.maxLines ?? layout.centerMaxLines,
			},
			{
				id: "waveform",
				type: "waveform",
				x: 0.5,
				y: videoStyle?.waveform?.yRatio ?? layout.waveY,
				width: videoStyle?.waveform?.widthRatio ?? layout.waveWidth,
				height: videoStyle?.waveform?.heightRatio ?? layout.waveHeight,
				colors: waveColors,
				mode: videoStyle?.waveform?.mode || "cline",
			},
			{
				id: "caption",
				type: "caption",
				x: 0.5,
				y: videoStyle?.caption?.yRatio ?? layout.captionY,
				anchor: "center",
				width: 0.92,
				font_size: videoStyle?.caption?.fontSize ?? layout.captionFontSize,
				color: videoStyle?.caption?.color || colors.caption,
				max_lines: videoStyle?.caption?.maxLines ?? layout.captionMaxLines,
				box: {
					enabled: videoStyle?.caption?.box?.enabled !== false,
					color: videoStyle?.caption?.box?.color || colors.captionBox,
					padding: videoStyle?.caption?.box?.padding ?? 10,
				},
			},
		],
	};
}

function mergeFrameStyle(frameStyle, globalStyle, width, height) {
	const base = buildFrameStyleFromVideoStyle(globalStyle, width, height);
	if (!frameStyle || typeof frameStyle !== "object") return base;
	return {
		background: {
			color: frameStyle.background?.color ?? base.background.color,
			theme: frameStyle.background?.theme ?? base.background.theme,
		},
		layers: Array.isArray(frameStyle.layers) && frameStyle.layers.length
			? frameStyle.layers
			: base.layers,
	};
}

/** Convert editor frame.style layers → videoStyle for FFmpeg renderer. */
export function frameStyleToVideoStyle(frameStyle, globalStyle) {
	const theme = frameStyle?.background?.theme ?? globalStyle?.theme ?? "dark_blue";
	const layers = frameStyle?.layers ?? [];
	const wave = layers.find((l) => l.type === "waveform");
	const caption = layers.find((l) => l.type === "caption");
	const center = layers.find(
		(l) => l.id === "center_text" || (l.type === "text" && l.id !== "caption"),
	);

	return {
		theme,
		background: {
			color: frameStyle?.background?.color ?? globalStyle?.background?.color ?? null,
		},
		waveform: {
			colors: wave?.colors ?? globalStyle?.waveform?.colors ?? null,
			widthRatio: wave?.width ?? globalStyle?.waveform?.widthRatio ?? null,
			heightRatio: wave?.height ?? globalStyle?.waveform?.heightRatio ?? null,
			yRatio: wave?.y ?? globalStyle?.waveform?.yRatio ?? null,
			mode: wave?.mode ?? globalStyle?.waveform?.mode ?? "cline",
		},
		centerText: {
			color: center?.color ?? globalStyle?.centerText?.color ?? null,
			fontSize: center?.font_size ?? globalStyle?.centerText?.fontSize ?? null,
			yRatio: center?.y ?? globalStyle?.centerText?.yRatio ?? null,
			maxLines: center?.max_lines ?? globalStyle?.centerText?.maxLines ?? null,
		},
		caption: {
			color: caption?.color ?? globalStyle?.caption?.color ?? null,
			fontSize: caption?.font_size ?? globalStyle?.caption?.fontSize ?? null,
			yRatio: caption?.y ?? globalStyle?.caption?.yRatio ?? null,
			maxLines: caption?.max_lines ?? globalStyle?.caption?.maxLines ?? null,
			box: {
				enabled: caption?.box?.enabled ?? globalStyle?.caption?.box?.enabled ?? true,
				color: caption?.box?.color ?? globalStyle?.caption?.box?.color ?? null,
				padding: caption?.box?.padding ?? globalStyle?.caption?.box?.padding ?? 10,
			},
		},
	};
}

function frameToScene(frame) {
	const lines = Array.isArray(frame.content?.lines) ? frame.content.lines : [];
	return {
		sceneId: String(frame.id),
		visualType: frame.visual_type || "podcast",
		backgroundTheme: frame.style?.background?.theme || "dark_blue",
		title: String(frame.content?.title ?? "").trim(),
		elements: lines.map((label) => ({
			type: "text",
			label: String(label),
		})),
	};
}

function frameToStrat(frame) {
	return {
		id: String(frame.id),
		title: String(frame.content?.title ?? "").trim(),
		narration: String(frame.content?.narration ?? "").trim(),
	};
}

const JOBS_COLL = "videoEditorProjects";
const FRAMES_SUBCOLL = "frames";

/** Split long narration into TTS-sized chunks (sentence-aware). */
function splitNarrationIntoChunks(text, maxChars = MAX_NARRATION_CHARS_PER_FRAME) {
	const t = String(text ?? "").trim();
	if (!t || t.length <= maxChars) return t ? [t] : [];

	const parts = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [t];
	const chunks = [];
	let current = "";

	for (const part of parts) {
		const sentence = part.trim();
		if (!sentence) continue;
		const candidate = current ? `${current} ${sentence}` : sentence;
		if (candidate.length <= maxChars) {
			current = candidate;
			continue;
		}
		if (current) chunks.push(current);
		if (sentence.length <= maxChars) {
			current = sentence;
			continue;
		}
		for (let i = 0; i < sentence.length; i += maxChars) {
			chunks.push(sentence.slice(i, i + maxChars).trim());
		}
		current = "";
	}
	if (current) chunks.push(current);
	return chunks.filter(Boolean);
}

function expandSegmentsForFrames(segments) {
	const out = [];
	for (const segment of segments) {
		const chunks = splitNarrationIntoChunks(segment.narration);
		if (!chunks.length) continue;
		for (let c = 0; c < chunks.length; c++) {
			const multi = chunks.length > 1;
			out.push({
				...segment,
				id: multi ? `${segment.id}_p${c + 1}` : segment.id,
				title: multi
					? `${segment.title || segment.id} (${c + 1}/${chunks.length})`
					: segment.title,
				narration: chunks[c],
			});
		}
	}
	return out.slice(0, VIDEO_EDITOR_MAX_FRAMES);
}

/** WAV → MP3 when needed so audio fits in Firestore frame docs. */
async function encodeAudioForFirestore(wavPath, tmpDir, label) {
	let buffer = await fsp.readFile(wavPath);
	if (buffer.length <= MAX_FRAME_AUDIO_BYTES) {
		return { buffer, format: "wav" };
	}

	const mp3Path = path.join(tmpDir, `${label}.mp3`);
	for (const bitrate of ["128k", "96k", "64k"]) {
		await execFfmpeg(
			["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-b:a", bitrate, mp3Path],
			`compress frame audio ${bitrate}`,
		);
		buffer = await fsp.readFile(mp3Path);
		if (buffer.length <= MAX_FRAME_AUDIO_BYTES) {
			return { buffer, format: "mp3" };
		}
	}

	throw new Error(
		`Frame audio still too large after compression (${Math.round(buffer.length / 1024)}KB). ` +
			"Shorten narration or reduce target_duration.",
	);
}

async function writeFrameAudioToPath(frame, outPath, tmpDir, index) {
	const buf = await resolveFrameAudioBuffer(frame);
	const format = frame.audio?.format || "wav";
	if (format === "mp3") {
		const inPath = path.join(tmpDir, `frame_in_${index}.mp3`);
		await fsp.writeFile(inPath, buf);
		await execFfmpeg(
			["-y", "-i", inPath, "-ar", "24000", "-ac", "1", outPath],
			"decode frame mp3 to wav",
		);
		return;
	}
	await fsp.writeFile(outPath, buf);
}

async function saveFramesSubcollection(projectId, frames) {
	const coll = firestore.collection(JOBS_COLL).doc(projectId).collection(FRAMES_SUBCOLL);
	// Firestore batch max 500 ops; max frames is 25.
	const batch = firestore.batch();
	for (const frame of frames) {
		batch.set(coll.doc(String(frame.id)), frame, { merge: true });
	}
	await batch.commit();
}

async function loadFramesSubcollection(projectId) {
	const snap = await firestore
		.collection(JOBS_COLL)
		.doc(projectId)
		.collection(FRAMES_SUBCOLL)
		.get();
	if (snap.empty) return null;
	return snap.docs
		.map((d) => d.data())
		.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

function buildFrame({
	index,
	startMs,
	durationMs,
	segment,
	scene,
	audioBase64,
	audioFormat,
	videoStyle,
	width,
	height,
}) {
	const lines = pickCenterContent(scene, segment);
	return {
		id: segment.id || `frame_${index + 1}`,
		name: segment.title || scene.title || `Frame ${index + 1}`,
		order: index,
		start_ms: startMs,
		duration_ms: durationMs,
		visual_type: scene.visualType || "podcast",
		content: {
			title: segment.title || scene.title || "",
			narration: segment.narration,
			lines,
		},
		audio: {
			format: audioFormat || "wav",
			duration_ms: durationMs,
			data_base64: audioBase64,
		},
		style: buildFrameStyleFromVideoStyle(videoStyle, width, height),
	};
}

async function resolveFrameAudioBuffer(frame) {
	if (frame.audio?.data_base64) {
		return Buffer.from(frame.audio.data_base64, "base64");
	}
	throw new Error(
		`Frame ${frame.id ?? "?"} has no audio.data_base64 — re-export must include audio from the editor state`,
	);
}

export async function createVideoEditorProject({ body = {} }) {
	if (!getOpenRouterKey()) {
		return {
			error: "OPENROUTER_API_KEY not configured",
			code: "MISSING_API_KEY",
			httpStatus: 503,
		};
	}

	const url = String(body.url ?? body.blog_url ?? body.blogUrl ?? "").trim();
	const inlineContent = String(body.content ?? body.article ?? "").trim();
	if (!url && !inlineContent) {
		return {
			error: "Provide url (blog URL to scrape) or content (raw article text/markdown)",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const modelRes = resolveBlogModel(body.model ?? body.llm_model);
	if (!modelRes.ok) {
		return {
			error: modelRes.error,
			code: "BAD_REQUEST",
			details: { allowed_models: modelRes.allowed },
			httpStatus: 400,
		};
	}

	const voiceRes = resolveOpenRouterTtsVoice({
		tts_voice: body.tts_voice ?? body.ttsVoice,
		voice_id: body.voice_id ?? body.voiceId,
		brand_voice_id: body.brand_voice_id ?? body.brandVoiceId,
	});
	if (!voiceRes.ok) {
		return {
			error: voiceRes.error,
			code: "BAD_REQUEST",
			details: voiceRes.details,
			httpStatus: voiceRes.httpStatus ?? 400,
		};
	}

	const styleRes = parseVideoStyleFromBody(body.style ?? body.video_style);
	if (!styleRes.ok) {
		return {
			error: styleRes.error,
			code: styleRes.code,
			httpStatus: styleRes.httpStatus ?? 400,
		};
	}

	const targetDuration = parsePositiveInt(
		body.target_duration ?? body.targetDuration,
		VIDEO_EDITOR_DEFAULT_DURATION_SEC,
		{ min: 15, max: VIDEO_EDITOR_MAX_DURATION_SEC },
	);
	const language = String(body.language ?? "english").trim();
	const { width, height } = resolveDimensions(body);

	const id = newProjectId();
	await writeProject(id, {
		id,
		status: "pending",
		source_url: url || null,
		inline_content: inlineContent || null,
		target_duration_sec: targetDuration,
		language,
		width,
		height,
		fps: VIDEO_EDITOR_FPS,
		video_style: styleRes.style,
		tts_voice: voiceRes.voice,
		tts_voice_id: voiceRes.voice_id,
		llm_model: modelRes.openrouterId,
		llm_preset: modelRes.preset,
		createdAt: FieldValue.serverTimestamp(),
		updatedAt: FieldValue.serverTimestamp(),
	});

	queueProcessVideoEditorProject(id);

	return {
		error: null,
		data: { project_id: id, status: "pending" },
		httpStatus: 200,
	};
}

function queueProcessVideoEditorProject(projectId) {
	setImmediate(() => {
		processVideoEditorProject(projectId).catch((err) => {
			logOpenRouterErrorDev("videoEditor", err);
			console.error(`[videoEditor] project ${projectId} failed:`, err?.message || err);
			const fields = jobFailureFieldsFromError(err, { feature: "blog_to_video" });
			patchProject(projectId, {
				...fields,
				updatedAt: FieldValue.serverTimestamp(),
			}).catch(() => {});
		});
	});
}

async function processVideoEditorProject(projectId) {
	const signal = AbortSignal.timeout(OPENROUTER_TIMEOUT_MS);
	let tmpDir;
	try {
		const snap = await firestore.collection(JOBS_COLL).doc(projectId).get();
		if (!snap.exists) return;
		const job = snap.data();

		await patchProject(projectId, {
			status: "scraping",
			updatedAt: FieldValue.serverTimestamp(),
		});

		let content = String(job.inline_content ?? "").trim();
		if (!content) {
			const scraped = await scrapeBlogContent(job.source_url, signal);
			content = scraped.content;
		}

		await patchProject(projectId, {
			status: "generating",
			updatedAt: FieldValue.serverTimestamp(),
		});

		const pipeline = await runBlogToVideoGenerationPipeline({
			content,
			targetDuration: job.target_duration_sec ?? VIDEO_EDITOR_DEFAULT_DURATION_SEC,
			language: job.language || "english",
			model: job.llm_model,
			signal,
		});

		await patchProject(projectId, {
			status: "synthesizing",
			title: pipeline.strategist.title || null,
			summary: pipeline.strategist.summary || null,
			updatedAt: FieldValue.serverTimestamp(),
		});

		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ve-"));
		const sceneById = new Map(pipeline.renderPlan.map((s) => [s.sceneId, s]));

		const frames = [];
		let cursorMs = 0;
		let mergedTtsUsage = normalizeOpenRouterUsage(pipeline.usage);
		const videoStyle = job.video_style || DEFAULT_VIDEO_STYLE;
		const width = job.width ?? DEFAULT_WIDTH;
		const height = job.height ?? DEFAULT_HEIGHT;

		const segments = expandSegmentsForFrames(pipeline.strategist.segments);

		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i];
			const narration = String(segment.narration ?? "").trim();
			if (!narration) continue;

			const baseSceneId = String(segment.id).replace(/_p\d+$/, "");
			const scene = sceneById.get(baseSceneId) ||
				sceneById.get(segment.id) || {
					sceneId: baseSceneId,
					visualType: "podcast",
					backgroundTheme: "dark_blue",
					title: segment.title,
					elements: [],
				};

			const { wavPath, durationSec, usage } = await synthesizeSegmentAudio({
				narration,
				voice: job.tts_voice,
				signal,
				tmpDir,
				index: i,
			});
			mergedTtsUsage = mergeOpenRouterUsage(mergedTtsUsage, usage);

			const durationMs = Math.round(Math.max(1, durationSec) * 1000);
			const { buffer: audioBuf, format: audioFormat } = await encodeAudioForFirestore(
				wavPath,
				tmpDir,
				`frame_${i}`,
			);
			const audioBase64 = audioBuf.toString("base64");

			frames.push(
				buildFrame({
					index: frames.length,
					startMs: cursorMs,
					durationMs,
					segment,
					scene,
					audioBase64,
					audioFormat,
					videoStyle,
					width,
					height,
				}),
			);
			cursorMs += durationMs;
		}

		if (!frames.length) {
			throw new Error("No frames generated (empty narration)");
		}

		await saveFramesSubcollection(projectId, frames);

		const usagePayload = buildUsageResponseFields(mergedTtsUsage);
		const project = {
			width,
			height,
			fps: VIDEO_EDITOR_FPS,
			duration_ms: cursorMs,
			title: pipeline.strategist.title || null,
			summary: pipeline.strategist.summary || null,
			global_style: videoStyle,
		};

		await patchProject(projectId, {
			status: "ready",
			project,
			frame_count: frames.length,
			segments: pipeline.strategist.segments,
			render_plan: pipeline.renderPlan,
			script: pipeline.strategist.script || null,
			duration_ms: cursorMs,
			...usagePayload,
			error: null,
			updatedAt: FieldValue.serverTimestamp(),
		});
	} catch (e) {
		logOpenRouterErrorDev("videoEditor", e);
		const fields = jobFailureFieldsFromError(e, { feature: "blog_to_video" });
		await patchProject(projectId, {
			...fields,
			updatedAt: FieldValue.serverTimestamp(),
		});
	} finally {
		if (tmpDir) await rmDirSafe(tmpDir);
	}
}

export async function getVideoEditorProject(projectId, { lite = false, includeAudio = true } = {}) {
	const id = String(projectId || "").trim();
	if (!id) {
		return {
			error: "Missing project_id",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const snap = await firestore.collection(JOBS_COLL).doc(id).get();
	if (!snap.exists) {
		return {
			error: "Unknown project_id",
			code: "NOT_FOUND",
			httpStatus: 404,
		};
	}

	const d = snap.data();
	const errFields = publicJobErrorFromDoc(d, { feature: "blog_to_video" });
	const status = d.status || "pending";

	if (lite) {
		const frameCount =
			Number(d.frame_count) ||
			(Array.isArray(d.frames) ? d.frames.length : 0);
		return {
			error: null,
			data: {
				project_id: id,
				status,
				frame_count: frameCount,
				duration_ms: d.duration_ms ?? d.project?.duration_ms ?? null,
				title: d.title ?? d.project?.title ?? null,
				width: d.width ?? d.project?.width ?? null,
				height: d.height ?? d.project?.height ?? null,
				error: errFields.error,
				error_code: errFields.error_code,
				user_message: errFields.user_message,
				...(errFields.error_retryable != null
					? { error_retryable: errFields.error_retryable }
					: {}),
			},
			httpStatus: 200,
		};
	}

	let frames = null;
	if (status === "ready") {
		frames = (await loadFramesSubcollection(id)) ?? d.frames ?? [];
		if (!includeAudio) {
			frames = frames.map((f) => ({
				...f,
				audio: f.audio
					? {
							format: f.audio.format,
							duration_ms: f.audio.duration_ms,
							data_base64: null,
							has_audio: Boolean(f.audio.data_base64),
						}
					: null,
			}));
		}
	}

	const data = {
		project_id: id,
		status,
		project: d.project ?? null,
		frames,
		global_style: d.video_style ?? d.project?.global_style ?? DEFAULT_VIDEO_STYLE,
		style_themes: VIDEO_STYLE_THEME_PRESETS,
		title: d.title ?? d.project?.title ?? null,
		summary: d.summary ?? d.project?.summary ?? null,
		script: d.script ?? null,
		segments: d.segments ?? null,
		duration_ms: d.duration_ms ?? d.project?.duration_ms ?? null,
		target_duration_sec: d.target_duration_sec ?? null,
		width: d.width ?? d.project?.width ?? null,
		height: d.height ?? d.project?.height ?? null,
		fps: d.fps ?? VIDEO_EDITOR_FPS,
		max_duration_sec: VIDEO_EDITOR_MAX_DURATION_SEC,
		max_frames: VIDEO_EDITOR_MAX_FRAMES,
		error: errFields.error,
		error_code: errFields.error_code,
		user_message: errFields.user_message,
		...(errFields.error_detail ? { error_detail: errFields.error_detail } : {}),
		...(errFields.error_retryable != null
			? { error_retryable: errFields.error_retryable }
			: {}),
		...publicTranslateUsageFromDoc(d),
		engine: "openrouter-video-editor-frames",
	};

	return { error: null, data, httpStatus: 200 };
}

/** Fetch one frame's WAV base64 (avoids loading all audio in one GET). */
export async function getVideoEditorFrameAudio(projectId, frameId) {
	const id = String(projectId || "").trim();
	const fid = String(frameId || "").trim();
	if (!id || !fid) {
		return {
			error: "Missing project_id or frame_id",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const snap = await firestore.collection(JOBS_COLL).doc(id).get();
	if (!snap.exists) {
		return { error: "Unknown project_id", code: "NOT_FOUND", httpStatus: 404 };
	}

	const d = snap.data();
	if (d.status !== "ready") {
		return {
			error: "Project not ready",
			code: "NOT_READY",
			httpStatus: 409,
		};
	}

	const frameSnap = await firestore
		.collection(JOBS_COLL)
		.doc(id)
		.collection(FRAMES_SUBCOLL)
		.doc(fid)
		.get();

	const frame = frameSnap.exists
		? frameSnap.data()
		: (d.frames ?? []).find((f) => String(f.id) === fid);

	if (!frame?.audio?.data_base64) {
		return { error: "Frame audio not found", code: "NOT_FOUND", httpStatus: 404 };
	}

	return {
		error: null,
		data: {
			project_id: id,
			frame_id: fid,
			audio: {
				format: frame.audio.format || "wav",
				duration_ms: frame.audio.duration_ms,
				data_base64: frame.audio.data_base64,
			},
		},
		httpStatus: 200,
	};
}

function mergeClientFramesWithStored(storedFrames, clientFrames) {
	const storedById = new Map(storedFrames.map((f) => [String(f.id), f]));
	const source = clientFrames?.length ? clientFrames : storedFrames;
	const merged = [];

	for (let i = 0; i < source.length; i++) {
		const cf = source[i];
		const id = String(cf.id ?? `frame_${i + 1}`);
		const stored = storedById.get(id);
		const audio =
			cf.audio?.data_base64 != null && String(cf.audio.data_base64).trim()
				? cf.audio
				: stored?.audio;

		merged.push({
			...(stored || {}),
			...cf,
			id,
			order: cf.order ?? stored?.order ?? i,
			duration_ms: cf.duration_ms ?? stored?.duration_ms ?? cf.audio?.duration_ms,
			content: {
				...(stored?.content || {}),
				...(cf.content || {}),
			},
			style: cf.style ?? stored?.style,
			audio,
		});
	}

	return merged.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

async function resolveExportPayload(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "Request body must be a JSON object", httpStatus: 400 };
	}

	const projectId = String(body.project_id ?? body.projectId ?? "").trim();
	let storedFrames = null;
	let storedProject = null;
	let globalStyle = body.global_style ?? body.style ?? DEFAULT_VIDEO_STYLE;

	if (projectId) {
		const snap = await firestore.collection(JOBS_COLL).doc(projectId).get();
		if (!snap.exists) {
			return { ok: false, error: "Unknown project_id", code: "NOT_FOUND", httpStatus: 404 };
		}
		const d = snap.data();
		if (d.status !== "ready") {
			return {
				ok: false,
				error: "Project not ready for export",
				code: "NOT_READY",
				httpStatus: 409,
			};
		}
		storedFrames = (await loadFramesSubcollection(projectId)) ?? d.frames ?? [];
		storedProject = d.project ?? {
			width: d.width,
			height: d.height,
			fps: d.fps ?? VIDEO_EDITOR_FPS,
		};
		globalStyle =
			body.global_style ?? body.style ?? d.video_style ?? d.project?.global_style ?? globalStyle;
	}

	const project = body.project ?? storedProject;
	if (!project || typeof project !== "object") {
		return {
			ok: false,
			error: "project is required (or provide project_id to load from server)",
			httpStatus: 400,
		};
	}

	const clientFrames = Array.isArray(body.frames) ? body.frames : null;
	if (!clientFrames?.length && !storedFrames?.length) {
		return { ok: false, error: "frames must be a non-empty array", httpStatus: 400 };
	}

	const merged = mergeClientFramesWithStored(storedFrames ?? clientFrames ?? [], clientFrames ?? []);

	if (!merged.length) {
		return { ok: false, error: "No frames to export", httpStatus: 400 };
	}
	if (merged.length > VIDEO_EDITOR_MAX_FRAMES) {
		return {
			ok: false,
			error: `Too many frames (max ${VIDEO_EDITOR_MAX_FRAMES})`,
			httpStatus: 400,
		};
	}

	const width = parsePositiveInt(project.width, 1080, { min: 320, max: 3840 });
	const height = parsePositiveInt(project.height, 1920, { min: 320, max: 3840 });
	const fps = parsePositiveInt(project.fps, VIDEO_EDITOR_FPS, { min: 15, max: 60 });

	let totalMs = 0;
	const normalized = [];

	for (let i = 0; i < merged.length; i++) {
		const f = merged[i];
		const narration = String(f.content?.narration ?? "").trim();
		const audioB64 = String(f.audio?.data_base64 ?? "").trim();
		if (!audioB64) {
			return {
				ok: false,
				error: `Frame ${f.id ?? i} missing audio (use project_id so server loads audio from Firestore)`,
				httpStatus: 400,
			};
		}
		const durationMs =
			Number(f.duration_ms) || Number(f.audio?.duration_ms) || 0;
		if (!Number.isFinite(durationMs) || durationMs <= 0) {
			return {
				ok: false,
				error: `Frame ${f.id ?? i} missing valid duration_ms`,
				httpStatus: 400,
			};
		}
		totalMs += durationMs;
		normalized.push({
			...f,
			order: i,
			id: String(f.id ?? `frame_${i + 1}`),
			duration_ms: durationMs,
			content: {
				title: String(f.content?.title ?? "").trim(),
				narration,
				lines: Array.isArray(f.content?.lines) ? f.content.lines.map(String) : [],
			},
			style: mergeFrameStyle(f.style, globalStyle, width, height),
		});
	}

	if (totalMs > VIDEO_EDITOR_MAX_DURATION_SEC * 1000) {
		return {
			ok: false,
			error: `Total duration exceeds ${VIDEO_EDITOR_MAX_DURATION_SEC}s limit`,
			httpStatus: 400,
		};
	}

	return {
		ok: true,
		project: { width, height, fps },
		frames: normalized,
		globalStyle,
		totalMs,
		projectId: projectId || null,
	};
}

export async function exportVideoEditorMp4({ body = {} }) {
	const validated = await resolveExportPayload(body);
	if (!validated.ok) {
		return {
			error: validated.error,
			code: validated.code ?? "BAD_REQUEST",
			httpStatus: validated.httpStatus ?? 400,
		};
	}

	const { project, frames, globalStyle } = validated;
	let tmpDir;
	const exportStarted = Date.now();
	try {
		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ve-export-"));
		const sceneClips = [];
		const audioClips = [];

		for (let i = 0; i < frames.length; i++) {
			const frame = frames[i];
			const wavPath = path.join(tmpDir, `frame_${i}.wav`);
			await writeFrameAudioToPath(frame, wavPath, tmpDir, i);

			const durationSec = Math.max(0.5, frame.duration_ms / 1000);
			const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
			const videoStyle = frameStyleToVideoStyle(frame.style, globalStyle);
			const scene = frameToScene(frame);
			const strat = frameToStrat(frame);

			await renderSceneClip({
				scene,
				strat,
				durationSec,
				outPath: clipPath,
				width: project.width,
				height: project.height,
				wavPath,
				captionText: frame.content.narration,
				videoStyle,
			});

			sceneClips.push(clipPath);
			audioClips.push(wavPath);
		}

		const videoOnlyPath = path.join(tmpDir, "video_only.mp4");
		await concatMediaFiles(sceneClips, videoOnlyPath, tmpDir, "video", true);

		const audioOnlyPath = path.join(tmpDir, "audio_only.wav");
		if (audioClips.length === 1) {
			await fsp.copyFile(audioClips[0], audioOnlyPath);
		} else {
			const audioListPath = path.join(tmpDir, "audio-concat.txt");
			const listBody = audioClips
				.map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
				.join("\n");
			await fsp.writeFile(audioListPath, listBody, "utf8");
			await execFfmpeg(
				[
					"-y",
					"-f",
					"concat",
					"-safe",
					"0",
					"-i",
					audioListPath,
					"-c",
					"copy",
					audioOnlyPath,
				],
				"ffmpeg concat editor audio",
			);
		}

		const finalPath = path.join(tmpDir, "final.mp4");
		await muxVideoAudio(videoOnlyPath, audioOnlyPath, finalPath);
		const mp4Buffer = await fsp.readFile(finalPath);

		return {
			error: null,
			buffer: mp4Buffer,
			durationMs: validated.totalMs,
			width: project.width,
			height: project.height,
			exportMs: Date.now() - exportStarted,
			httpStatus: 200,
		};
	} catch (e) {
		logOpenRouterErrorDev("videoEditor", e);
		const fields = jobFailureFieldsFromError(e, { feature: "blog_to_video" });
		return {
			error: fields.user_message || fields.error,
			code: fields.error_code || "EXPORT_FAILED",
			user_message: fields.user_message,
			httpStatus: 500,
		};
	} finally {
		if (tmpDir) await rmDirSafe(tmpDir);
	}
}
