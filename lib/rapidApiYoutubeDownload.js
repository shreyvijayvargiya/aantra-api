/**
 * YouTube page URLs → MP4 via RapidAPI (YouTube Download & Info API).
 * Initial /api/download returns a job + progress_url; poll until download_url is ready.
 * Env: RAPID_API_KEY (required), RAPIDAPI_YT_HOST, RAPIDAPI_YT_FORMAT (optional).
 */

const RAPIDAPI_YT_HOST =
	process.env.RAPIDAPI_YT_HOST?.trim() ||
	"youtube-download-info-api.p.rapidapi.com";
const RAPIDAPI_YT_FORMAT =
	process.env.RAPIDAPI_YT_FORMAT?.trim() || "720";
const RAPIDAPI_YT_TIMEOUT_MS =
	Number.parseInt(process.env.RAPIDAPI_YT_TIMEOUT_MS || "", 10) || 600_000;
const RAPIDAPI_YT_PROGRESS_POLL_MS =
	Number.parseInt(process.env.RAPIDAPI_YT_PROGRESS_POLL_MS || "", 10) || 2_000;
const RAPIDAPI_YT_PROGRESS_MAX_MS =
	Number.parseInt(process.env.RAPIDAPI_YT_PROGRESS_MAX_MS || "", 10) ||
	300_000;

/** youtube.com / youtu.be / shorts / embed */
export function isYoutubeVideoUrl(url) {
	if (!url || typeof url !== "string") return false;
	return /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)/i.test(
		url.trim(),
	);
}

export function getRapidApiKey() {
	return process.env.RAPID_API_KEY?.trim() || "";
}

export function isRapidApiYoutubeConfigured() {
	return Boolean(getRapidApiKey());
}

