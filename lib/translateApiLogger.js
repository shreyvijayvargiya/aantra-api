/**
 * Firestore audit logs for translate POST APIs (admin panel).
 * Collection: translation-api-logs (override via TRANSLATION_API_LOGS_COLLECTION).
 */
import { v4 as uuidv4 } from "uuid";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../config/firebase.js";
import { TRANSLATE_AUTH_CONTEXT_KEY } from "./translateFirebaseAuth.js";

export const TRANSLATION_API_LOGS_COLLECTION =
	process.env.TRANSLATION_API_LOGS_COLLECTION?.trim() || "translation-api-logs";

const MAX_STRING_LEN = 4000;
const REDACT_KEYS = new Set([
	"authorization",
	"audio_base64",
	"audioBase64",
	"password",
	"token",
	"id_token",
]);

function isLoggingEnabled() {
	const raw = process.env.TRANSLATION_API_LOGS_ENABLED;
	if (raw === undefined || String(raw).trim() === "") return true;
	const s = String(raw).trim().toLowerCase();
	return !(s === "0" || s === "false" || s === "no" || s === "off");
}

/**
 * @param {import("hono").Context} c
 */
export function clientIpFromContext(c) {
	const xff = c.req.header("x-forwarded-for");
	return (
		xff?.split(",")?.[0]?.trim() ||
		c.req.header("x-real-ip") ||
		c.req.header("cf-connecting-ip") ||
		"unknown"
	);
}

/**
 * @param {unknown} value
 * @param {number} depth
 */
export function sanitizeForTranslationLog(value, depth = 0) {
	if (depth > 10) return "[MaxDepth]";
	if (value == null) return value;
	if (typeof value === "bigint") return value.toString();
	if (Buffer.isBuffer(value)) {
		return { _type: "Buffer", byteLength: value.length };
	}
	if (typeof value === "string") {
		if (value.length > MAX_STRING_LEN) {
			return `${value.slice(0, MAX_STRING_LEN)}…[truncated ${value.length} chars]`;
		}
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeForTranslationLog(item, depth + 1));
	}
	if (typeof value === "object") {
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const [key, val] of Object.entries(value)) {
			const lower = key.toLowerCase();
			if (REDACT_KEYS.has(lower) || lower.includes("base64")) {
				if (val == null) out[key] = null;
				else if (typeof val === "string") {
					out[key] = `[redacted:${val.length} chars]`;
				} else {
					out[key] = "[redacted]";
				}
				continue;
			}
			out[key] = sanitizeForTranslationLog(val, depth + 1);
		}
		return out;
	}
	return String(value);
}

/**
 * @param {unknown} results
 */
function summarizeResults(results) {
	if (!Array.isArray(results)) return null;
	return results.map((row) => ({
		language: row?.language ?? null,
		transcript_length:
			typeof row?.transcript === "string" ? row.transcript.length : null,
		has_audio_url: Boolean(row?.audio_url || row?.audioUrl),
		has_audio_base64: Boolean(row?.audio_base64),
		audio_format: row?.audio_format ?? row?.audioFormat ?? null,
	}));
}

/**
 * @param {object} responseSummary
 * @param {number} httpStatus
 * @returns {"success" | "failed"}
 */
export function resolveTranslationLogStatus(responseSummary, httpStatus) {
	const code = Number(httpStatus) || 0;
	if (code < 200 || code >= 400) return "failed";
	if (responseSummary?.success === false) return "failed";
	return "success";
}

/**
 * @param {string} path
 */
export function inferTranslateApiKindFromPath(path) {
	if (path.includes("video-translate") && !path.endsWith("/text")) {
		return "video_translate";
	}
	return "voice_translate";
}

/**
 * @param {string} path
 */
export function inferTranslateProviderFromPath(path) {
	return path.startsWith("/api/groq/") ? "groq" : "openrouter";
}

/**
 * @param {import("hono").Context} c
 * @param {string} [routeLabel]
 */
