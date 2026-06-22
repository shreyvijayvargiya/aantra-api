/**
 * Dimension-aware caption layout for short-form vertical/horizontal video burn-in.
 */

const INDIC_NLLB_SUFFIXES = /_(Deva|Beng|Taml|Telu|Gujr|Mlym|Knda)$/;

/**
 * @param {{ width: number, height: number, style?: "top"|"bottom", nllb?: string | null }}
 */
export function computeCaptionLayout({ width, height, style = "bottom", nllb = null }) {
	const w = Math.max(240, Math.round(Number(width) || 360));
	const h = Math.max(240, Math.round(Number(height) || 640));
	const isVertical = h >= w;
	const isIndic = nllb ? INDIC_NLLB_SUFFIXES.test(nllb) : false;

	// Scale font from frame width (~4–5% of width for mobile shorts).
	const fontSize = Math.max(
		14,
		Math.min(isVertical ? 26 : 32, Math.round(w * (isIndic ? 0.048 : 0.042))),
	);

	const marginH = Math.max(16, Math.round(w * 0.07));
	const marginV = Math.max(
		20,
		Math.round(h * (style === "top" ? 0.07 : 0.1)),
	);

	const glyphFactor = isIndic ? 0.72 : 0.52;
	const maxCharsPerLine = Math.max(
		8,
		Math.floor((w - marginH * 2) / (fontSize * glyphFactor)),
	);
	const maxLinesPerCue = 2;
	const maxCharsPerCue = maxCharsPerLine * maxLinesPerCue;

	return {
		width: w,
		height: h,
		fontSize,
		marginH,
		marginV,
		maxCharsPerLine,
		maxLinesPerCue,
		maxCharsPerCue,
		style: style === "top" ? "top" : "bottom",
		alignment: style === "top" ? 8 : 2,
	};
}

function splitWords(text) {
	return String(text || "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}

/** Wrap text into lines respecting max chars; Indic may lack spaces — fall back to char chunks. */
export function wrapTextToLines(text, maxCharsPerLine, maxLines = 2) {
	const t = String(text || "").trim();
	if (!t) return [];
	if (t.length <= maxCharsPerLine) return [t];

	const words = splitWords(t);
	if (words.length <= 1) {
		const lines = [];
		for (let i = 0; i < t.length && lines.length < maxLines; i += maxCharsPerLine) {
			lines.push(t.slice(i, i + maxCharsPerLine));
		}
		return lines;
	}

	const lines = [];
	let current = "";
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (candidate.length <= maxCharsPerLine) {
			current = candidate;
			continue;
		}
		if (current) lines.push(current);
		current = word.length <= maxCharsPerLine ? word : word.slice(0, maxCharsPerLine);
		if (lines.length >= maxLines) break;
	}
	if (current && lines.length < maxLines) lines.push(current);
	return lines.slice(0, maxLines);
}

function splitLongTextIntoChunks(text, maxChars) {
	const t = String(text || "").trim();
	if (t.length <= maxChars) return [t];

	const words = splitWords(t);
	if (words.length <= 1) {
		const chunks = [];
		for (let i = 0; i < t.length; i += maxChars) {
			chunks.push(t.slice(i, i + maxChars));
		}
		return chunks;
	}

	const chunks = [];
	let current = "";
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (candidate.length <= maxChars) {
			current = candidate;
			continue;
		}
		if (current) chunks.push(current);
		if (word.length > maxChars) {
			for (let i = 0; i < word.length; i += maxChars) {
				chunks.push(word.slice(i, i + maxChars));
			}
			current = "";
		} else {
			current = word;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

/**
 * Split long cues, wrap to max 2 lines, subdivide timing for readability on small screens.
 * @param {Array<{start_ms:number,end_ms:number,text:string}>} segments
 */
export function reflowSegmentsForVideo(segments, layout) {
	const {
		maxCharsPerLine,
		maxLinesPerCue,
		maxCharsPerCue,
	} = layout;
	const out = [];

	for (const seg of segments) {
		const text = String(seg?.text ?? "").trim();
		if (!text) continue;
		const startMs = Math.floor(seg.start_ms);
		const endMs = Math.floor(seg.end_ms);
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
			continue;
		}

		const chunks =
			text.length <= maxCharsPerCue
				? [text]
				: splitLongTextIntoChunks(text, maxCharsPerCue);

		const totalDur = endMs - startMs;
		const slice = Math.max(300, Math.floor(totalDur / chunks.length));

		chunks.forEach((chunk, i) => {
			const lines = wrapTextToLines(chunk, maxCharsPerLine, maxLinesPerCue);
			const cueStart = startMs + i * slice;
			const cueEnd =
				i === chunks.length - 1 ? endMs : Math.min(endMs, cueStart + slice);
			if (cueEnd <= cueStart) return;
			out.push({
				start_ms: cueStart,
				end_ms: cueEnd,
				text: lines.join("\n"),
				ass_text: lines.join("\\N"),
			});
		});
	}

	return out;
}

function msToAssTime(ms) {
	const total = Math.max(0, Math.floor(ms));
	const h = Math.floor(total / 3_600_000);
	const m = Math.floor((total % 3_600_000) / 60_000);
	const s = Math.floor((total % 60_000) / 1000);
	const cs = Math.floor((total % 1000) / 10);
	return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * ASS subtitle file with PlayResX/Y matching video — libass scales font correctly.
 */
export function buildAssContent(segments, layout, fontName = "Arial Unicode MS") {
	const {
		width,
		height,
		fontSize,
		marginH,
		marginV,
		alignment,
	} = layout;
	const safeFont = String(fontName).replace(/,/g, "");

	const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${safeFont},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,2,0,${alignment},${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

	const events = segments
		.map((seg) => {
			const line = String(seg.ass_text ?? seg.text ?? "").replace(/\r?\n/g, "\\N");
			return `Dialogue: 0,${msToAssTime(seg.start_ms)},${msToAssTime(seg.end_ms)},Cap,,0,0,0,,${line}`;
		})
		.join("\n");

	return `${header}${events}\n`;
}
