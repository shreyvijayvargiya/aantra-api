/**
 * Blog → video: scrape article → 3 OpenRouter agents (strategist, visual director,
 * asset planner) → TTS → FFmpeg render → UploadThing.
 */
import { v4 as uuidv4 } from "uuid";
import { execFile } from "child_process";
import fsp from "fs/promises";
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
const MAX_SCRAPED_IMAGES =
	Number.parseInt(process.env.BLOG_TO_VIDEO_MAX_SCRAPED_IMAGES || "", 10) || 12;
const MAX_SCRAPED_IMAGE_BYTES =
	Number.parseInt(process.env.BLOG_TO_VIDEO_MAX_IMAGE_BYTES || "", 10) ||
	15 * 1024 * 1024;
const MAX_VISUAL_SOURCE_CHARS =
	Number.parseInt(process.env.BLOG_TO_VIDEO_VISUAL_SOURCE_CHARS || "", 10) || 12_000;
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
- blog_image
- blog_article
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
- When a relevant scraped image exists, prefer blog_image and reference its exact imageId.
- Use blog_article for a concise paragraph/card excerpt when no useful image exists.
- Never invent image URLs or image IDs.

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
    { "type": "code_line", "label": "const x = 1" },
    { "type": "blog_image", "imageId": "image_1", "fit": "cover", "label": "optional alt text" },
    { "type": "blog_paragraph", "label": "short source-grounded excerpt" }
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
- blog_image: { "imageId": "exact ID from availableImages", "fit": "cover|contain" }

Image rules:
- Only use imageId values supplied in availableImages.
- Prefer a relevant source image over a generic abstract visual.
- Do not invent URLs.
- Use at most one blog_image per scene.

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

function resolveImageUrl(raw, baseUrl) {
	const value = String(raw || "").trim();
	if (!value || value.startsWith("data:") || value.startsWith("blob:")) return null;
	try {
		const parsed = new URL(value, baseUrl || undefined);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		parsed.hash = "";
		return parsed.href;
	} catch {
		return null;
	}
}

function extractMarkdownImages(content, baseUrl) {
	const out = [];
	const markdown = String(content || "");
	const regex = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
	let match;
	while ((match = regex.exec(markdown)) !== null) {
		const url = resolveImageUrl(match[2], baseUrl);
		if (url) out.push({ url, alt: String(match[1] || "").trim() });
	}
	return out;
}

function extractHtmlImages(content, baseUrl) {
	const out = [];
	const html = String(content || "");
	const regex = /<img\b[^>]*>/gi;
	let match;
	while ((match = regex.exec(html)) !== null) {
		const tag = match[0];
		const src =
			tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ||
			tag.match(/\bsrc\s*=\s*([^\s>]+)/i)?.[1];
		const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] || "";
		const url = resolveImageUrl(src, baseUrl);
		if (url) out.push({ url, alt: String(alt).trim() });
	}
	return out;
}

function coerceScrapeText(value) {
	if (value == null) return "";
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		return value
			.map((item) => coerceScrapeText(item))
			.filter(Boolean)
			.join("\n\n");
	}
	if (typeof value === "object") {
		const preferred =
			value.markdown ??
			value.text ??
			value.content ??
			value.body ??
			value.paragraphs ??
			value.semanticContent?.paragraphs;
		const fromPreferred = coerceScrapeText(preferred);
		if (fromPreferred) return fromPreferred;
		const chunks = [];
		for (const key of ["h1", "h2", "h3", "title", "summary"]) {
			const part = coerceScrapeText(value[key]);
			if (part) chunks.push(part);
		}
		return chunks.join("\n\n");
	}
	return "";
}