export function buildFallbackTranslateApiLogContext(c, routeLabel) {
	const path = c.req.path;
	const label =
		routeLabel ||
		path.replace(/^\/api\//, "").replace(/\/$/, "") ||
		"unknown";
	return {
		startedAt: Date.now(),
		routeLabel: label,
		provider: inferTranslateProviderFromPath(path),
		apiKind: inferTranslateApiKindFromPath(path),
		requestId: null,
		clientIp: clientIpFromContext(c),
		requestParams: {},
	};
}

/**
 * @param {object | null | undefined} payload
 * @param {number} status
 */
export function summarizeTranslateApiResponse(payload, status) {
	const code = Number(status) || 0;
	const hasError =
		payload?.error != null ||
		payload?.success === false ||
		(typeof payload?.code === "string" && payload.code !== "OK");
	const success = code >= 200 && code < 400 && !hasError;
	const logStatus = success ? "success" : "failed";

	return {
		status: logStatus,
		success,
		http_status: code,
		code: payload?.code ?? null,
		error: payload?.error ?? null,
		message: payload?.message ?? null,
		video_translate_id:
			payload?.data?.video_translate_id ??
			(Array.isArray(payload?.data?.video_translate_ids)
				? payload.data.video_translate_ids
				: null),
		caption_url: payload?.data?.caption_url ?? null,
		source_type: payload?.data?.source_type ?? null,
		source_text_length:
			typeof payload?.data?.source_text === "string"
				? payload.data.source_text.length
				: null,
		language_count: Array.isArray(payload?.data?.results)
			? payload.data.results.length
			: null,
		results: summarizeResults(payload?.data?.results),
		pipeline: payload?.data?.pipeline ?? null,
	};
}

/**
 * @param {object | null | undefined} payload
 * @param {Record<string, unknown> | null | undefined} requestParams
 */
function extractLlmLogFields(payload, requestParams) {
	return {
		model:
			payload?.data?.model ??
			requestParams?.model ??
			requestParams?.llm_model ??
			null,
		llm_preset: payload?.data?.llm_preset ?? requestParams?.llm_preset ?? null,
		transcribe_model: payload?.data?.transcribe_model ?? null,
		translation_engine:
			payload?.data?.pipeline?.translation ??
			requestParams?.translation_engine ??
			null,
		bulk_mt_model:
			payload?.data?.pipeline?.bulk_mt_model ??
			requestParams?.bulk_mt_model ??
			null,
		glossary_refinement:
			payload?.data?.pipeline?.glossary_refinement ??
			requestParams?.glossary_refinement ??
			null,
		glossary_refine_model: requestParams?.glossary_refine_model ?? null,
		source_nllb: requestParams?.source_nllb ?? null,
		usage: payload?.usage ?? null,
		token_usage: payload?.tokenUsage ?? null,
		upstream_status: payload?.upstream_status ?? null,
	};
}

/**
 * @param {object | null | undefined} payload
 * @param {Record<string, unknown> | null | undefined} requestParams
 */
function extractTtsLogFields(payload, requestParams) {
	const pipeline = payload?.data?.pipeline ?? {};
	return {
		tts_engine: pipeline.tts ?? requestParams?.tts_engine ?? null,
		tts_voice: pipeline.tts_voice ?? requestParams?.tts_voice ?? null,
		tts_voice_id:
			pipeline.tts_voice_id ??
			requestParams?.brand_voice_id ??
			requestParams?.voice_id ??
			null,
		brand_voice_id: requestParams?.brand_voice_id ?? null,
		piper_model: requestParams?.piper_model ?? null,
		include_audio: requestParams?.include_audio ?? null,
	};
}

/**
 * @param {import("hono").Context} c
 */
function extractAuthLogFields(c) {
	try {
		if (typeof c.get !== "function") {
			return { auth_type: null, user_uid: null };
		}
		const ctx = c.get(TRANSLATE_AUTH_CONTEXT_KEY);
		return {
			auth_type: ctx?.type ?? null,
			user_uid: ctx?.uid ?? null,
		};
	} catch {
		return { auth_type: null, user_uid: null };
	}
}

/**
 * Persist one translate POST invocation (fire-and-forget from handlers).
 *
 * @param {{
 *   c: import("hono").Context,
 *   routeLabel: string,
 *   payload: object,
 *   status: number,
 *   startedAt: number,
 *   requestParams?: Record<string, unknown>,
 *   provider?: string,
 *   apiKind?: string,
 *   requestId?: string,
 *   clientIp?: string,
 * }} opts
 */
export async function recordTranslationApiLog(opts) {
	if (!isLoggingEnabled()) return;

	const {
		c,
		routeLabel,
		payload,
		status,
		startedAt,
		requestParams = {},
		provider = "openrouter",
		apiKind = null,
		requestId = null,
		clientIp = null,
	} = opts;

	const logId = uuidv4();
	const responseSummary = summarizeTranslateApiResponse(payload, status);
	const auth = extractAuthLogFields(c);
	const logStatus = resolveTranslationLogStatus(responseSummary, status);

	const doc = {
		id: logId,
		status: logStatus,
		route: routeLabel,
		path: c.req.path,
		method: c.req.method,
		http_status: Number(status) || 0,
		success: responseSummary.success,
		request_id: requestId,
		client_ip: clientIp ?? clientIpFromContext(c),
		user_agent: (c.req.header("user-agent") || "").slice(0, 512) || null,
		auth_type: auth.auth_type,
		user_uid: auth.user_uid,
		provider,
		api_kind: apiKind,
		content_type: (c.req.header("content-type") || "").slice(0, 256) || null,
		request_params: sanitizeForTranslationLog(requestParams),
		response: sanitizeForTranslationLog(responseSummary),
		pipeline: responseSummary.pipeline ?? null,
		llm: sanitizeForTranslationLog(extractLlmLogFields(payload, requestParams)),
		tts: sanitizeForTranslationLog(extractTtsLogFields(payload, requestParams)),
		error: responseSummary.error,
		error_code: payload?.code ?? null,
		duration_ms: Math.max(0, Date.now() - startedAt),
		created_at: FieldValue.serverTimestamp(),
		created_at_ms: Date.now(),
	};

	try {
		await firestore.collection(TRANSLATION_API_LOGS_COLLECTION).doc(logId).set(doc);
	} catch (e) {
		console.error(
			`[translation-api-log] failed to write ${TRANSLATION_API_LOGS_COLLECTION}/${logId}:`,
			e?.message || e,
		);
	}

	return logId;
}

/**
 * @param {import("hono").Context} c
 * @param {string} routeLabel
 * @param {object} payload
 * @param {number} status
 * @param {object | null | undefined} logMeta
 */
export function scheduleTranslationApiLog(c, routeLabel, payload, status, logMeta) {
	if (!isLoggingEnabled()) return;
	const meta =
		logMeta && typeof logMeta === "object"
			? logMeta
			: buildFallbackTranslateApiLogContext(c, routeLabel);
	void recordTranslationApiLog({
		c,
		routeLabel,
		payload,
		status,
		...meta,
	}).catch((e) => {
		console.error("[translation-api-log] schedule failed:", e?.message || e);
	});
}

/**
 * Log middleware auth / credit blocks (before handler runs).
 * @param {import("hono").Context} c
 * @param {object} payload
 * @param {number} status
 */
export function scheduleMiddlewareTranslateApiLog(c, payload, status) {
	if (!isLoggingEnabled()) return;
	const routeLabel = c.req.path.replace(/^\/api\//, "") || "unknown";
	scheduleTranslationApiLog(c, routeLabel, payload, status, {
		...buildFallbackTranslateApiLogContext(c, routeLabel),
		requestParams: { blocked_by: "translate_auth_middleware" },
	});
}

/** Hono context key for per-request translate API log metadata. */
export const TRANSLATE_API_LOG_CONTEXT_KEY = "translateApiLogContext";

/**
 * @param {import("hono").Context} c
 * @param {{
 *   routeLabel: string,
 *   provider?: string,
 *   apiKind: string,
 *   requestId: string,
 *   clientIp: string,
 *   initialParams?: Record<string, unknown>,
 * }} opts
 */
export function setTranslateApiLogContext(c, opts) {
	if (typeof c.set !== "function") return;
	c.set(TRANSLATE_API_LOG_CONTEXT_KEY, {
		startedAt: Date.now(),
		routeLabel: opts.routeLabel,
		provider: opts.provider ?? "openrouter",
		apiKind: opts.apiKind,
		requestId: opts.requestId,
		clientIp: opts.clientIp,
		requestParams: { ...(opts.initialParams || {}) },
	});
}

/**
 * @param {import("hono").Context} c
 * @param {Record<string, unknown>} params
 */
export function appendTranslateApiLogParams(c, params) {
	if (typeof c.get !== "function") return;
	const ctx = c.get(TRANSLATE_API_LOG_CONTEXT_KEY);
	if (!ctx || !params) return;
	ctx.requestParams = { ...ctx.requestParams, ...params };
}

/**
 * @param {import("hono").Context} c
 */
export function getTranslateApiLogContext(c) {
	try {
		if (typeof c.get !== "function") return null;
		return c.get(TRANSLATE_API_LOG_CONTEXT_KEY) ?? null;
	} catch {
		return null;
	}
}
