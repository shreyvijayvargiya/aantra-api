/**
 * Classify OpenRouter API failures for structured client responses.
 * Frontend should branch on `code`; show `user_message` to users (not raw upstream text).
 */

export function isTranslateDevMode() {
	if (process.env.TRANSLATE_DEV_ERRORS === "1") return true;
	if (process.env.VIDEO_CAPTION_DEV_ERRORS === "1") return true;
	return process.env.NODE_ENV !== "production";
}

/**
 * @param {{ message?: string, httpStatus?: number }} input
 * @returns {{
 *   code: string,
 *   user_message: string,
 *   message: string,
 *   upstream_status: number | null,
 *   httpStatus: number,
 *   retryable: boolean,
 * }}
 */
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
	const o = err instanceof OpenRouterApiError ? err : openRouterErrorFromUnknown(err);
	console.warn(
		`[${scope}][dev] OpenRouter ${o.code}` +
			(o.upstream_status ? ` upstream=${o.upstream_status}` : "") +
			`: ${o.message}`,
	);
}

export function jobFailureFieldsFromError(err) {
	const o = err instanceof OpenRouterApiError ? err : openRouterErrorFromUnknown(err);
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

export function publicJobErrorFromDoc(d) {
	if (!d || d.status !== "failed") {
		return { error: null, error_code: null, user_message: null };
	}
	if (d.error_code && d.user_message) {
		return {
			error: d.error || d.user_message,
			error_code: d.error_code,
			user_message: d.user_message,
			...(isTranslateDevMode() && d.error_detail
				? { error_detail: d.error_detail }
				: {}),
			...(isTranslateDevMode() && d.error_upstream_status
				? { error_upstream_status: d.error_upstream_status }
				: {}),
		};
	}
	const classified = classifyOpenRouterError({
		message: d.error || "Job failed",
		httpStatus: d.error_upstream_status,
	});
	return {
		error: d.error || classified.message,
		error_code: classified.code,
		user_message: classified.user_message,
		...(isTranslateDevMode() ? { error_detail: d.error || classified.message } : {}),
	};
}