function collectImageCandidates(data, content, baseUrl) {
	const candidates = [];
	const add = (raw, fallbackAlt = "") => {
		if (!raw) return;
		if (typeof raw === "string") {
			const url = resolveImageUrl(raw, baseUrl);
			if (url) candidates.push({ url, alt: fallbackAlt });
			return;
		}
		if (typeof raw !== "object") return;
		const url = resolveImageUrl(
			raw.url ?? raw.src ?? raw.imageUrl ?? raw.image_url ?? raw.href,
			baseUrl,
		);
		if (!url) return;
		candidates.push({
			url,
			alt: String(
				raw.alt ?? raw.caption ?? raw.title ?? raw.description ?? fallbackAlt ?? "",
			).trim(),
		});
	};
	const addArray = (raw) => {
		if (Array.isArray(raw)) {
			for (const item of raw) add(item);
		}
	};

	addArray(data?.images);
	addArray(data?.data?.images);
	addArray(data?.metadata?.images);
	addArray(data?.data?.metadata?.images);
	add(data?.image);
	add(data?.image_url);
	add(data?.ogImage ?? data?.og_image);
	add(data?.metadata?.ogImage ?? data?.metadata?.og_image);
	add(data?.data?.image);
	add(data?.data?.ogImage ?? data?.data?.og_image);
	add(data?.metadata?.["og:image"]);
	add(data?.data?.metadata?.["og:image"]);
	add(data?.metadata?.["twitter:image"]);
	add(data?.data?.metadata?.["twitter:image"]);
	candidates.push(...extractHtmlImages(content, baseUrl));
	candidates.push(...extractMarkdownImages(content, baseUrl));

	const seen = new Set();
	const normalized = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.url)) continue;
		seen.add(candidate.url);
		normalized.push({
			id: `image_${normalized.length + 1}`,
			url: candidate.url,
			alt: candidate.alt || "",
		});
		if (normalized.length >= MAX_SCRAPED_IMAGES) break;
	}
	return normalized;
}

function isPrivateIp(address) {
	const normalized = String(address || "").toLowerCase();
	if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) {
		return true;
	}
	const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
	const ipv4 = mapped || (isIP(normalized) === 4 ? normalized : null);
	if (!ipv4) return false;
	const [a, b] = ipv4.split(".").map(Number);
	return (
		a === 10 ||
		a === 127 ||
		a === 0 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127)
	);
}

async function assertSafeRemoteImageUrl(rawUrl) {
	const parsed = new URL(rawUrl);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Unsupported image URL protocol");
	}
	const host = parsed.hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) {
		throw new Error("Local image URLs are not allowed");
	}
	const addresses = isIP(host)
		? [{ address: host }]
		: await lookup(host, { all: true, verbatim: true });
	if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
		throw new Error("Private-network image URLs are not allowed");
	}
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

	// Prefer real markdown/text strings. Inkgest often returns nested
	// `data.content` objects that must not win over top-level markdown.
	const content =
		coerceScrapeText(data?.markdown) ||
		coerceScrapeText(data?.text) ||
		coerceScrapeText(data?.body) ||
		coerceScrapeText(typeof data?.content === "string" ? data.content : null) ||
		coerceScrapeText(data?.data?.markdown) ||
		coerceScrapeText(data?.data?.text) ||
		coerceScrapeText(typeof data?.data?.content === "string" ? data.data.content : null) ||
		coerceScrapeText(data?.data?.content) ||
		coerceScrapeText(data?.content) ||
		(typeof data === "string" ? data.trim() : "");

	if (!content) {
		throw new Error("Scrape returned empty content");
	}

	const pageUrl = data?.url ?? data?.data?.url ?? url;
	const images = collectImageCandidates(data, content, pageUrl);
	console.log(
		`[blogToVideo] scrape ${pageUrl}: content=${content.length} chars, images=${images.length}`,
	);

	return {
		content: content.length > MAX_CONTENT_CHARS
			? `${content.slice(0, MAX_CONTENT_CHARS)}\n\n[Content truncated for processing]`
			: content,
		sourceUrl: url,
		scrapeMeta: {
			title: data?.title ?? data?.data?.title ?? null,
			url: pageUrl,
		},
		images,
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

async function runVisualDirector({
	strategist,
	sourceContent = "",
	availableImages = [],
	model,
	signal,
}) {
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
			availableImages: availableImages.map(({ id, url, alt }) => ({ id, url, alt })),
			sourceExcerpt: String(sourceContent).slice(0, MAX_VISUAL_SOURCE_CHARS),
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

async function runAssetGenerator({
	strategist,
	visualDirector,
	sourceContent = "",
	availableImages = [],
	model,
	signal,
}) {
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
			availableImages: availableImages.map(({ id, url, alt }) => ({ id, url, alt })),
			sourceExcerpt: String(sourceContent).slice(0, MAX_VISUAL_SOURCE_CHARS),
		},
		signal,
		temperature: 0.2,
	});

	let renderPlan = Array.isArray(parsed?.renderPlan) ? parsed.renderPlan : [];
	renderPlan = normalizeRenderPlan(
		renderPlan,
		strategist.segments,
		visualDirector.segments,
		availableImages,
	);
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

