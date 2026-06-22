/**
 * Parse JSON objects from LLM chat completions (markdown fences, trailing commas, truncation).
 */

export function extractMessageText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p) => p && (p.type === "text" || p.type === "output_text"))
			.map((p) => String(p.text ?? ""))
			.join("");
	}
	return "";
}

function stripMarkdownJsonFence(raw) {
	let t = String(raw || "").trim();
	t = t
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/m, "")
		.trim();
	return t;
}

/**
 * First balanced `{...}` in text, respecting JSON strings.
 */
export function extractFirstJsonObjectString(t) {
	const start = t.indexOf("{");
	if (start === -1) throw new SyntaxError("No JSON object in model output");
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < t.length; i++) {
		const c = t[i];
		if (inString) {
			if (escape) {
				escape = false;
				continue;
			}
			if (c === "\\") {
				escape = true;
				continue;
			}
			if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return t.slice(start, i + 1);
		}
	}
	throw new SyntaxError("Unterminated JSON in model output");
}

/** Strip trailing commas before } or ] (common model mistake). */
function tryRepairJsonText(jsonStr) {
	const candidates = new Set([jsonStr]);
	candidates.add(jsonStr.replace(/,\s*([}\]])/g, "$1"));
	candidates.add(
		jsonStr.replace(/,\s*([}\]])/g, "$1").replace(/,\s*([}\]])/g, "$1"),
	);
	return [...candidates];
}

function tryParseJsonObjectString(jsonStr) {
	let lastErr;
	for (const candidate of tryRepairJsonText(jsonStr)) {
		try {
			return JSON.parse(candidate);
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr instanceof Error ? lastErr : new SyntaxError("Invalid JSON in model output");
}

/** Close truncated `{ "transcript": "...", "segments": [ {...}, {...` payloads. */
function salvageTruncatedJsonObject(t) {
	const start = t.indexOf("{");
	if (start === -1) return null;
	const body = t.slice(start);
	const lastSegEnd = body.lastIndexOf('"}');
	if (lastSegEnd === -1) return null;
	const prefix = body.slice(0, lastSegEnd + 2);
	const suffixes = ['"}]}', '"} ] }', '"]}'];
	for (const suffix of suffixes) {
		try {
			return tryParseJsonObjectString(prefix + suffix);
		} catch {
			/* try next */
		}
	}
	return null;
}

/** Regex salvage for caption-shaped JSON when structure is cut off mid-stream. */
export function salvageCaptionPayload(raw) {
	const t = stripMarkdownJsonFence(raw);
	const transcriptMatch = t.match(/"transcript"\s*:\s*"((?:\\.|[^"\\])*)"/s);
	let transcript = "";
	if (transcriptMatch) {
		try {
			transcript = JSON.parse(`"${transcriptMatch[1]}"`);
		} catch {
			transcript = transcriptMatch[1];
		}
	}

	const segments = [];
	const segRe =
		/\{\s*"start_ms"\s*:\s*(\d+)\s*,\s*"end_ms"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}/g;
	let m;
	while ((m = segRe.exec(t)) !== null) {
		let text = m[3];
		try {
			text = JSON.parse(`"${m[3]}"`);
		} catch {
			/* keep raw */
		}
		segments.push({
			start_ms: Number(m[1]),
			end_ms: Number(m[2]),
			text: String(text).trim(),
		});
	}

	if (!transcript && !segments.length) return null;
	return {
		transcript: String(transcript || "").trim(),
		segments,
		_salvaged: true,
	};
}

export function parseJsonObjectFromModel(raw) {
	const text = extractMessageText(raw);
	if (!text) throw new SyntaxError("Empty model output");
	const t = stripMarkdownJsonFence(text);
	const jsonStr = extractFirstJsonObjectString(t);
	return tryParseJsonObjectString(jsonStr);
}

/**
 * Parse caption JSON; on truncation tries structural repair then regex salvage.
 */
export function parseCaptionJsonFromModel(raw) {
	const text = extractMessageText(raw);
	if (!text) throw new SyntaxError("Empty model output");
	const t = stripMarkdownJsonFence(text);

	try {
		const jsonStr = extractFirstJsonObjectString(t);
		return tryParseJsonObjectString(jsonStr);
	} catch (primaryErr) {
		try {
			const salvaged = salvageTruncatedJsonObject(t);
			if (salvaged) return salvaged;
		} catch {
			/* fall through */
		}
		const payload = salvageCaptionPayload(t);
		if (payload && (payload.transcript || payload.segments?.length)) {
			return payload;
		}
		throw primaryErr;
	}
}
