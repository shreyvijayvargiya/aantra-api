import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FFMPEG_FALLBACK_PATHS = [
	"/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
	"/usr/local/opt/ffmpeg-full/bin/ffmpeg",
	"/opt/homebrew/bin/ffmpeg",
	"/usr/local/bin/ffmpeg",
	"/usr/bin/ffmpeg",
];

const FFPROBE_FALLBACK_PATHS = [
	"/opt/homebrew/opt/ffmpeg-full/bin/ffprobe",
	"/usr/local/opt/ffmpeg-full/bin/ffprobe",
	"/opt/homebrew/bin/ffprobe",
	"/usr/local/bin/ffprobe",
	"/usr/bin/ffprobe",
];

const SUBTITLE_FFMPEG_HINT =
	" Caption burn-in needs ffmpeg with libass (subtitles filter). On macOS: brew install ffmpeg-full, then set FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg. On Linux/Docker: apt install ffmpeg.";

function resolveBinary(envVar, fallbackPaths, defaultName) {
	const fromEnv = process.env[envVar]?.trim();
	if (fromEnv && existsSync(fromEnv)) return fromEnv;

	for (const p of fallbackPaths) {
		if (existsSync(p)) return p;
	}

	return defaultName;
}

function uniquePaths(paths) {
	const seen = new Set();
	const out = [];
	for (const p of paths) {
		const s = String(p || "").trim();
		if (!s || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return out;
}

export function getFfmpegBin() {
	return resolveBinary("FFMPEG_PATH", FFMPEG_FALLBACK_PATHS, "ffmpeg");
}

export function getFfprobeBin() {
	return resolveBinary("FFPROBE_PATH", FFPROBE_FALLBACK_PATHS, "ffprobe");
}

export async function ffmpegSupportsSubtitlesFilter(bin) {
	try {
		const { stdout, stderr } = await execFileAsync(bin, ["-filters"], {
			timeout: 15_000,
			maxBuffer: 8 * 1024 * 1024,
		});
		const listing = `${stdout}\n${stderr}`;
		return /\bsubtitles\b/.test(listing) || /\b ass \b/.test(listing);
	} catch {
		return false;
	}
}

function subtitleFfmpegCandidates() {
	return uniquePaths([
		process.env.FFMPEG_SUBTITLES_PATH?.trim(),
		process.env.FFMPEG_PATH?.trim(),
		...FFMPEG_FALLBACK_PATHS,
		"ffmpeg",
	]);
}

let subtitlesFfmpegPromise;

/**
 * FFmpeg binary that can burn SRT/ASS via the `subtitles`/`ass` filter (libass).
 * Falls back past FFMPEG_PATH when that build lacks libass (common on Homebrew macOS).
 */
export async function getFfmpegBinForSubtitles() {
	if (!subtitlesFfmpegPromise) {
		subtitlesFfmpegPromise = (async () => {
			for (const candidate of subtitleFfmpegCandidates()) {
				if (candidate !== "ffmpeg" && !existsSync(candidate)) continue;
				if (await ffmpegSupportsSubtitlesFilter(candidate)) return candidate;
			}
			throw new Error(
				`No ffmpeg binary with subtitles/ass filter found.${SUBTITLE_FFMPEG_HINT}`,
			);
		})().catch((err) => {
			subtitlesFfmpegPromise = undefined;
			throw err;
		});
	}
	return subtitlesFfmpegPromise;
}

export function buildSubtitlesBurnFilter(
	subFileName,
	style = "bottom",
	{ fontName = "Arial Unicode MS", fontSize = 22, marginH = 24, marginV = 72 } = {},
) {
	const alignment = style === "top" ? 8 : 2;
	const escapedName = String(subFileName)
		.replace(/\\/g, "/")
		.replace(/:/g, "\\:")
		.replace(/'/g, "\\'")
		.replace(/,/g, "\\,");
	// ASS files carry PlayRes + Style; SRT fallback still uses force_style.
	if (/\.ass$/i.test(subFileName)) {
		return `subtitles=${escapedName}`;
	}
	const escapedFont = String(fontName).replace(/'/g, "\\'").replace(/,/g, "\\,");
	const forceStyle = [
		`Fontname=${escapedFont}`,
		`Fontsize=${fontSize}`,
		"Bold=-1",
		`Alignment=${alignment}`,
		"PrimaryColour=&H00FFFFFF",
		"OutlineColour=&H00000000",
		"BorderStyle=1",
		"Outline=2",
		"Shadow=0",
		`MarginL=${marginH}`,
		`MarginR=${marginH}`,
		`MarginV=${marginV}`,
		"WrapStyle=0",
	]
		.join("\\,")
		.replace(/'/g, "\\'");
	return `subtitles=${escapedName}:force_style=${forceStyle}`;
}