function normalizeRenderPlan(
	rawPlan,
	strategistSegments,
	visualSegments,
	availableImages = [],
) {
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

	// Ensure scraped media is actually used even when the planner ignores it.
	// Distribute source images across scenes; AI-selected valid image IDs win.
	const validIds = new Set(availableImages.map((image) => image.id));
	let imageCursor = 0;
	for (const scene of out) {
		const selected = scene.elements.find(
			(el) => el.type === "blog_image" && validIds.has(el.imageId),
		);
		if (!selected && availableImages.length) {
			const image = availableImages[imageCursor % availableImages.length];
			imageCursor += 1;
			scene.elements.unshift({
				type: "blog_image",
				imageId: image.id,
				fit: "cover",
				label: image.alt || "",
			});
			if (scene.visualType === "podcast" || scene.visualType === "minimal") {
				scene.visualType = "blog_image";
			}
		}

		const hasParagraph = scene.elements.some((el) => el.type === "blog_paragraph");
		if (!hasParagraph) {
			const strat = stratById.get(scene.sceneId);
			const body = String(strat?.narration || scene.title || "").trim();
			if (body) {
				scene.elements.push({
					type: "blog_paragraph",
					label: body.slice(0, 420),
				});
			}
		}
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
			if (el?.imageId != null || el?.image_id != null) {
				out.imageId = String(el.imageId ?? el.image_id).trim();
			}
			if (el?.src != null || el?.url != null) {
				out.src = String(el.src ?? el.url).trim();
			}
			if (el?.fit != null) out.fit = String(el.fit).trim().toLowerCase();
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

export const VIDEO_STYLE_THEME_PRESETS = Object.keys(BACKGROUND_COLORS);

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
		if (el.type === "blog_image") {
			continue;
		} else if (el.type === "blog_paragraph") {
			raw.push(...wrapText(label, 56, Math.max(1, 4 - raw.length)));
		} else if (el.type === "blog_heading") {
			raw.push(label.slice(0, 72));
		} else if (el.type === "connection") {
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
	width,
	height,
	durationSec,
	layout,
	colors,
	fontOpt,
	centerLines,
	captionLines,
	hasImageBackground = false,
	imageFit = "cover",
	hasContentCard = false,
	withWaveform = false,
}) {
	const waveW = Math.max(64, Math.floor(width * layout.waveWidthRatio));
	const waveH = Math.max(48, Math.floor(height * layout.waveHeightRatio));
	const waveY = Math.floor(height * layout.waveYRatio);
	const duration = Math.max(0.5, durationSec).toFixed(3);
	const cardWidth = Math.max(320, Math.floor(width * 0.78));

	// Input layout:
	// 0 = background (color or scraped image)
	// 1 = content card PNG (optional)
	// last = audio for waveform (optional)
	const audioIndex = hasContentCard ? 2 : 1;
	const filterParts = [];
	let backgroundLabel = "0:v";

	if (hasImageBackground) {
		const imageLayout =
			imageFit === "contain"
				? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${colors.bg}`
				: `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
		filterParts.push(
			`[0:v]${imageLayout},eq=brightness=-0.28:saturation=0.85,format=rgba[scene_bg]`,
		);
		backgroundLabel = "scene_bg";
	} else {
		filterParts.push(`[0:v]format=rgba[scene_bg]`);
		backgroundLabel = "scene_bg";
	}

	let framedLabel = backgroundLabel;
	if (hasContentCard) {
		filterParts.push(
			`[1:v]scale=${cardWidth}:-1:force_original_aspect_ratio=decrease,format=rgba[card]`,
		);
		filterParts.push(
			`[${backgroundLabel}][card]overlay=x=(W-w)/2:y=(H-h)/2-40:format=auto[framed]`,
		);
		framedLabel = "framed";
	}

	let lastLabel = framedLabel;
	if (withWaveform) {
		filterParts.push(
			`[${audioIndex}:a]showwaves=s=${waveW}x${waveH}:mode=${colors.waveMode || "cline"}:colors=${colors.waveform}:rate=${layout.fps},format=rgba[wave]`,
		);
		filterParts.push(
			`[${framedLabel}][wave]overlay=x=(W-w)/2:y=${waveY}:format=auto[base]`,
		);
		lastLabel = "base";
	}

	// Only draw center text when we failed to create a content card image.
	if (!hasContentCard) {
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
					box: true,
					boxColor: "0x111827@0.72",
					boxPadding: 16,
				}),
			);
		}
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

