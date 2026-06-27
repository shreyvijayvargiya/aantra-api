/**
 * Blog → video: scrape article → 3 OpenRouter agents (strategist, visual director,
 * asset planner) → TTS → FFmpeg render → UploadThing.
 */
import { v4 as uuidv4 } from "uuid";
import { execFile } from "child_process";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";
import { UTApi, UTFile } from "uploadthing/server";
import {
	buildUsageResponseFields,
	mergeOpenRouterUsage,
	normalizeOpenRouterUsage,
	publicTranslateUsageFromDoc,
} from "./openRouterUsage.js";
import { resolveTranslateLlmModel, TRANSLATE_LLM_PRESETS } from "./translateLlmModels.js";
import {
	openRouterErrorFromResponse,
	logOpenRouterErrorDev,
	jobFailureFieldsFromError,
	publicJobErrorFromDoc,
} from "./openRouterErrors.js";
import { parseJsonObjectFromModel, extractMessageText } from "./parseModelJson.js";
import { getFfmpegBin, getFfprobeBin } from "./ffmpegBin.js";
import {
	execFfmpeg,
	ttsSynthesizeToBuffer,
	pcm16ToWavBuffer,
} from "./videoTranslateOpenRouter.js";
import { resolveOpenRouterTtsVoice } from "./openRouterTtsVoices.js";

const JOBS_COLL = "blogToVideoJobs";
const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";

const utapi = new UTApi({ token: process.env.UPLOADTHING_TOKEN });

const OPENROUTER_TIMEOUT_MS =
	Number.parseInt(process.env.OPENROUTER_VIDEO_TIMEOUT_MS || "", 10) || 600_000;
const OPENROUTER_MAX_TOKENS =
	Number.parseInt(process.env.BLOG_TO_VIDEO_MAX_TOKENS || "", 10) ||
	Number.parseInt(process.env.OPENROUTER_VIDEO_GEMINI_MAX_TOKENS || "", 10) ||
	16384;
const DEFAULT_TARGET_DURATION_SEC =
	Number.parseInt(process.env.BLOG_TO_VIDEO_TARGET_DURATION_SEC || "", 10) || 60;
const MAX_CONTENT_CHARS =
	Number.parseInt(process.env.BLOG_TO_VIDEO_MAX_CONTENT_CHARS || "", 10) || 120_000;
const SCRAPE_URL =
	process.env.BLOG_TO_VIDEO_SCRAPE_URL?.trim() || "https://api.inkgest.com/scrape";
const DEFAULT_WIDTH =
	Number.parseInt(process.env.BLOG_TO_VIDEO_WIDTH || "", 10) || 1920;
const DEFAULT_HEIGHT =
	Number.parseInt(process.env.BLOG_TO_VIDEO_HEIGHT || "", 10) || 1080;

const CONTENT_STRATEGIST_SYSTEM = `You are an expert educational content strategist.

Your task is to convert long-form written content into highly engaging spoken podcast and video narration.

The content may originate from:
- Blog posts
- Documentation
- Markdown
- Medium articles
- Dev.to posts
- Mintlify documentation
- Tutorials
- Technical articles
- Product announcements

Your goals:
- Identify the core concepts.
- Remove fluff and repetition.
- Preserve important educational value.
- Rewrite for listening, not reading.
- Make the narration conversational.
- Use short sentences.
- Explain technical concepts simply.
- Keep audience retention high.

Rules:
- Never copy paragraphs directly.
- Never produce marketing language.
- Never mention section headings.
- Never mention "the article says".
- Speak naturally as a podcast narrator.

Output JSON:
{
  "title": "",
  "summary": "",
  "targetAudience": "",
  "estimatedDurationSeconds": 0,
  "script": "",
  "segments": [
    {
      "id": "segment_1",
      "title": "",
      "narration": "",
      "durationSeconds": 0,
      "importance": "high|medium|low"
    }
  ]
}

Return only valid JSON.`;

const VISUAL_DIRECTOR_SYSTEM = `You are an AI Visual Director.

You design educational videos from narration.

Your job is NOT to write scripts.

Your job is to decide how each segment should be visually represented.

Available visual styles:
- podcast
- ascii
- diagram
- timeline
- chart
- knowledge_card
- code
- minimal
- quote
- comparison
- flowchart
- screenshot
- icon_motion

Selection Rules:
- Technical concepts → diagram
- Statistics → chart
- Historical progression → timeline
- Code explanations → code
- Definitions → knowledge_card
- Comparisons → comparison
- Quotes → quote
- Architecture explanations → flowchart
- General narration → podcast
- Developer content → ascii
- Documentation → screenshot

For each segment determine:
- visualType
- animationStyle
- backgroundTheme
- assetRequirements

Output JSON:
{
  "videoTheme": "",
  "overallStyle": "",
  "segments": [
    {
      "segmentId": "",
      "visualType": "",
      "animationStyle": "",
      "backgroundTheme": "",
      "assetRequirements": []
    }
  ]
}

Return only valid JSON.`;

const ASSET_GENERATOR_SYSTEM = `You are an AI motion graphics planner.

Your job is to create neutral scene JSON for a renderer (FFmpeg today; Remotion/Canvas/WebGL later).

Supported visual types:
- podcast
- ascii
- diagram
- chart
- timeline
- code
- comparison
- knowledge_card
- quote
- screenshot
- flowchart
- minimal
- icon_motion

Do NOT output FFmpeg shell commands. Output structured render plans only.

Each scene uses this neutral schema:
{
  "sceneId": "segment_1",
  "visualType": "diagram",
  "animation": "fade|slide|zoom|none",
  "backgroundTheme": "dark_blue|dark|light|minimal|tech|gradient_blue",
  "title": "",
  "elements": [
    { "type": "node", "label": "Client" },
    { "type": "connection", "from": "Client", "to": "Server" },
    { "type": "text", "label": "..." },
    { "type": "code_line", "label": "const x = 1" }
  ],
  "metadata": {}
}

Type-specific metadata (optional, inside metadata):
- podcast: { "waveform": true, "waveformStyle": "circular|linear", "particles": true, "gradientBackground": true }
- chart: { "chartType": "bar|line|pie", "series": [{ "label": "", "value": 0 }] }
- code: { "language": "", "highlightLines": [1, 2] }
- timeline: { "events": [{ "label": "", "year": "" }] }
- quote: { "quote": "", "author": "" }
- comparison: { "left": "", "right": "" }

Output JSON:
{
  "renderPlan": []
}

Return only valid JSON. One renderPlan entry per segment, sceneId must match segment id.`;

function getOpenRouterKey() {
	return process.env.OPENROUTER_API_KEY?.trim() || "";
}

