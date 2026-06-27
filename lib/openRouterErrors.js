/**
 * Classify OpenRouter API failures for structured client responses.
 * Frontend should branch on `code`; show `user_message` to users (not raw upstream text).
 */

export function isTranslateDevMode() {
	if (process.env.TRANSLATE_DEV_ERRORS === "1") return true;
	if (process.env.VIDEO_CAPTION_DEV_ERRORS === "1") return true;
	return process.env.NODE_ENV !== "production";
}

/** User-facing copy keyed by product feature (not raw upstream text). */
const FEATURE_JOB_MESSAGES = {
	caption: {
		openrouter_fallback:
			"AI caption generation failed. Please try again in a few minutes.",
		storage: "Caption progress could not be saved. Please try again.",
		scrape: "Could not read the source content. Check the URL and try again.",
		render: "Video processing failed. Please try again.",
		upload: "Upload failed. Please try again.",
		generic: "Caption generation failed. Please try again.",
	},
	blog_to_video: {
		openrouter_fallback:
			"AI video generation failed. Please try again in a few minutes.",
		storage: "Video progress could not be saved. Please try again.",
		scrape: "Could not read that blog URL. Check the link and try again.",
		render: "Video rendering failed. Please try again.",
		upload: "Video upload failed. Please try again.",
		generic: "Blog-to-video generation failed. Please try again.",
	},
};

function featureJobMessage(feature, key) {
	const bucket = FEATURE_JOB_MESSAGES[feature] || FEATURE_JOB_MESSAGES.caption;
	return bucket[key] || bucket.generic;
}

function remapFeatureUserMessage(classified, feature) {
	if (feature === "caption") return classified;
	const out = { ...classified };
	if (out.code === "OPENROUTER_ERROR" || !out.user_message) {
		out.user_message = featureJobMessage(feature, "openrouter_fallback");
	} else if (out.code === "OPENROUTER_TIMEOUT") {
		out.user_message =
			feature === "blog_to_video"
				? "Video generation took too long. Try a shorter article or lower target duration."
				: out.user_message;
	} else if (out.code === "OPENROUTER_RATE_LIMITED") {
		out.user_message = "Too many requests. Please wait a moment and try again.";
	} else if (
		out.code === "OPENROUTER_INSUFFICIENT_BALANCE" ||
		out.code === "OPENROUTER_AUTH_ERROR"
	) {
		out.user_message =
			feature === "blog_to_video"
				? "Video generation is temporarily unavailable. Please try again later."
				: out.user_message;
	}
	return out;
}

/**
 * Classify job failures (OpenRouter, Firestore, scrape, render, upload, etc.).
 * @param {unknown} err
 * @param {{ feature?: 'caption' | 'blog_to_video' }} [options]
 */
export function classifyJobError(err, { feature = "caption" } = {}) {
	if (err instanceof OpenRouterApiError) {
		return remapFeatureUserMessage(
			{
				code: err.code,
				user_message: err.user_message,
				message: err.message,
				upstream_status: err.upstream_status,
				httpStatus: err.httpStatus,
				retryable: err.retryable,
			},
			feature,
		);
	}

	const raw = String(err?.message || err || "Job failed").trim();
	const lower = raw.toLowerCase();

	if (
		/cannot use "undefined" as a firestore value|ignoreundefinedproperties/i.test(
			raw,
		) ||
		(/firestore/i.test(raw) && /invalid|failed|error/i.test(raw))
	) {
		return {
			code: "STORAGE_ERROR",
			user_message: featureJobMessage(feature, "storage"),
			message: raw,
			upstream_status: null,
			httpStatus: 500,
			retryable: true,
		};
	}

	if (/blog scrape failed|scrape returned empty/i.test(lower)) {
		return {
			code: "SCRAPE_FAILED",
			user_message: featureJobMessage(feature, "scrape"),
			message: raw,
			upstream_status: null,
			httpStatus: 502,
			retryable: true,
		};
	}

	if (/ffmpeg|ffprobe/i.test(lower)) {
		return {
			code: "RENDER_FAILED",
			user_message: featureJobMessage(feature, "render"),
			message: raw,
			upstream_status: null,
			httpStatus: 500,
			retryable: true,
		};
	}

	if (/uploadthing failed/i.test(lower)) {
		return {
			code: "UPLOAD_FAILED",
			user_message: featureJobMessage(feature, "upload"),
			message: raw,
			upstream_status: null,
			httpStatus: 502,
			retryable: true,
		};
	}

	if (
		/content strategist returned|visual director returned|asset generator returned|no scenes rendered/i.test(
			lower,
		)
	) {
		return {
			code: "AI_PLANNING_FAILED",
			user_message: featureJobMessage(feature, "openrouter_fallback"),
			message: raw,
			upstream_status: null,
			httpStatus: 502,
			retryable: true,
		};
	}

	if (
		/is not defined|referenceerror|syntaxerror|typeerror|cannot read propert/i.test(
			lower,
		)
	) {
		return {
			code: "INTERNAL_RENDER_ERROR",
			user_message: featureJobMessage(feature, "render"),
			message: raw,
			upstream_status: null,
			httpStatus: 500,
			retryable: true,
		};
	}

	return remapFeatureUserMessage(
		classifyOpenRouterError({ message: raw, httpStatus: err?.httpStatus }),
		feature,
	);
}