function escapeHtml(text) {
	return String(text || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function resolveChromeExecutable() {
	const fromEnv =
		process.env.BLOG_TO_VIDEO_CHROME_PATH?.trim() ||
		process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
		process.env.CHROME_PATH?.trim();
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	const candidates = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	];
	return candidates.find((p) => existsSync(p)) || null;
}

function buildBlogContentCardHtml({
	title,
	body,
	width,
	height,
	backgroundColor = "#0f172a",
}) {
	const safeTitle = escapeHtml(title || "Key idea");
	const paragraphs = wrapText(body || "", 92, 8)
		.map((line) => `<p>${escapeHtml(line)}</p>`)
		.join("");
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0;
    width: ${width}px;
    height: ${height}px;
    background: ${backgroundColor};
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    color: #0f172a;
  }
  .frame {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background:
      radial-gradient(circle at 20% 20%, rgba(56,189,248,0.22), transparent 35%),
      radial-gradient(circle at 80% 10%, rgba(251,191,36,0.18), transparent 28%),
      linear-gradient(160deg, ${backgroundColor} 0%, #1e293b 55%, #0f172a 100%);
  }
  .card {
    width: 78%;
    max-height: 78%;
    overflow: hidden;
    background: rgba(255,255,255,0.96);
    border-radius: 28px;
    padding: 42px 48px;
    box-shadow: 0 24px 80px rgba(0,0,0,0.35);
  }
  .eyebrow {
    font-family: "Avenir Next", "Segoe UI", sans-serif;
    font-size: 14px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #64748b;
    margin-bottom: 14px;
  }
  h1 {
    margin: 0 0 18px;
    font-size: 42px;
    line-height: 1.15;
    font-weight: 700;
  }
  p {
    margin: 0 0 12px;
    font-size: 26px;
    line-height: 1.45;
    color: #1e293b;
  }
</style>
</head>
<body>
  <div class="frame">
    <article class="card">
      <div class="eyebrow">From the article</div>
      <h1>${safeTitle}</h1>
      ${paragraphs || "<p>Continuing the story.</p>"}
    </article>
  </div>
</body>
</html>`;
}

async function renderBlogContentCardPng({
	browser,
	title,
	body,
	width,
	height,
	outPath,
	backgroundColor,
}) {
	const page = await browser.newPage();
	try {
		await page.setViewportSize({ width, height });
		await page.setContent(
			buildBlogContentCardHtml({ title, body, width, height, backgroundColor }),
			{ waitUntil: "domcontentloaded" },
		);
		await page.screenshot({ path: outPath, type: "png" });
	} finally {
		await page.close().catch(() => {});
	}
	return outPath;
}

async function withBlogVideoBrowser(fn) {
	const { chromium } = await import("playwright");
	const executablePath = resolveChromeExecutable();
	const browser = await chromium.launch({
		headless: true,
		executablePath: executablePath || undefined,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
	});
	try {
		return await fn(browser);
	} finally {
		await browser.close().catch(() => {});
	}
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
	backgroundImagePath = null,
	backgroundImageFit = "cover",
	contentCardPath = null,
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
		Math.min(2, layout.captionMaxLines),
	);

	if (!centerLines.length && !captionLines.length) {
		centerLines = [
			String(scene.visualType || "segment")
				.replace(/_/g, " ")
				.replace(/\b\w/g, (c) => c.toUpperCase()),
		];
	}

	const buildArgs = ({ filterComplex, colorInput, withAudio, imagePath, cardPath }) => {
		const args = ["-y"];
		if (imagePath) {
			args.push("-loop", "1", "-framerate", String(layout.fps), "-i", imagePath);
		} else {
			args.push("-f", "lavfi", "-i", colorInput);
		}
		if (cardPath) {
			args.push("-loop", "1", "-framerate", String(layout.fps), "-i", cardPath);
		}
		if (withAudio) args.push("-i", wavPath);
		args.push(
			"-filter_complex",
			filterComplex,
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
			"-t",
			String(Math.max(0.5, durationSec)),
			outPath,
		);
		return args;
	};

	const tryRender = async ({ imagePath, cardPath, withAudio }) => {
		const graph = buildSceneVideoFilterGraph({
			width,
			height,
			durationSec,
			layout,
			colors,
			fontOpt,
			centerLines,
			captionLines: cardPath ? captionLines.slice(0, 1) : captionLines,
			hasImageBackground: Boolean(imagePath),
			imageFit: backgroundImageFit,
			hasContentCard: Boolean(cardPath),
			withWaveform: Boolean(withAudio),
		});
		await execFfmpeg(
			buildArgs({
				filterComplex: graph.filterComplex,
				colorInput: graph.colorInput,
				withAudio,
				imagePath,
				cardPath,
			}),
			`ffmpeg render scene ${scene.sceneId}`,
		);
	};

	const attempts = [
		{ imagePath: backgroundImagePath, cardPath: contentCardPath, withAudio: Boolean(wavPath) },
		{ imagePath: backgroundImagePath, cardPath: contentCardPath, withAudio: false },
		{ imagePath: null, cardPath: contentCardPath, withAudio: Boolean(wavPath) },
		{ imagePath: null, cardPath: contentCardPath, withAudio: false },
		{ imagePath: backgroundImagePath, cardPath: null, withAudio: Boolean(wavPath) },
		{ imagePath: backgroundImagePath, cardPath: null, withAudio: false },
		{ imagePath: null, cardPath: null, withAudio: Boolean(wavPath) },
		{ imagePath: null, cardPath: null, withAudio: false },
	];

	let lastError = null;
	const seen = new Set();
	for (const attempt of attempts) {
		const key = `${attempt.imagePath || "noimg"}|${attempt.cardPath || "nocard"}|${attempt.withAudio ? "a" : "na"}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (attempt.imagePath && !backgroundImagePath) continue;
		if (attempt.cardPath && !contentCardPath) continue;
		if (attempt.withAudio && !wavPath) continue;
		try {
			await tryRender(attempt);
			return {
				usedImage: Boolean(attempt.imagePath),
				usedContentCard: Boolean(attempt.cardPath),
			};
		} catch (err) {
			lastError = err;
			logOpenRouterErrorDev(
				"blogToVideo",
				new Error(
					`scene render attempt failed for ${scene.sceneId} (${key}): ${err?.message || err}`,
				),
			);
		}
	}
	throw lastError || new Error(`Failed to render scene ${scene.sceneId}`);
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

async function fetchRemoteImage(url, signal) {
	let current = url;
	for (let redirect = 0; redirect < 5; redirect++) {
		await assertSafeRemoteImageUrl(current);
		const res = await fetch(current, {
			signal,
			redirect: "manual",
			headers: {
				Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
				"User-Agent":
					"Mozilla/5.0 (compatible; AantraBlogVideo/1.0; +https://aantraa.com)",
			},
		});
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (!location) throw new Error(`Image redirect ${res.status} has no location`);
			current = new URL(location, current).href;
			continue;
		}
		if (!res.ok) throw new Error(`Image HTTP ${res.status}`);
		const contentType = String(res.headers.get("content-type") || "")
			.split(";")[0]
			.trim()
			.toLowerCase();
		if (!contentType.startsWith("image/") || contentType.includes("svg")) {
			throw new Error(`Unsupported image content-type: ${contentType || "unknown"}`);
		}
		const contentLength = Number(res.headers.get("content-length") || 0);
		if (contentLength > MAX_SCRAPED_IMAGE_BYTES) {
			throw new Error(`Image exceeds ${MAX_SCRAPED_IMAGE_BYTES} byte limit`);
		}
		const buffer = Buffer.from(await res.arrayBuffer());
		if (!buffer.length || buffer.length > MAX_SCRAPED_IMAGE_BYTES) {
			throw new Error("Image is empty or too large");
		}
		return { buffer, contentType, finalUrl: current };
	}
	throw new Error("Too many image redirects");
}