/** Log RapidAPI YouTube readiness at server startup. */
export function logRapidApiYoutubeAtStartup() {
	if (isRapidApiYoutubeConfigured()) {
		console.log(
			`[rapidapi-yt] RAPID_API_KEY configured — YouTube via ${RAPIDAPI_YT_HOST} (format=${RAPIDAPI_YT_FORMAT})`,
		);
	} else {
		console.warn(
			"[rapidapi-yt] RAPID_API_KEY not set — YouTube URL downloads will fail",
		);
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickHttpUrl(value) {
	if (typeof value !== "string") return null;
	const s = value.trim();
	if (!s.startsWith("http://") && !s.startsWith("https://")) return null;
	// Never treat YouTube thumbnails as video downloads.
	if (/i\.ytimg\.com|ytimg\.com\/vi\//i.test(s)) return null;
	return s;
}

function isProgressComplete(payload) {
	if (!payload || typeof payload !== "object") return false;
	const obj = /** @type {Record<string, unknown>} */ (payload);
	const progress = Number(obj.progress);
	if (Number.isFinite(progress) && progress >= 1000) return true;
	const text = String(obj.text || obj.status || "").toLowerCase();
	return (
		text === "finished" ||
		text === "completed" ||
		text === "complete" ||
		text === "done"
	);
}

/**
 * Extract a direct media URL from RapidAPI JSON (field names vary by provider/version).
 * @param {unknown} data
 * @returns {string | null}
 */
export function extractDownloadUrlFromRapidApiPayload(data) {
	if (!data || typeof data !== "object") return null;

	const obj = /** @type {Record<string, unknown>} */ (data);
	const direct = [
		obj.download_url,
		obj.downloadUrl,
		obj.url,
		obj.link,
		obj.file,
		obj.fileUrl,
		obj.file_url,
		obj.directUrl,
		obj.direct_url,
		obj.video_url,
		obj.videoUrl,
		obj?.data && typeof obj.data === "object"
			? /** @type {Record<string, unknown>} */ (obj.data).download_url
			: null,
		obj?.data && typeof obj.data === "object"
			? /** @type {Record<string, unknown>} */ (obj.data).downloadUrl
			: null,
		obj?.data && typeof obj.data === "object"
			? /** @type {Record<string, unknown>} */ (obj.data).url
			: null,
		obj?.result && typeof obj.result === "object"
			? /** @type {Record<string, unknown>} */ (obj.result).url
			: null,
	];
	for (const c of direct) {
		const u = pickHttpUrl(c);
		if (u) return u;
	}

	if (Array.isArray(obj.medias)) {
		const preferred =
			obj.medias.find(
				(m) =>
					m &&
					typeof m === "object" &&
					/** @type {Record<string, unknown>} */ (m).videoAvailable !== false &&
					String(/** @type {Record<string, unknown>} */ (m).extension || "")
						.toLowerCase()
						.includes("mp4"),
			) || obj.medias[0];
		if (preferred && typeof preferred === "object") {
			const u = pickHttpUrl(
				/** @type {Record<string, unknown>} */ (preferred).url,
			);
			if (u) return u;
		}
	}

	return null;
}

/** RapidAPI progress payloads often include duration in seconds. */
export function parseRapidApiDurationSeconds(payload) {
	if (!payload || typeof payload !== "object") return null;
	const d = Number(/** @type {Record<string, unknown>} */ (payload).duration);
	return Number.isFinite(d) && d > 0 ? d : null;
}

/**
 * Poll progress_url until the provider exposes a final download_url.
 * @param {string} progressUrl
 * @param {AbortSignal} signal
 * @returns {Promise<{ downloadUrl: string, durationSec: number | null }>}
 */
async function pollRapidApiProgressUntilReady(progressUrl, signal) {
	const deadline = Date.now() + RAPIDAPI_YT_PROGRESS_MAX_MS;
	let lastPayload = null;
	let attempt = 0;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			const e = new Error("Download aborted");
			e.name = "AbortError";
			throw e;
		}

		attempt += 1;
		const res = await fetch(progressUrl, {
			signal,
			headers: { Accept: "application/json" },
		});
		const bodyText = await res.text().catch(() => "");
		if (!res.ok) {
			throw new Error(
				`Video download failed (rapidapi). Progress HTTP ${res.status}: ${bodyText.slice(0, 400)}`,
			);
		}

		let data;
		try {
			data = JSON.parse(bodyText);
		} catch {
			throw new Error(
				`Video download failed (rapidapi). Progress invalid JSON: ${bodyText.slice(0, 300)}`,
			);
		}
		lastPayload = data;

		const downloadUrl = extractDownloadUrlFromRapidApiPayload(data);
		if (downloadUrl && isProgressComplete(data)) {
			const durationSec = parseRapidApiDurationSeconds(data);
			console.log(
				`[rapidapi-yt] progress complete after ${attempt} poll(s)` +
					(durationSec != null ? ` duration=${Math.ceil(durationSec)}s` : ""),
			);
			return { downloadUrl, durationSec };
		}

		if (data?.success === 0 || data?.error) {
			throw new Error(
				`Video download failed (rapidapi). ${String(data.error || data.text || "progress error")}`,
			);
		}

		if (attempt === 1 || attempt % 5 === 0) {
			console.log(
				`[rapidapi-yt] progress poll ${attempt}: progress=${data?.progress ?? "?"} text=${data?.text ?? ""}`,
			);
		}

		await sleep(RAPIDAPI_YT_PROGRESS_POLL_MS);
	}

	throw new Error(
		`Video download failed (rapidapi). Progress timed out after ${RAPIDAPI_YT_PROGRESS_MAX_MS}ms: ${JSON.stringify(lastPayload).slice(0, 400)}`,
	);
}

/**
 * Call RapidAPI and return either a direct download URL or raw video bytes.
 * @param {string} youtubeUrl
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ kind: "url", url: string, durationSec?: number | null } | { kind: "buffer", buffer: Buffer, durationSec?: number | null }>}
 */
export async function resolveYoutubeRapidApiMedia(youtubeUrl, signal) {
	const key = getRapidApiKey();
	if (!key) {
		const e = new Error(
			"RAPID_API_KEY not configured (required for YouTube video download)",
		);
		e.code = "MISSING_RAPID_API_KEY";
		throw e;
	}

	const trimmed = String(youtubeUrl || "").trim();
	if (!isYoutubeVideoUrl(trimmed)) {
		throw new Error("resolveYoutubeRapidApiMedia: not a YouTube URL");
	}

	const params = new URLSearchParams({
		url: trimmed,
		format: RAPIDAPI_YT_FORMAT,
	});
	const apiUrl = `https://${RAPIDAPI_YT_HOST}/api/download?${params.toString()}`;

	const reqSignal = signal || AbortSignal.timeout(RAPIDAPI_YT_TIMEOUT_MS);

	console.log(
		`[rapidapi-yt] GET /api/download format=${RAPIDAPI_YT_FORMAT} url=${trimmed.slice(0, 100)}`,
	);

	const res = await fetch(apiUrl, {
		signal: reqSignal,
		redirect: "follow",
		headers: {
			"x-rapidapi-key": key,
			"x-rapidapi-host": RAPIDAPI_YT_HOST,
			Accept: "application/json, video/mp4, application/octet-stream, */*",
		},
	});

	const contentType = (res.headers.get("content-type") || "").toLowerCase();
	if (
		res.ok &&
		(contentType.includes("video/") ||
			contentType.includes("octet-stream") ||
			contentType.includes("application/mp4"))
	) {
		const buffer = Buffer.from(await res.arrayBuffer());
		if (!buffer.length) {
			throw new Error("RapidAPI YouTube download returned empty video body");
		}
		return { kind: "buffer", buffer };
	}

	const bodyText = await res.text().catch(() => "");
	if (!res.ok) {
		throw new Error(
			`Video download failed (rapidapi). HTTP ${res.status}: ${bodyText.slice(0, 600)}`,
		);
	}

	let data;
	try {
		data = JSON.parse(bodyText);
	} catch {
		throw new Error(
			`Video download failed (rapidapi). Invalid JSON: ${bodyText.slice(0, 400)}`,
		);
	}

	let downloadUrl = extractDownloadUrlFromRapidApiPayload(data);
	let durationSec = parseRapidApiDurationSeconds(data);
	if (!downloadUrl) {
		const progressUrl = pickHttpUrl(data.progress_url);
		if (!progressUrl) {
			throw new Error(
				`Video download failed (rapidapi). No download URL or progress_url in response: ${bodyText.slice(0, 500)}`,
			);
		}
		console.log(`[rapidapi-yt] async job ${data.id || "?"} — polling progress`);
		const polled = await pollRapidApiProgressUntilReady(progressUrl, reqSignal);
		downloadUrl = polled.downloadUrl;
		durationSec = polled.durationSec ?? durationSec;
	}

	return { kind: "url", url: downloadUrl, durationSec };
}

/** Reject thumbnails, JSON error pages, or empty payloads before ffprobe. */
export function assertValidVideoBuffer(buf) {
	if (!buf?.length || buf.length < 1024) {
		throw new Error(
			"Video download failed (rapidapi). Downloaded file is too small to be a valid video",
		);
	}
	const ftyp = buf.length >= 12 && buf.slice(4, 8).toString("ascii") === "ftyp";
	const webm = buf.slice(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
	const id3 = buf.slice(0, 3).toString() === "ID3";
	if (ftyp || webm || id3) return;
	const head = buf
		.slice(0, 64)
		.toString("utf8")
		.replace(/[^\x20-\x7e]+/g, " ")
		.trim()
		.slice(0, 80);
	throw new Error(
		`Video download failed (rapidapi). Response is not a valid video file${head ? ` (${head})` : ""}`,
	);
}