export function classifyOpenRouterError(input) {
	const raw = String(input?.message || "OpenRouter request failed").trim();
	const upstream = Number(input?.httpStatus) || null;
	const lower = raw.toLowerCase();

	let code = "OPENROUTER_ERROR";
	let user_message =
		"AI caption generation failed. Please try again in a few minutes.";
	let httpStatus = 502;
	let retryable = false;

	if (
		/(balance|credit|payment|billing|top[\s-]?up|purchase credits|requires at least \$)/i.test(
			lower,
		)
	) {
		code = "OPENROUTER_INSUFFICIENT_BALANCE";
		user_message =
			"Caption generation is temporarily unavailable. Please try again later.";
		httpStatus = 503;
		retryable = true;
	} else if (upstream === 402) {
		code = "OPENROUTER_INSUFFICIENT_BALANCE";
		user_message =
			"Caption generation is temporarily unavailable. Please try again later.";
		httpStatus = 503;
		retryable = true;
	} else if (upstream === 429 || /rate limit|too many requests/i.test(lower)) {
		code = "OPENROUTER_RATE_LIMITED";
		user_message = "Too many requests. Please wait a moment and try again.";
		httpStatus = 429;
		retryable = true;
	} else if (
		upstream === 401 ||
		upstream === 403 ||
		/invalid.*api key|authentication|unauthorized|forbidden/i.test(lower)
	) {
		code = "OPENROUTER_AUTH_ERROR";
		user_message = "Caption generation is temporarily unavailable.";
		httpStatus = 503;
	} else if (/timeout|timed out|abort/i.test(lower)) {
		code = "OPENROUTER_TIMEOUT";
		user_message = "Caption generation took too long. Try a shorter video.";
		httpStatus = 504;
		retryable = true;
	}

	return {
		code,
		user_message,
		message: raw,
		upstream_status: upstream,
		httpStatus,
		retryable,
	};
}

export class OpenRouterApiError extends Error {
	constructor(classified) {
		super(classified.message);
		this.name = "OpenRouterApiError";
		this.code = classified.code;
		this.user_message = classified.user_message;
		this.upstream_status = classified.upstream_status;
		this.httpStatus = classified.httpStatus;
		this.retryable = classified.retryable;
	}
}

export function openRouterErrorFromResponse(chatRes, chatData) {
	const message = String(
		chatData?.error?.message || chatData?.error || `OpenRouter HTTP ${chatRes.status}`,
	);
	return new OpenRouterApiError(
		classifyOpenRouterError({ message, httpStatus: chatRes.status }),
	);
}

export function openRouterErrorFromUnknown(err) {
	if (err instanceof OpenRouterApiError) return err;
	const message = err?.message || String(err);
	return new OpenRouterApiError(classifyOpenRouterError({ message }));
}

/** Dev-only console detail (OpenRouter balance, upstream codes). */
export function logOpenRouterErrorDev(scope, err) {
	if (!isTranslateDevMode()) return;
	if (err instanceof OpenRouterApiError) {
		console.warn(
			`[${scope}][dev] OpenRouter ${err.code}` +
				(err.upstream_status ? ` upstream=${err.upstream_status}` : "") +
				`: ${err.message}`,
		);
		return;
	}
	const message = err?.message || String(err);
	console.warn(`[${scope}][dev] ${err?.name || "Error"}: ${message}`);
}

export function jobFailureFieldsFromError(err, { feature = "caption" } = {}) {
	const o = classifyJobError(err, { feature });
	const fields = {
		status: "failed",
		error: o.message,
		error_code: o.code,
		user_message: o.user_message,
		error_retryable: o.retryable,
		updatedAt: undefined,
	};
	if (isTranslateDevMode()) {
		fields.error_detail = o.message;
		if (o.upstream_status) fields.error_upstream_status = o.upstream_status;
	}
	return fields;
}

export function publicJobErrorFromDoc(d, { feature = "caption" } = {}) {
	if (!d || d.status !== "failed") {
		return { error: null, error_code: null, user_message: null };
	}
	if (d.error_code && d.user_message) {
		return {
			error: d.user_message,
			error_code: d.error_code,
			user_message: d.user_message,
			...(d.error_retryable != null ? { error_retryable: d.error_retryable } : {}),
			...(isTranslateDevMode() && d.error_detail
				? { error_detail: d.error_detail }
				: {}),
			...(isTranslateDevMode() && d.error_upstream_status
				? { error_upstream_status: d.error_upstream_status }
				: {}),
		};
	}
	const classified = classifyJobError(
		{ message: d.error || "Job failed", httpStatus: d.error_upstream_status },
		{ feature },
	);
	return {
		error: classified.user_message,
		error_code: classified.code,
		user_message: classified.user_message,
		error_retryable: classified.retryable,
		...(isTranslateDevMode() ? { error_detail: d.error || classified.message } : {}),
	};
}