function imageExtension(contentType) {
	if (contentType === "image/png") return ".png";
	if (contentType === "image/webp") return ".webp";
	if (contentType === "image/gif") return ".gif";
	if (contentType === "image/avif") return ".avif";
	return ".jpg";
}

async function prepareScrapedImages(images, tmpDir, signal) {
	const mediaDir = path.join(tmpDir, "source-images");
	await fsp.mkdir(mediaDir, { recursive: true });
	const results = new Map();
	let cursor = 0;
	const workerCount = Math.min(3, images.length);

	async function worker() {
		while (cursor < images.length) {
			const index = cursor++;
			const image = images[index];
			try {
				const fetched = await fetchRemoteImage(image.url, signal);
				const filePath = path.join(
					mediaDir,
					`${image.id}${imageExtension(fetched.contentType)}`,
				);
				await fsp.writeFile(filePath, fetched.buffer);
				results.set(image.id, {
					...image,
					url: fetched.finalUrl,
					filePath,
				});
				console.log(
					`[blogToVideo] prepared ${image.id} (${fetched.buffer.length} bytes)`,
				);
			} catch (error) {
				console.warn(
					`[blogToVideo] skipped ${image.id}: ${error?.message || error}`,
				);
			}
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}

function sceneImageSelection(scene) {
	const element = (scene.elements || []).find(
		(el) => el?.type === "blog_image" && el?.imageId,
	);
	const imageId =
		String(
			element?.imageId ??
				scene?.metadata?.imageId ??
				scene?.metadata?.image_id ??
				"",
		).trim() || null;
	return {
		imageId,
		fit: String(element?.fit || scene?.metadata?.imageFit || "cover").toLowerCase() ===
			"contain"
			? "contain"
			: "cover",
	};
}

async function renderBlogVideo({
	renderPlan,
	strategistSegments,
	sourceImages = [],
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
	const preparedImages = await prepareScrapedImages(sourceImages, tmpDir, signal);
	const cardDir = path.join(tmpDir, "content-cards");
	await fsp.mkdir(cardDir, { recursive: true });

	let imagesUsed = 0;
	let contentCardsUsed = 0;
	const colors = resolveRenderColors(videoStyle);
	const bgHex = `#${String(colors.bg || "0x0f172a").replace(/^0x/i, "")}`;

	await withBlogVideoBrowser(async (browser) => {
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

			const paragraphEl = (scene.elements || []).find(
				(el) => el.type === "blog_paragraph" && el.label,
			);
			const cardBody =
				String(paragraphEl?.label || "").trim() ||
				narration.slice(0, 420);
			const cardTitle =
				String(scene.title || strat?.title || "From the article").trim() ||
				"From the article";
			const contentCardPath = path.join(cardDir, `card_${i}.png`);
			try {
				await renderBlogContentCardPng({
					browser,
					title: cardTitle,
					body: cardBody,
					width,
					height,
					outPath: contentCardPath,
					backgroundColor: bgHex.startsWith("#") ? bgHex : `#${bgHex}`,
				});
			} catch (err) {
				console.warn(
					`[blogToVideo] content card failed for ${scene.sceneId}: ${err?.message || err}`,
				);
				await fsp.rm(contentCardPath, { force: true }).catch(() => {});
			}
			const cardExists = existsSync(contentCardPath);

			const clipPath = path.join(tmpDir, `scene_${i}.mp4`);
			const { imageId, fit: backgroundImageFit } = sceneImageSelection(scene);
			let backgroundImagePath = imageId
				? preparedImages.get(imageId)?.filePath ?? null
				: null;
			// If the planner didn't bind an image but we have scraped ones, cycle them in.
			if (!backgroundImagePath && preparedImages.size) {
				const preparedList = [...preparedImages.values()];
				backgroundImagePath = preparedList[i % preparedList.length].filePath;
			}

			const renderResult = await renderSceneClip({
				scene,
				strat,
				durationSec,
				outPath: clipPath,
				width,
				height,
				wavPath,
				captionText: narration,
				videoStyle,
				backgroundImagePath,
				backgroundImageFit,
				contentCardPath: cardExists ? contentCardPath : null,
			});
			if (renderResult?.usedImage) imagesUsed += 1;
			if (renderResult?.usedContentCard) contentCardsUsed += 1;
			sceneClips.push(clipPath);

			const startMs = cursorMs;
			const endMs = cursorMs + Math.round(durationSec * 1000);
			timedCaptions.push({
				start_ms: startMs,
				end_ms: endMs,
				text: narration,
				scene_id: scene.sceneId,
				visual_type: scene.visualType,
				image_id: renderResult?.usedImage
					? imageId || `auto_${(i % Math.max(1, preparedImages.size)) + 1}`
					: null,
				content_card: Boolean(renderResult?.usedContentCard),
			});
			cursorMs = endMs;
		}
	});

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
		mediaStats: {
			source_images_found: sourceImages.length,
			source_images_downloaded: preparedImages.size,
			scenes_with_images: imagesUsed,
			content_cards_rendered: contentCardsUsed,
		},
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
	const inlineImages = collectImageCandidates(
		{ images: Array.isArray(body.images) ? body.images : [] },
		inlineContent,
		url || undefined,
	);

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
		inline_images: inlineImages,
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
		let sourceImages = Array.isArray(job.inline_images) ? [...job.inline_images] : [];
		if (!content) {
			const scraped = await scrapeBlogContent(job.source_url, signal);
			content = scraped.content;
			scrapeMeta = scraped.scrapeMeta;
			sourceImages = scraped.images || [];
		} else if (job.source_url) {
			// Content was provided inline, but still scrape the URL for real page images.
			try {
				const scraped = await scrapeBlogContent(job.source_url, signal);
				scrapeMeta = scraped.scrapeMeta;
				const fromPage = scraped.images || [];
				const seen = new Set(sourceImages.map((img) => img.url));
				for (const img of fromPage) {
					if (seen.has(img.url)) continue;
					seen.add(img.url);
					sourceImages.push({
						...img,
						id: `image_${sourceImages.length + 1}`,
					});
				}
				if (!sourceImages.length) {
					sourceImages = collectImageCandidates(
						null,
						content,
						job.source_url || undefined,
					);
				}
			} catch (err) {
				console.warn(
					`[blogToVideo] image scrape fallback failed: ${err?.message || err}`,
				);
				if (!sourceImages.length) {
					sourceImages = collectImageCandidates(
						null,
						content,
						job.source_url || undefined,
					);
				}
			}
		} else if (!sourceImages.length) {
			sourceImages = collectImageCandidates(
				null,
				content,
				job.source_url || undefined,
			);
		}

		console.log(
			`[blogToVideo] job ${jobId}: source_images=${sourceImages.length}`,
		);

		await patchJob(jobId, {
			status: "strategizing",
			scraped_content_chars: content.length,
			scrape_meta: scrapeMeta,
			source_images: sourceImages,
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
			sourceContent: content,
			availableImages: sourceImages,
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
			sourceContent: content,
			availableImages: sourceImages,
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
		const {
			finalPath,
			audioPath,
			timedCaptions,
			ttsUsage,
			durationSec,
			mediaStats,
		} = await renderBlogVideo({
			renderPlan: assetPlan.renderPlan,
			strategistSegments: strategist.segments,
			sourceImages,
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
			source_images: sourceImages,
			media_stats: mediaStats || null,
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
		source_images: d.source_images ?? d.inline_images ?? [],
		media_stats: d.media_stats ?? null,
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

/** AI pipeline only (strategist → visual director → asset planner). No TTS/render. */
export async function runBlogToVideoGenerationPipeline({
	content,
	targetDuration,
	language,
	model,
	signal,
	availableImages = [],
}) {
	let mergedUsage = normalizeOpenRouterUsage(null);

	const strategist = await runContentStrategist({
		content,
		targetDuration,
		language,
		model,
		signal,
	});
	mergedUsage = mergeOpenRouterUsage(mergedUsage, strategist.usage);

	const visualDirector = await runVisualDirector({
		strategist,
		sourceContent: content,
		availableImages,
		model,
		signal,
	});
	mergedUsage = mergeOpenRouterUsage(mergedUsage, visualDirector.usage);

	const assetPlan = await runAssetGenerator({
		strategist,
		visualDirector,
		sourceContent: content,
		availableImages,
		model,
		signal,
	});
	mergedUsage = mergeOpenRouterUsage(mergedUsage, assetPlan.usage);

	return {
		strategist,
		visualDirector,
		renderPlan: assetPlan.renderPlan,
		usage: mergedUsage,
	};
}

export {
	scrapeBlogContent,
	collectImageCandidates,
	pickCenterContent,
	renderSceneClip,
	synthesizeSegmentAudio,
	concatMediaFiles,
	muxVideoAudio,
	rmDirSafe,
};