function openRouterHeaders() {
	const h = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${getOpenRouterKey()}`,
	};
	const ref = process.env.OPENROUTER_HTTP_REFERER?.trim();
	h.Referer = ref || "https://ihatereading.in";
	const title = process.env.OPENROUTER_APP_TITLE?.trim();
	if (title) h["X-Title"] = title;
	return h;
}

async function openRouterAgentChat({
	model,
	systemPrompt,
	userPayload,
	signal,
	temperature = 0.2,
	maxTokens = OPENROUTER_MAX_TOKENS,
}) {
	const messages = [
		{ role: "system", content: systemPrompt },
		{
			role: "user",
			content: JSON.stringify(userPayload),
		},
	];

	const baseBody = {
		model,
		messages,
		temperature,
		max_tokens: maxTokens,
		response_format: { type: "json_object" },
	};

	let chatRes = await fetch(OPENROUTER_CHAT, {
		method: "POST",
		signal,
		headers: openRouterHeaders(),
		body: JSON.stringify(baseBody),
	});

	let chatData = await chatRes.json().catch(() => ({}));
	if (!chatRes.ok || chatData.error) {
		const msg = String(chatData?.error?.message || chatData?.error || "");
		if (/response_format|json_object|unsupported/i.test(msg)) {
			const { response_format: _rf, ...withoutRf } = baseBody;
			chatRes = await fetch(OPENROUTER_CHAT, {
				method: "POST",
				signal,
				headers: openRouterHeaders(),
				body: JSON.stringify(withoutRf),
			});
			chatData = await chatRes.json().catch(() => ({}));
		}
	}

	if (!chatRes.ok || chatData.error) {
		throw openRouterErrorFromResponse(chatRes, chatData);
	}

	const content = extractMessageText(chatData.choices?.[0]?.message?.content);
	if (!content) {
		throw new Error("Empty response from OpenRouter agent");
	}

	return {
		parsed: parseJsonObjectFromModel(content),
		usage: chatData.usage,
	};
}

async function scrapeBlogContent(url, signal) {
	const res = await fetch(SCRAPE_URL, {
		method: "POST",
		signal,
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/plain, */*",
		},
		body: JSON.stringify({ url }),
	});

	const text = await res.text();
	if (!res.ok) {
		throw new Error(
			`Blog scrape failed (${res.status}): ${text.slice(0, 500) || res.statusText}`,
		);
	}

	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = { content: text };
	}

	const content =
		String(
			data?.content ??
				data?.text ??
				data?.markdown ??
				data?.body ??
				data?.data?.content ??
				data?.data?.text ??
				data?.data?.markdown ??
				"",
		).trim() || (typeof data === "string" ? data : "");

	if (!content) {
		throw new Error("Scrape returned empty content");
	}

	return {
		content: content.length > MAX_CONTENT_CHARS
			? `${content.slice(0, MAX_CONTENT_CHARS)}\n\n[Content truncated for processing]`
			: content,
		sourceUrl: url,
		scrapeMeta: {
			title: data?.title ?? data?.data?.title ?? null,
			url: data?.url ?? data?.data?.url ?? url,
		},
	};
}

async function runContentStrategist({ content, targetDuration, language, model, signal }) {
	const { parsed, usage } = await openRouterAgentChat({
		model,
		systemPrompt: CONTENT_STRATEGIST_SYSTEM,
		userPayload: { content, targetDuration, language },
		signal,
		temperature: 0.25,
	});

	const segments = normalizeStrategistSegments(parsed?.segments);
	if (!segments.length) {
		const script = String(parsed?.script ?? "").trim();
		if (!script) {
			throw new Error("Content strategist returned no script or segments");
		}
		segments.push({
			id: "segment_1",
			title: String(parsed?.title ?? "Overview").trim(),
			narration: script,
			durationSeconds: targetDuration,
			importance: "high",
		});
	}

	return {
		title: String(parsed?.title ?? "").trim(),
		summary: String(parsed?.summary ?? "").trim(),
		targetAudience: String(parsed?.targetAudience ?? "").trim(),
		estimatedDurationSeconds: Number(parsed?.estimatedDurationSeconds) || targetDuration,
		script: String(parsed?.script ?? segments.map((s) => s.narration).join(" ")).trim(),
		segments,
		usage,
	};
}

async function runVisualDirector({ strategist, model, signal }) {
	const { parsed, usage } = await openRouterAgentChat({
		model,
		systemPrompt: VISUAL_DIRECTOR_SYSTEM,
		userPayload: {
			title: strategist.title,
			summary: strategist.summary,
			targetAudience: strategist.targetAudience,
			segments: strategist.segments.map((s) => ({
				id: s.id,
				title: s.title,
				narration: s.narration,
				durationSeconds: s.durationSeconds,
				importance: s.importance,
			})),
		},
		signal,
		temperature: 0.3,
	});

	const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
	if (!segments.length) {
		throw new Error("Visual director returned no segment visuals");
	}

	return {
		videoTheme: String(parsed?.videoTheme ?? "").trim(),
		overallStyle: String(parsed?.overallStyle ?? "").trim(),
		segments,
		usage,
	};
}

async function runAssetGenerator({ strategist, visualDirector, model, signal }) {
	const visualById = new Map(
		visualDirector.segments.map((s) => [String(s.segmentId ?? s.id ?? ""), s]),
	);

	const { parsed, usage } = await openRouterAgentChat({
		model,
		systemPrompt: ASSET_GENERATOR_SYSTEM,
		userPayload: {
			title: strategist.title,
			videoTheme: visualDirector.videoTheme,
			overallStyle: visualDirector.overallStyle,
			segments: strategist.segments.map((s) => ({
				id: s.id,
				title: s.title,
				narration: s.narration,
				durationSeconds: s.durationSeconds,
				visual: visualById.get(s.id) ?? null,
			})),
		},
		signal,
		temperature: 0.2,
	});

	let renderPlan = Array.isArray(parsed?.renderPlan) ? parsed.renderPlan : [];
	renderPlan = normalizeRenderPlan(renderPlan, strategist.segments, visualDirector.segments);
	if (!renderPlan.length) {
		throw new Error("Asset generator returned empty renderPlan");
	}

	return { renderPlan, usage };
}

function normalizeStrategistSegments(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (let i = 0; i < raw.length; i++) {
		const row = raw[i];
		const narration = String(row?.narration ?? row?.text ?? "").trim();
		if (!narration) continue;
		const id = String(row?.id ?? `segment_${i + 1}`).trim();
		let durationSeconds = Number(row?.durationSeconds ?? row?.duration_seconds);
		if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
			durationSeconds = 8;
		}
		out.push({
			id,
			title: String(row?.title ?? "").trim(),
			narration,
			durationSeconds,
			importance: String(row?.importance ?? "medium").trim(),
		});
	}
	return out;
}

function normalizeRenderPlan(rawPlan, strategistSegments, visualSegments) {
	const visualById = new Map(
		visualSegments.map((s) => [String(s.segmentId ?? s.id ?? ""), s]),
	);
	const stratById = new Map(strategistSegments.map((s) => [s.id, s]));

	const out = [];
	for (let i = 0; i < rawPlan.length; i++) {
		const row = rawPlan[i];
		const sceneId = String(row?.sceneId ?? row?.segmentId ?? row?.id ?? `segment_${i + 1}`);
		const strat = stratById.get(sceneId);
		const visual = visualById.get(sceneId);
		const visualType = String(
			row?.visualType ?? row?.type ?? visual?.visualType ?? "podcast",
		).trim();
		out.push({
			sceneId,
			visualType,
			animation: String(row?.animation ?? visual?.animationStyle ?? "fade").trim(),
			backgroundTheme: resolveSceneBackgroundTheme(
				row?.backgroundTheme ?? visual?.backgroundTheme ?? "dark_blue",
				visualType,
			),
			title: String(row?.title ?? strat?.title ?? "").trim(),
			elements: normalizeSceneElements(row?.elements, strat, visual),
			metadata: row?.metadata && typeof row.metadata === "object" ? row.metadata : {},
			durationSeconds: Number(row?.durationSeconds) || strat?.durationSeconds || 8,
		});
	}

	if (out.length >= strategistSegments.length) return out;

	for (const seg of strategistSegments) {
		if (out.some((s) => s.sceneId === seg.id)) continue;
		const visual = visualById.get(seg.id);
		out.push({
			sceneId: seg.id,
			visualType: String(visual?.visualType ?? "podcast").trim(),
			animation: String(visual?.animationStyle ?? "fade").trim(),
			backgroundTheme: resolveSceneBackgroundTheme(
				visual?.backgroundTheme ?? "dark_blue",
				String(visual?.visualType ?? "podcast").trim(),
			),
			title: seg.title,
			elements: [{ type: "text", label: seg.title || seg.narration.slice(0, 80) }],
			metadata: {},
			durationSeconds: seg.durationSeconds,
		});
	}
	return out;
}

function normalizeSceneElements(raw, strat, visual) {
	if (Array.isArray(raw) && raw.length) {
		return raw.map((el) => {
			const out = {
				type: String(el?.type ?? "text").trim(),
				label: String(el?.label ?? el?.text ?? "").trim(),
			};
			if (el?.from != null) out.from = String(el.from);
			if (el?.to != null) out.to = String(el.to);
			return out;
		});
	}
	const lines = [];
	if (strat?.title) lines.push({ type: "text", label: strat.title });
	const snippet = String(strat?.narration ?? "").slice(0, 120);
	if (snippet) lines.push({ type: "text", label: snippet });
	if (Array.isArray(visual?.assetRequirements)) {
		for (const req of visual.assetRequirements) {
			lines.push({ type: "text", label: String(req) });
		}
	}
	return lines.length ? lines : [{ type: "text", label: "Segment" }];
}

const BACKGROUND_COLORS = {
	dark_blue: "0x1a1a2e",
	dark: "0x0f0f0f",
	light: "0xf0f0f0",
	minimal: "0x2d2d2d",
	tech: "0x0d1117",
	gradient_blue: "0x16213e",
};

const LIGHT_BACKGROUND_THEMES = new Set(["light"]);

const VIDEO_STYLE_THEME_PRESETS = Object.keys(BACKGROUND_COLORS);

/** Default render style (returned in GET when client did not pass `style`). */
export const DEFAULT_VIDEO_STYLE = {
	theme: "dark_blue",
	background: { color: null },
	waveform: {
		colors: ["#4fc3f7", "#81d4fa"],
		widthRatio: null,
		heightRatio: null,
		yRatio: null,
		mode: "cline",
	},
	centerText: {
		color: null,
		fontSize: null,
		yRatio: null,
		maxLines: null,
	},
	caption: {
		color: null,
		fontSize: null,
		yRatio: null,
		maxLines: null,
		box: { enabled: true, color: null, padding: 10 },
	},
};

function clampRatio(value, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(0.95, Math.max(0.05, n));
}

function parsePositiveSize(raw, fallback, { min = 8, max = 200 } = {}) {
	if (raw == null || String(raw).trim() === "") return fallback;
	const n = Number.parseInt(String(raw), 10);
	if (!Number.isFinite(n) || n < min) return fallback;
	return Math.min(max, n);
}

function expandHex3(hex) {
	const h = hex.slice(1);
	return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
}

function parseColorToFfmpeg(raw, fallback) {
	if (raw == null || String(raw).trim() === "") return fallback;
	const s = String(raw).trim();
	if (/^0x[0-9a-fA-F]+$/.test(s)) return s;
	if (/^#[0-9a-fA-F]{6}$/i.test(s)) return `0x${s.slice(1)}`;
	if (/^#[0-9a-fA-F]{3}$/i.test(s)) return `0x${expandHex3(s).slice(1)}`;
	if (/^rgba?\(/i.test(s)) {
		const inner = s.replace(/^rgba?\(|\)$/gi, "");
		const parts = inner.split(",").map((p) => p.trim());
		if (parts.length >= 3) {
			const r = Number.parseInt(parts[0], 10);
			const g = Number.parseInt(parts[1], 10);
			const b = Number.parseInt(parts[2], 10);
			if ([r, g, b].every((n) => Number.isFinite(n))) {
				const hex =
					((r & 255) << 16 | (g & 255) << 8 | (b & 255))
						.toString(16)
						.padStart(6, "0");
				const alpha =
					parts.length >= 4 && Number.isFinite(Number.parseFloat(parts[3]))
						? Number.parseFloat(parts[3])
						: 1;
				return alpha < 1 ? `0x${hex}@${Math.min(1, Math.max(0, alpha))}` : `0x${hex}`;
			}
		}
	}
	if (/^[a-z]+$/i.test(s)) return s;
	return fallback;
}

function parseWaveformColors(raw, fallbackPair) {
	if (!Array.isArray(raw) || !raw.length) return fallbackPair;
	const parsed = raw
		.map((c) => parseColorToFfmpeg(c, null))
		.filter(Boolean)
		.slice(0, 2);
	if (!parsed.length) return fallbackPair;
	if (parsed.length === 1) return `${parsed[0]}|${parsed[0]}`;
	return `${parsed[0]}|${parsed[1]}`;
}

function themePresetColors(theme) {
	const key = Object.prototype.hasOwnProperty.call(BACKGROUND_COLORS, theme)
		? theme
		: "dark_blue";
	const bg = BACKGROUND_COLORS[key];
	const isLight = LIGHT_BACKGROUND_THEMES.has(key);
	return {
		theme: key,
		bg,
		primary: isLight ? "0x1a1a2e" : "white",
		secondary: isLight ? "0x333333" : "0xb0bec5",
		caption: isLight ? "0x212121" : "0xeceff1",
		waveform: isLight ? "0x0288d1|0x4fc3f7" : "0x4fc3f7|0x81d4fa",
		captionBox: isLight ? "0xffffff@0.72" : "0x000000@0.55",
		isLight,
	};
}

/**
 * Parse optional `style` from POST body. Invalid values fall back to defaults;
 * structural errors return { ok: false }.
 */
export function parseVideoStyleFromBody(raw) {
	if (raw == null) {
		return { ok: true, style: { ...DEFAULT_VIDEO_STYLE } };
	}
	if (typeof raw !== "object" || Array.isArray(raw)) {
		return {
			ok: false,
			error: "style must be a JSON object",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const themeRaw = String(raw.theme ?? raw.backgroundTheme ?? "").trim();
	const theme = VIDEO_STYLE_THEME_PRESETS.includes(themeRaw) ? themeRaw : "dark_blue";

	const bg = raw.background && typeof raw.background === "object" ? raw.background : {};
	const wave =
		raw.waveform && typeof raw.waveform === "object" ? raw.waveform : {};
	const center =
		raw.centerText && typeof raw.centerText === "object"
			? raw.centerText
			: raw.center_text && typeof raw.center_text === "object"
				? raw.center_text
				: {};
	const caption = raw.caption && typeof raw.caption === "object" ? raw.caption : {};
	const captionBox =
		caption.box && typeof caption.box === "object" ? caption.box : {};

	const waveMode = String(wave.mode ?? "cline").trim();
	if (!["cline", "line", "p2p"].includes(waveMode)) {
		return {
			ok: false,
			error: "style.waveform.mode must be cline, line, or p2p",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const style = {
		theme,
		background: {
			color: bg.color != null ? String(bg.color).trim() : null,
		},
		waveform: {
			colors: Array.isArray(wave.colors)
				? wave.colors.map((c) => String(c).trim()).filter(Boolean).slice(0, 2)
				: null,
			widthRatio: wave.widthRatio ?? wave.width_ratio ?? null,
			heightRatio: wave.heightRatio ?? wave.height_ratio ?? null,
			yRatio: wave.yRatio ?? wave.y_ratio ?? null,
			mode: waveMode,
		},
		centerText: {
			color: center.color != null ? String(center.color).trim() : null,
			fontSize: center.fontSize ?? center.font_size ?? null,
			yRatio: center.yRatio ?? center.y_ratio ?? null,
			maxLines: center.maxLines ?? center.max_lines ?? null,
		},
		caption: {
			color: caption.color != null ? String(caption.color).trim() : null,
			fontSize: caption.fontSize ?? caption.font_size ?? null,
			yRatio: caption.yRatio ?? caption.y_ratio ?? null,
			maxLines: caption.maxLines ?? caption.max_lines ?? null,
			box: {
				enabled: captionBox.enabled !== false,
				color: captionBox.color != null ? String(captionBox.color).trim() : null,
				padding: parsePositiveSize(captionBox.padding, 10, { min: 0, max: 48 }),
			},
		},
	};

	return { ok: true, style };
}

function resolveRenderColors(videoStyle) {
	const preset = themePresetColors(videoStyle?.theme || "dark_blue");
	const bg = videoStyle?.background?.color
		? parseColorToFfmpeg(videoStyle.background.color, preset.bg)
		: preset.bg;

	return {
		bg,
		primary: videoStyle?.centerText?.color
			? parseColorToFfmpeg(videoStyle.centerText.color, preset.primary)
			: preset.primary,
		caption: videoStyle?.caption?.color
			? parseColorToFfmpeg(videoStyle.caption.color, preset.caption)
			: preset.caption,
		waveform: parseWaveformColors(videoStyle?.waveform?.colors, preset.waveform),
		captionBox: videoStyle?.caption?.box?.color
			? parseColorToFfmpeg(videoStyle.caption.box.color, preset.captionBox)
			: preset.captionBox,
		captionBoxEnabled: videoStyle?.caption?.box?.enabled !== false,
		captionBoxPadding: parsePositiveSize(
			videoStyle?.caption?.box?.padding,
			10,
			{ min: 0, max: 48 },
		),
		waveMode: videoStyle?.waveform?.mode || "cline",
	};
}

function getSceneLayout(width, height, videoStyle = null) {
	const portrait = isPortraitLayout(width, height);
	const shortSide = Math.min(width, height);

	const defaults = portrait
		? {
				centerFontSize: Math.max(26, Math.floor(shortSide * 0.034)),
				captionFontSize: Math.max(20, Math.floor(shortSide * 0.024)),
				centerStartYRatio: 0.16,
				captionStartYRatio: 0.885,
				centerMaxLines: 4,
				captionMaxLines: 2,
				waveWidthRatio: 0.86,
				waveHeightRatio: 0.14,
				waveYRatio: 0.5,
			}
		: {
				centerFontSize: Math.max(24, Math.floor(shortSide * 0.028)),
				captionFontSize: Math.max(18, Math.floor(shortSide * 0.02)),
				centerStartYRatio: 0.14,
				captionStartYRatio: 0.86,
				centerMaxLines: 5,
				captionMaxLines: 2,
				waveWidthRatio: 0.62,
				waveHeightRatio: 0.12,
				waveYRatio: 0.52,
			};

	const centerFontSize = parsePositiveSize(
		videoStyle?.centerText?.fontSize,
		defaults.centerFontSize,
	);
	const captionFontSize = parsePositiveSize(
		videoStyle?.caption?.fontSize,
		defaults.captionFontSize,
	);
	const centerStartYRatio = clampRatio(
		videoStyle?.centerText?.yRatio,
		defaults.centerStartYRatio,
	);
	const captionStartYRatio = clampRatio(
		videoStyle?.caption?.yRatio,
		defaults.captionStartYRatio,
	);
	const centerMaxLines = parsePositiveSize(
		videoStyle?.centerText?.maxLines,
		defaults.centerMaxLines,
		{ min: 1, max: 8 },
	);
	const captionMaxLines = parsePositiveSize(
		videoStyle?.caption?.maxLines,
		defaults.captionMaxLines,
		{ min: 1, max: 4 },
	);

	return {
		portrait,
		centerFontSize,
		centerLineHeight: Math.max(28, Math.floor(centerFontSize * 1.28)),
		centerStartY: Math.floor(height * centerStartYRatio),
		centerMaxLines,
		centerMaxChars: Math.max(12, Math.floor(width / (centerFontSize * 0.52))),
		captionFontSize,
		captionLineHeight: Math.max(22, Math.floor(captionFontSize * 1.3)),
		captionStartY: Math.floor(height * captionStartYRatio),
		captionMaxLines,
		captionMaxChars: Math.max(16, Math.floor(width / (captionFontSize * 0.5))),
		waveWidthRatio: clampRatio(
			videoStyle?.waveform?.widthRatio,
			defaults.waveWidthRatio,
		),
		waveHeightRatio: clampRatio(
			videoStyle?.waveform?.heightRatio,
			defaults.waveHeightRatio,
		),
		waveYRatio: clampRatio(videoStyle?.waveform?.yRatio, defaults.waveYRatio),
		fps: 30,
	};
}

/** Resolved style for API responses (echoes what was stored / applied). */
export function publicVideoStyleFromDoc(d) {
	const stored = d?.video_style;
	if (!stored || typeof stored !== "object") {
		return { ...DEFAULT_VIDEO_STYLE };
	}
	return {
		theme: stored.theme ?? DEFAULT_VIDEO_STYLE.theme,
		background: {
			color: stored.background?.color ?? null,
		},
		waveform: {
			colors: Array.isArray(stored.waveform?.colors)
				? stored.waveform.colors
				: DEFAULT_VIDEO_STYLE.waveform.colors,
			widthRatio: stored.waveform?.widthRatio ?? null,
			heightRatio: stored.waveform?.heightRatio ?? null,
			yRatio: stored.waveform?.yRatio ?? null,
			mode: stored.waveform?.mode ?? DEFAULT_VIDEO_STYLE.waveform.mode,
		},
		centerText: {
			color: stored.centerText?.color ?? null,
			fontSize: stored.centerText?.fontSize ?? null,
			yRatio: stored.centerText?.yRatio ?? null,
			maxLines: stored.centerText?.maxLines ?? null,
		},
		caption: {
			color: stored.caption?.color ?? null,
			fontSize: stored.caption?.fontSize ?? null,
			yRatio: stored.caption?.yRatio ?? null,
			maxLines: stored.caption?.maxLines ?? null,
			box: {
				enabled: stored.caption?.box?.enabled !== false,
				color: stored.caption?.box?.color ?? null,
				padding: stored.caption?.box?.padding ?? 10,
			},
		},
	};
}

function isPortraitLayout(width, height) {
	return height > width;
}

function resolveSceneBackgroundTheme(theme, visualType) {
	const normalized = String(theme || "dark_blue").trim();
	if (
		(visualType === "podcast" || visualType === "minimal") &&
		LIGHT_BACKGROUND_THEMES.has(normalized)
	) {
		return "dark_blue";
	}
	return Object.prototype.hasOwnProperty.call(BACKGROUND_COLORS, normalized)
		? normalized
		: "dark_blue";
}

function wrapText(text, maxChars, maxLines) {
	const words = String(text || "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (!words.length) return [];

	const lines = [];
	let current = "";
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (candidate.length <= maxChars) {
			current = candidate;
			continue;
		}
		if (current) lines.push(current);
		current = word.length > maxChars ? `${word.slice(0, Math.max(1, maxChars - 1))}…` : word;
		if (lines.length >= maxLines - 1) break;
	}
	if (current && lines.length < maxLines) lines.push(current);

	if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
		const last = lines[maxLines - 1];
		if (!last.endsWith("…") && last.length >= maxChars - 2) {
			lines[maxLines - 1] = `${last.slice(0, Math.max(1, maxChars - 2))}…`;
		}
	}
	return lines.slice(0, maxLines);
}

function wrapLineList(rawLines, maxChars, maxLines) {
	const out = [];
	for (const line of rawLines) {
		if (out.length >= maxLines) break;
		const wrapped = wrapText(line, maxChars, maxLines - out.length);
		out.push(...wrapped);
	}
	return out.slice(0, maxLines);
}

function pickCenterContent(scene, strat) {
	const raw = [];
	const title = String(scene.title || strat?.title || "").trim();
	if (title) raw.push(title);

	for (const el of scene.elements || []) {
		if (raw.length >= 4) break;
		const label = String(el?.label ?? "").trim();
		if (!label) continue;
		if (el.type === "connection") {
			raw.push(`${el.from || "?"} → ${el.to || "?"}`);
		} else if (el.type === "node") {
			raw.push(`• ${label}`);
		} else if (el.type === "code_line") {
			raw.push(label.slice(0, 56));
		} else if (label.length <= 64) {
			raw.push(label);
		}
	}

	if (!raw.length && strat?.narration) {
		return wrapText(strat.narration, 40, 3);
	}

	if (raw.length === 1 && strat?.narration) {
		raw.push(...wrapText(strat.narration, 40, 2));
	}

	return raw.slice(0, 4);
}

function escapeDrawtext(text) {
	return String(text || "")
		.replace(/\\/g, "\\\\\\\\")
		.replace(/:/g, "\\:")
		.replace(/'/g, "'\\\\\\''")
		.replace(/%/g, "\\%");
}

function buildDrawtextFilter({
	text,
	y,
	fontSize,
	fontColor,
	fontOpt,
	box = false,
	boxColor = "0x000000@0.55",
	boxPadding = 10,
}) {
	const escaped = escapeDrawtext(text);
	const boxOpts = box
		? `:box=1:boxcolor=${boxColor}:boxborderw=${Math.max(0, boxPadding)}`
		: "";
	return `drawtext=text='${escaped}'${fontOpt}:fontsize=${fontSize}:fontcolor=${fontColor}${boxOpts}:x=(w-text_w)/2:y=${y}`;
}

function appendDrawtextChain(filterParts, lastLabel, drawtextFilter) {
	const nextLabel = `v${filterParts.length}`;
	filterParts.push(`[${lastLabel}]${drawtextFilter}[${nextLabel}]`);
	return nextLabel;
}

function buildSceneVideoFilterGraph({
	scene,
	width,
	height,
	durationSec,
	layout,
	colors,
	fontOpt,
	centerLines,
	captionLines,
	wavPath,
}) {
	const waveW = Math.max(64, Math.floor(width * layout.waveWidthRatio));
	const waveH = Math.max(48, Math.floor(height * layout.waveHeightRatio));
	const waveY = Math.floor(height * layout.waveYRatio);
	const duration = Math.max(0.5, durationSec).toFixed(3);

	const filterParts = [];
	filterParts.push(
		`[1:a]showwaves=s=${waveW}x${waveH}:mode=${colors.waveMode || "cline"}:colors=${colors.waveform}:rate=${layout.fps},format=rgba[wave]`,
	);
	filterParts.push(`[0:v][wave]overlay=x=(W-w)/2:y=${waveY}:format=auto[base]`);

	let lastLabel = "base";
	for (let i = 0; i < centerLines.length; i++) {
		const y = layout.centerStartY + i * layout.centerLineHeight;
		const fontSize =
			i === 0 && centerLines.length > 1
				? Math.floor(layout.centerFontSize * 1.08)
				: layout.centerFontSize;
		lastLabel = appendDrawtextChain(
			filterParts,
			lastLabel,
			buildDrawtextFilter({
				text: centerLines[i],
				y,
				fontSize,
				fontColor: colors.primary,
				fontOpt,
			}),
		);
	}

	for (let i = 0; i < captionLines.length; i++) {
		const y = layout.captionStartY + i * layout.captionLineHeight;
		lastLabel = appendDrawtextChain(
			filterParts,
			lastLabel,
			buildDrawtextFilter({
				text: captionLines[i],
				y,
				fontSize: layout.captionFontSize,
				fontColor: colors.caption,
				fontOpt,
				box: colors.captionBoxEnabled !== false,
				boxColor: colors.captionBox,
				boxPadding: colors.captionBoxPadding ?? 10,
			}),
		);
	}

	filterParts.push(`[${lastLabel}]format=yuv420p[vout]`);

	return {
		filterComplex: filterParts.join(";"),
		colorInput: `color=c=${colors.bg}:s=${width}x${height}:d=${duration}:r=${layout.fps}`,
		wavPath,
	};
}

function buildSceneVideoFilterGraphNoWave({
	layout,
	colors,
	fontOpt,
	centerLines,
	captionLines,
	width,
	height,
	durationSec,
}) {
	const duration = Math.max(0.5, durationSec).toFixed(3);
	const filterParts = [];
	let lastLabel = "0:v";

	for (let i = 0; i < centerLines.length; i++) {
		const y = layout.centerStartY + i * layout.centerLineHeight;
		lastLabel = appendDrawtextChain(
			filterParts,
			lastLabel,
			buildDrawtextFilter({
				text: centerLines[i],
				y,
				fontSize: layout.centerFontSize,
				fontColor: colors.primary,
				fontOpt,
			}),
		);
	}

	for (let i = 0; i < captionLines.length; i++) {
		const y = layout.captionStartY + i * layout.captionLineHeight;
		lastLabel = appendDrawtextChain(
			filterParts,
			lastLabel,
			buildDrawtextFilter({
				text: captionLines[i],
				y,
				fontSize: layout.captionFontSize,
				fontColor: colors.caption,
				fontOpt,
				box: colors.captionBoxEnabled !== false,
				boxColor: colors.captionBox,
				boxPadding: colors.captionBoxPadding ?? 10,
			}),
		);
	}

	filterParts.push(`[${lastLabel}]format=yuv420p[vout]`);

	return {
		filterComplex: filterParts.join(";"),
		colorInput: `color=c=${colors.bg}:s=${width}x${height}:d=${duration}:r=${layout.fps}`,
	};
}

async function ffprobeDurationSec(filePath) {
	const ffprobe = getFfprobeBin();
	return new Promise((resolve, reject) => {
		execFile(
			ffprobe,
			[
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"default=noprint_wrappers=1:nokey=1",
				filePath,
			],
			{ timeout: 60_000 },
			(err, stdout) => {
				if (err) reject(err);
				else resolve(Math.max(0, Number.parseFloat(String(stdout).trim()) || 0));
			},
		);
	});
}

async function renderSceneClip({
	scene,
	strat,
	durationSec,
	outPath,
	width,
	height,
	wavPath,
	captionText,
	videoStyle,
}) {
	const colors = resolveRenderColors(videoStyle);
	const layout = getSceneLayout(width, height, videoStyle);
	const fontPath = process.env.BLOG_TO_VIDEO_FONT_PATH?.trim();
	const fontOpt = fontPath ? `:fontfile=${fontPath.replace(/:/g, "\\:")}` : "";

	let centerLines = wrapLineList(
		pickCenterContent(scene, strat),
		layout.centerMaxChars,
		layout.centerMaxLines,
	);
	const captionLines = wrapText(
		captionText || strat?.narration || scene.title || "",
		layout.captionMaxChars,
		layout.captionMaxLines,
	);

	if (!centerLines.length && !captionLines.length) {
		centerLines = [
			String(scene.visualType || "segment")
				.replace(/_/g, " ")
				.replace(/\b\w/g, (c) => c.toUpperCase()),
		];
	}

	const renderArgs = (graph, withAudio) => {
		const args = [
			"-y",
			"-f",
			"lavfi",
			"-i",
			graph.colorInput,
		];
		if (withAudio) args.push("-i", wavPath);
		args.push(
			"-filter_complex",
			graph.filterComplex,
			"-map",
			"[vout]",
			"-an",
			"-c:v",
			"libx264",
			"-preset",
			"fast",
			"-crf",
			"23",
			"-pix_fmt",
			"yuv420p",
			"-r",
			String(layout.fps),
			outPath,
		);
		return args;
	};

	if (wavPath) {
		try {
			const graph = buildSceneVideoFilterGraph({
				scene,
				width,
				height,
				durationSec,
				layout,
				colors,
				fontOpt,
				centerLines,
				captionLines,
				wavPath,
			});
			await execFfmpeg(renderArgs(graph, true), `ffmpeg render scene ${scene.sceneId}`);
			return;
		} catch (err) {
			logOpenRouterErrorDev(
				"blogToVideo",
				new Error(`waveform render fallback for ${scene.sceneId}: ${err?.message || err}`),
			);
		}
	}

	const fallbackGraph = buildSceneVideoFilterGraphNoWave({
		layout,
		colors,
		fontOpt,
		centerLines,
		captionLines,
		width,
		height,
		durationSec,
	});
	await execFfmpeg(
		renderArgs(fallbackGraph, false),
		`ffmpeg render scene ${scene.sceneId} (no waveform)`,
	);
}

async function concatMediaFiles(paths, outPath, tmpDir, label, reencode = false) {
	const listPath = path.join(tmpDir, `${label}-concat.txt`);
	const listBody = paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
	await fsp.writeFile(listPath, listBody, "utf8");
	const args = ["-y", "-f", "concat", "-safe", "0", "-i", listPath];
	if (reencode) {
		args.push("-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "aac", "-b:a", "192k");
	} else {
		args.push("-c", "copy");
	}
	args.push(outPath);
	await execFfmpeg(args, `ffmpeg concat ${label}`);
}

async function muxVideoAudio(videoPath, audioPath, outPath) {
	await execFfmpeg(
		[
			"-y",
			"-i",
			videoPath,
			"-i",
			audioPath,
			"-c:v",
			"copy",
			"-c:a",
			"aac",
			"-b:a",
			"192k",
			"-map",
			"0:v:0",
			"-map",
			"1:a:0",
			"-shortest",
			outPath,
		],
		"ffmpeg mux blog video",
	);
}

async function synthesizeSegmentAudio({ narration, voice, signal, tmpDir, index }) {
	const { buffer: pcm, usage } = await ttsSynthesizeToBuffer({
		text: narration,
		signal,
		voice,
	});
	const wav = pcm16ToWavBuffer(pcm);
	const wavPath = path.join(tmpDir, `narration_${index}.wav`);
	await fsp.writeFile(wavPath, wav);
	const durationSec = await ffprobeDurationSec(wavPath);
	return { wavPath, durationSec: Math.max(1, durationSec), usage };
}

async function renderBlogVideo({
	renderPlan,
	strategistSegments,
	voice,
	signal,
	tmpDir,
	width,
	height,
	videoStyle,
}) {
	const segById = new Map(strategistSegments.map((s) => [s.id, s]));
	const sceneClips = [];
	const audioClips = [];
	const timedCaptions = [];
	let cursorMs = 0;
	let mergedTtsUsage = normalizeOpenRouterUsage(null);

	for (let i = 0; i < renderPlan.length; i++) {
		const scene = renderPlan[i];
		const strat = segById.get(scene.sceneId);
		const narration = String(strat?.narration ?? "").trim();
		if (!narration) continue;

		const { wavPath, durationSec, usage } = await synthesizeSegmentAudio({
			narration,
			voice,
			signal,
			tmpDir,
			index: i,
		});
		mergedTtsUsage = mergeOpenRouterUsage(mergedTtsUsage, usage);
		audioClips.push(wavPath);

		const clipPath = path.join(tmpDir, `scene_${i}.mp4`);
		await renderSceneClip({
			scene,
			strat,
			durationSec,
			outPath: clipPath,
			width,
			height,
			wavPath,
			captionText: narration,
			videoStyle,
		});
		sceneClips.push(clipPath);

		const startMs = cursorMs;
		const endMs = cursorMs + Math.round(durationSec * 1000);
		timedCaptions.push({
			start_ms: startMs,
			end_ms: endMs,
			text: narration,
			scene_id: scene.sceneId,
			visual_type: scene.visualType,
		});
		cursorMs = endMs;
	}

	if (!sceneClips.length) {
		throw new Error("No scenes rendered (empty narration)");
	}

	const videoOnlyPath = path.join(tmpDir, "video_only.mp4");
	await concatMediaFiles(sceneClips, videoOnlyPath, tmpDir, "video", true);

	const audioOnlyPath = path.join(tmpDir, "audio_only.wav");
	if (audioClips.length === 1) {
		await fsp.copyFile(audioClips[0], audioOnlyPath);
	} else {
		const audioListPath = path.join(tmpDir, "audio-concat.txt");
		const listBody = audioClips.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
		await fsp.writeFile(audioListPath, listBody, "utf8");
		await execFfmpeg(
			["-y", "-f", "concat", "-safe", "0", "-i", audioListPath, "-c", "copy", audioOnlyPath],
			"ffmpeg concat narration",
		);
	}

	const finalPath = path.join(tmpDir, "final.mp4");
	await muxVideoAudio(videoOnlyPath, audioOnlyPath, finalPath);

	return {
		finalPath,
		audioPath: audioOnlyPath,
		timedCaptions,
		ttsUsage: mergedTtsUsage,
		durationSec: cursorMs / 1000,
	};
}

async function uploadFileBuffer(buffer, fileName, mime) {
	const utFile = new UTFile([buffer], fileName, { type: mime });
	const [response] = await utapi.uploadFiles([utFile]);
	if (response.error) {
		throw new Error(`UploadThing failed: ${response.error.message}`);
	}
	return response.data.ufsUrl;
}

async function rmDirSafe(dir) {
	await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function newJobId() {
	return `btv_${uuidv4().replace(/-/g, "")}`;
}

function stripUndefinedDeep(value) {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (Array.isArray(value)) {
		return value.map((item) => stripUndefinedDeep(item));
	}
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

async function writeJob(docId, data) {
	await firestore
		.collection(JOBS_COLL)
		.doc(docId)
		.set(stripUndefinedDeep(data), { merge: true });
}

async function patchJob(docId, data) {
	await firestore.collection(JOBS_COLL).doc(docId).update(stripUndefinedDeep(data));
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
			process.env.BLOG_TO_VIDEO_LLM_MODEL?.trim() ||
			process.env.VIDEO_CAPTION_TRANSCRIBE_MODEL?.trim() ||
			TRANSLATE_LLM_PRESETS.gemini,
		preset: "gemini",
	};
}

function parsePositiveInt(raw, fallback) {
	if (raw == null || String(raw).trim() === "") return fallback;
	const n = Number.parseInt(String(raw), 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
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
	const w = parsePositiveInt(body.width, DEFAULT_WIDTH);
	const h = parsePositiveInt(body.height, DEFAULT_HEIGHT);
	return { width: w, height: h };
}

export async function createBlogToVideoJob({ body = {} }) {
	if (!getOpenRouterKey()) {
		return {
			error: "OPENROUTER_API_KEY not configured",
			code: "MISSING_API_KEY",
			httpStatus: 503,
		};
	}
	if (!process.env.UPLOADTHING_TOKEN?.trim()) {
		return {
			error: "UPLOADTHING_TOKEN not configured (required to upload rendered video)",
			code: "MISSING_UPLOAD_TOKEN",
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

	const targetDuration = parsePositiveInt(
		body.target_duration ?? body.targetDuration,
		DEFAULT_TARGET_DURATION_SEC,
	);
	const language = String(body.language ?? "english").trim();
	const { width, height } = resolveDimensions(body);

	const styleRes = parseVideoStyleFromBody(body.style ?? body.video_style);
	if (!styleRes.ok) {
		return {
			error: styleRes.error,
			code: styleRes.code,
			httpStatus: styleRes.httpStatus ?? 400,
		};
	}

	const id = newJobId();
	await writeJob(id, {
		id,
		status: "pending",
		source_url: url || null,
		inline_content: inlineContent || null,
		target_duration_sec: targetDuration,
		language,
		width,
		height,
		video_style: styleRes.style,
		tts_voice: voiceRes.voice,
		tts_voice_id: voiceRes.voice_id,
		llm_model: modelRes.openrouterId,
		llm_preset: modelRes.preset,
		createdAt: FieldValue.serverTimestamp(),
		updatedAt: FieldValue.serverTimestamp(),
	});

	queueProcessBlogToVideoJob(id);

	return {
		error: null,
		data: { blog_to_video_id: id },
		httpStatus: 200,
	};
}

function queueProcessBlogToVideoJob(jobId) {
	setImmediate(() => {
		processBlogToVideoJob(jobId).catch((err) => {
			logOpenRouterErrorDev("blogToVideo", err);
			console.error(`[blogToVideo] job ${jobId} failed:`, err?.message || err);
			const fields = jobFailureFieldsFromError(err, { feature: "blog_to_video" });
			patchJob(jobId, {
				...fields,
				updatedAt: FieldValue.serverTimestamp(),
			}).catch(() => {});
		});
	});
}

async function processBlogToVideoJob(jobId) {
	const signal = AbortSignal.timeout(OPENROUTER_TIMEOUT_MS);
	let tmpDir;
	try {
		const snap = await firestore.collection(JOBS_COLL).doc(jobId).get();
		if (!snap.exists) return;
		const job = snap.data();

		await patchJob(jobId, {
			status: "scraping",
			updatedAt: FieldValue.serverTimestamp(),
		});

		let content = String(job.inline_content ?? "").trim();
		let scrapeMeta = null;
		if (!content) {
			const scraped = await scrapeBlogContent(job.source_url, signal);
			content = scraped.content;
			scrapeMeta = scraped.scrapeMeta;
		}

		await patchJob(jobId, {
			status: "strategizing",
			scraped_content_chars: content.length,
			scrape_meta: scrapeMeta,
			updatedAt: FieldValue.serverTimestamp(),
		});

		let mergedUsage = normalizeOpenRouterUsage(null);
		const targetDuration = job.target_duration_sec ?? DEFAULT_TARGET_DURATION_SEC;

		const strategist = await runContentStrategist({
			content,
			targetDuration,
			language: job.language || "english",
			model: job.llm_model,
			signal,
		});
		mergedUsage = mergeOpenRouterUsage(mergedUsage, strategist.usage);

		await patchJob(jobId, {
			status: "directing",
			strategist: {
				title: strategist.title,
				summary: strategist.summary,
				targetAudience: strategist.targetAudience,
				estimatedDurationSeconds: strategist.estimatedDurationSeconds,
				script: strategist.script,
				segments: strategist.segments,
			},
			updatedAt: FieldValue.serverTimestamp(),
		});

		const visualDirector = await runVisualDirector({
			strategist,
			model: job.llm_model,
			signal,
		});
		mergedUsage = mergeOpenRouterUsage(mergedUsage, visualDirector.usage);

		await patchJob(jobId, {
			status: "planning",
			visual_director: {
				videoTheme: visualDirector.videoTheme,
				overallStyle: visualDirector.overallStyle,
				segments: visualDirector.segments,
			},
			updatedAt: FieldValue.serverTimestamp(),
		});

		const assetPlan = await runAssetGenerator({
			strategist,
			visualDirector,
			model: job.llm_model,
			signal,
		});
		mergedUsage = mergeOpenRouterUsage(mergedUsage, assetPlan.usage);

		await patchJob(jobId, {
			status: "rendering",
			render_plan: assetPlan.renderPlan,
			updatedAt: FieldValue.serverTimestamp(),
		});

		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "btv-"));
		const { finalPath, audioPath, timedCaptions, ttsUsage, durationSec } =
			await renderBlogVideo({
				renderPlan: assetPlan.renderPlan,
				strategistSegments: strategist.segments,
				voice: job.tts_voice,
				signal,
				tmpDir,
				width: job.width ?? DEFAULT_WIDTH,
				height: job.height ?? DEFAULT_HEIGHT,
				videoStyle: publicVideoStyleFromDoc(job),
			});
		mergedUsage = mergeOpenRouterUsage(mergedUsage, ttsUsage);

		const videoBuf = await fsp.readFile(finalPath);
		const audioBuf = await fsp.readFile(audioPath);
		const videoUrl = await uploadFileBuffer(
			videoBuf,
			`blog-video-${jobId}.mp4`,
			"video/mp4",
		);
		const audioUrl = await uploadFileBuffer(
			audioBuf,
			`blog-audio-${jobId}.wav`,
			"audio/wav",
		);

		const usagePayload = buildUsageResponseFields(mergedUsage);

		await patchJob(jobId, {
			status: "success",
			title: strategist.title || null,
			summary: strategist.summary || null,
			target_audience: strategist.targetAudience || null,
			script: strategist.script || null,
			segments: strategist.segments,
			scenes: assetPlan.renderPlan,
			render_plan: assetPlan.renderPlan,
			captions: timedCaptions,
			video_url: videoUrl,
			audio_url: audioUrl,
			duration_sec: durationSec,
			...usagePayload,
			error: null,
			updatedAt: FieldValue.serverTimestamp(),
		});
	} catch (e) {
		logOpenRouterErrorDev("blogToVideo", e);
		const fields = jobFailureFieldsFromError(e, { feature: "blog_to_video" });
		await patchJob(jobId, {
			...fields,
			updatedAt: FieldValue.serverTimestamp(),
		});
	} finally {
		if (tmpDir) await rmDirSafe(tmpDir);
	}
}

export async function getBlogToVideoJobStatus(id) {
	const jobId = String(id || "").trim();
	if (!jobId) {
		return {
			error: "Missing blog_to_video_id",
			code: "BAD_REQUEST",
			httpStatus: 400,
		};
	}

	const snap = await firestore.collection(JOBS_COLL).doc(jobId).get();
	if (!snap.exists) {
		return {
			error: "Unknown blog_to_video_id",
			code: "NOT_FOUND",
			httpStatus: 404,
		};
	}

	const d = snap.data();
	const errFields = publicJobErrorFromDoc(d, { feature: "blog_to_video" });
	const videoUrl = d.video_url || d.final_video_url || null;

	const data = {
		blog_to_video_id: jobId,
		status: d.status || "pending",
		source_url: d.source_url ?? null,
		title: d.title ?? d.strategist?.title ?? null,
		summary: d.summary ?? d.strategist?.summary ?? null,
		target_audience: d.target_audience ?? d.strategist?.targetAudience ?? null,
		script: d.script ?? d.strategist?.script ?? null,
		segments: d.segments ?? d.strategist?.segments ?? null,
		visual_director: d.visual_director ?? null,
		scenes: d.scenes ?? d.render_plan ?? null,
		render_plan: d.render_plan ?? null,
		captions: d.captions ?? null,
		video_url: videoUrl,
		final_video_url: videoUrl,
		videoUrl,
		audio_url: d.audio_url ?? null,
		duration_sec: d.duration_sec ?? null,
		target_duration_sec: d.target_duration_sec ?? null,
		language: d.language ?? null,
		width: d.width ?? null,
		height: d.height ?? null,
		style: publicVideoStyleFromDoc(d),
		video_style: publicVideoStyleFromDoc(d),
		style_themes: VIDEO_STYLE_THEME_PRESETS,
		tts_voice: d.tts_voice ?? null,
		error: errFields.error,
		error_code: errFields.error_code,
		user_message: errFields.user_message,
		...(errFields.error_detail ? { error_detail: errFields.error_detail } : {}),
		...(errFields.error_upstream_status
			? { error_upstream_status: errFields.error_upstream_status }
			: {}),
		...(errFields.error_retryable != null
			? { error_retryable: errFields.error_retryable }
			: {}),
		...publicTranslateUsageFromDoc(d),
		engine: "openrouter-blog-to-video-ffmpeg",
	};

	return { error: null, data, httpStatus: 200 };
}
