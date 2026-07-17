/**
 * Zod-validated JSON from OpenRouter for /api/video-translate/long only.
 */
import { z } from "zod";
import { extractMessageText, parseJsonObjectFromModel } from "./parseModelJson.js";

function stripMarkdownJsonFence(raw) {
	let t = String(raw || "").trim();
	return t
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/m, "")
		.trim();
}

const FIELD_ALIASES = {
	translation: ["translation", "translated_text", "text", "result", "output"],
	transcript: ["transcript", "transcription", "text"],
};

function decodePartialJsonString(raw) {
	let v = String(raw || "")
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
	if (v.endsWith("\\")) v = v.slice(0, -1);
	return v
		.replace(/"\s*}\s*$/, "")
		.replace(/"\s*,\s*"[^"]+"\s*:[\s\S]*$/, "")
		.replace(/"\s*,\s*$/, "")
		.trim();
}

/** Keep ISO-ish hints only; drop garbage salvaged into source_language. */
export function normalizeSourceLanguageHint(raw) {
	if (raw == null) return undefined;
	const s = String(raw).trim();
	if (!s || s.length > 12) return undefined;
	const primary = s.split(/[-_\s(,]/)[0].toLowerCase();
	if (primary.length < 2) return undefined;
	return primary.slice(0, 12);
}

/**
 * @param {string} text stripped model text
 * @returns {string | undefined}
 */
function salvageSourceLanguageFromModelJson(text) {
	const t = stripMarkdownJsonFence(text);
	const completeRe = /"source_language"\s*:\s*"((?:\\.|[^"\\])*)"/s;
	const m = t.match(completeRe);
	if (!m) return undefined;
	let raw;
	try {
		raw = JSON.parse(`"${m[1]}"`);
	} catch {
		raw = decodePartialJsonString(m[1]);
	}
	return normalizeSourceLanguageHint(raw);
}

/**
 * @param {string} text stripped model text
 * @param {string} field
 * @returns {string | null}
 */
function salvageStringFieldFromModelJsonInner(text, field) {
	const t = stripMarkdownJsonFence(text);

	const completeRe = new RegExp(
		`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`,
		"s",
	);
	let m = t.match(completeRe);
	if (m) {
		try {
			return JSON.parse(`"${m[1]}"`);
		} catch {
			return decodePartialJsonString(m[1]);
		}
	}

	const partialRe = new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*)$`, "i");
	m = t.match(partialRe);
	if (m?.[1]) {
		const v = decodePartialJsonString(m[1]);
		if (v) return v;
	}

	return null;
}

/**
 * Extract a string field from complete or truncated model JSON.
 * @param {unknown} raw
 * @param {string} field
 * @returns {string | null}
 */
export function salvageStringFieldFromModelJson(raw, field) {
	const text = extractMessageText(raw);
	if (!text) return null;

	const aliases = FIELD_ALIASES[field] || [field];
	for (const key of aliases) {
		const v = salvageStringFieldFromModelJsonInner(text, key);
		if (v?.trim()) return v.trim();
	}

	const t = stripMarkdownJsonFence(text).trim();
	if (!t) return null;

	// Plain text (model ignored JSON instruction)
	if (!/^\s*[\[{]/.test(t)) {
		return t;
	}

	// Broken/truncated JSON wrapper: {"translation":"...
	const broken = t.match(
		/^\s*\{\s*"(?:translation|transcript|translated_text|text)"\s*:\s*"?([\s\S]*)$/i,
	);
	if (broken?.[1]?.trim()) {
		const v = decodePartialJsonString(broken[1]);
		if (v) return v;
	}

	return null;
}

/** Audio ASR response shape for long-form pipeline. */
export const longFormTranscriptSchema = z.object({
	transcript: z.string().min(1, "transcript must be non-empty"),
	source_language: z
		.unknown()
		.optional()
		.transform((v) =>
			v == null ? undefined : normalizeSourceLanguageHint(String(v)),
		),
});

/** Text translation response shape for long-form pipeline. */
export const longFormTranslationSchema = z.object({
	translation: z.string().min(1, "translation must be non-empty"),
});

/**
 * Parse + validate model JSON with Zod; salvage truncated payloads for long jobs.
 * @template {import('zod').ZodTypeAny} T
 * @param {unknown} raw
 * @param {T} schema
 * @param {string} [salvagePrimaryField] - e.g. "transcript" or "translation"
 * @returns {import('zod').infer<T>}
 */
export function parseLongFormModelResponse(raw, schema, salvagePrimaryField) {
	const text = extractMessageText(raw);
	if (!text?.trim()) {
		throw new Error("Empty model output");
	}

	const failures = [];

	try {
		const obj = parseJsonObjectFromModel(text);
		return schema.parse(obj);
	} catch (e) {
		failures.push(e);
	}

	if (salvagePrimaryField) {
		const primary = salvageStringFieldFromModelJson(text, salvagePrimaryField);
		if (primary) {
			/** @type {Record<string, unknown>} */
			const salvaged = { [salvagePrimaryField]: primary };
			if (salvagePrimaryField === "transcript") {
				const lang = salvageSourceLanguageFromModelJson(text);
				if (lang) salvaged.source_language = lang;
			}
			try {
				return schema.parse(salvaged);
			} catch (e) {
				failures.push(e);
				// Transcript salvage is enough — drop bad optional source_language.
				if (
					salvagePrimaryField === "transcript" &&
					salvaged.source_language != null
				) {
					try {
						delete salvaged.source_language;
						return schema.parse(salvaged);
					} catch (retryErr) {
						failures.push(retryErr);
					}
				}
			}
		}
	}

	const last = failures[failures.length - 1];
	const msg =
		last instanceof z.ZodError
			? last.errors.map((x) => x.message).join("; ")
			: last instanceof Error
				? last.message
				: String(last);
	throw new Error(`Model JSON validation failed: ${msg}`);
}
