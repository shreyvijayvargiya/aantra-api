/**
 * SEO keyword + competitor helpers using free sources only:
 * - Google suggest (suggestqueries.google.com)
 * - DuckDuckGo HTML SERP (fetch + cheerio)
 * - Google Custom Search API when GOOGLE_CSE_ID + key set (same as /google-search)
 * - Google PageSpeed Insights API when GOOGLE_PAGESPEED_API_KEY or GOOGLE_API_KEY (LCP/CLS/TTFB)
 * - Google Trends (google-trends-api, unofficial but free)
 * - Optional OpenRouter for short summaries (OPENROUTER_API_KEY)
 */
import { load } from "cheerio";
import googleTrends from "google-trends-api";
import { fetch } from "undici";
import { performance } from "node:perf_hooks";
import { z } from "zod";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const STOP = new Set(
	`a an the and or but if in on at to for of as is was are were be been being it this that these those with from by not no so we you your our they their will can could should would about into over after before then than also just only same such when what which who how why all any each few more most other some such than very one two may might must shall will would about into through during including against among throughout despite towards upon concerning to from up down out off over under again further then once here there when where why how all both each few more most other some such no nor not only own same so than too very can will just should now`
		.split(/\s+/),
);

function extractDuckDuckGoRedirectUrl(href) {
	if (!href || typeof href !== "string") return null;
	try {
		const u = href.startsWith("//") ? `https:${href}` : href;
		if (u.startsWith("http")) {
			const p = new URL(u);
			const uddg = p.searchParams.get("uddg");
			if (uddg) return decodeURIComponent(uddg);
		}
	} catch {
		/* ignore */
	}
	const m = href.match(/uddg=([^&]+)/);
	if (m) {
		try {
			return decodeURIComponent(m[1]);
		} catch {
			return m[1];
		}
	}
	return null;
}

function parseDuckDuckGoSerpHtml(html, maxResults = 15) {
	const results = [];
	const $ = load(html);
	$("div.result").each((_, el) => {
		if (results.length >= maxResults) return false;
		const linkTag = $(el).find(".result__a");
		const href = linkTag.attr("href") || "";
		const title = linkTag.text().trim();
		const description = $(el).find(".result__snippet").text().trim();
		const link = extractDuckDuckGoRedirectUrl(href);
		if (link && title) {
			results.push({ title, link, description });
		}
	});
	return results;
}

async function fetchDdgSerp(query, maxResults = 10) {
	const endpoints = [
		`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
		`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
	];
	for (const searchUrl of endpoints) {
		try {
			const res = await fetch(searchUrl, {
				headers: {
					"User-Agent": UA,
					Accept: "text/html,application/xhtml+xml",
					"Accept-Language": "en-US,en;q=0.9",
				},
				redirect: "follow",
			});
			if (!res.ok) continue;
			const html = await res.text();
			const results = parseDuckDuckGoSerpHtml(html, maxResults);
			if (results.length > 0) {
				return { results, searchUrl };
			}
		} catch {
			continue;
		}
	}
	return { results: [], searchUrl: null };
}

function assertPublicHttpUrl(urlString) {
	let u;
	try {
		u = new URL(urlString);
	} catch {
		throw new Error("Invalid URL");
	}
	if (!["http:", "https:"].includes(u.protocol)) {
		throw new Error("Only http(s) URLs are allowed");
	}
	const host = u.hostname.toLowerCase();
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "0.0.0.0" ||
		host.startsWith("127.") ||
		host === "::1" ||
		host.startsWith("169.254.") ||
		host.startsWith("10.") ||
		host.startsWith("192.168.")
	) {
		throw new Error("Private / local URLs are not allowed");
	}
}

async function fetchPageHtml(url) {
	const res = await fetch(url, {
		headers: {
			"User-Agent": UA,
			Accept: "text/html,application/xhtml+xml",
			"Accept-Language": "en-US,en;q=0.9",
		},
		redirect: "follow",
		signal: AbortSignal.timeout(25000),
	});
	if (!res.ok) throw new Error(`Failed to fetch page: HTTP ${res.status}`);
	const ct = res.headers.get("content-type") || "";
	if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
		throw new Error("URL does not return HTML");
	}
	return await res.text();
}

function extractOnPageSeo(html, pageUrl) {
	const $ = load(html);
	const base = new URL(pageUrl);
	const title = $("title").first().text().replace(/\s+/g, " ").trim();
	const metaDesc =
		$('meta[name="description"]').attr("content") ||
		$('meta[property="og:description"]').attr("content") ||
		"";
	const canonical =
		$('link[rel="canonical"]').attr("href") || pageUrl;
	const robots = $('meta[name="robots"]').attr("content") || null;
	const ogTitle = $('meta[property="og:title"]').attr("content") || "";
	const ogImage = $('meta[property="og:image"]').attr("content") || "";
	const h1 = $("h1")
		.map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
		.get()
		.filter(Boolean)
		.slice(0, 5);
	const h2 = $("h2")
		.map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
		.get()
		.filter(Boolean)
		.slice(0, 12);
	const lang = $("html").attr("lang") || null;

	const bodyText = $("body").text().replace(/\s+/g, " ").trim();
	const wordCount = bodyText
		? bodyText.split(/\s+/).filter(Boolean).length
		: 0;

	let internalLinks = 0;
	let externalLinks = 0;
	$("a[href]").each((_, el) => {
		const h = $(el).attr("href") || "";
		if (h.startsWith("#") || h.startsWith("javascript:")) return;
		try {
			const abs = new URL(h, pageUrl);
			if (abs.hostname === base.hostname) internalLinks++;
			else if (abs.protocol.startsWith("http")) externalLinks++;
		} catch {
			/* ignore */
		}
	});

	const images = $("img");
	let imagesWithAlt = 0;
	let imagesTotal = images.length;
	images.each((_, el) => {
		const alt = ($(el).attr("alt") || "").trim();
		if (alt.length > 0) imagesWithAlt++;
	});

	return {
		title,
		metaDescription: metaDesc.trim(),
		canonical,
		robots,
		ogTitle: ogTitle.trim(),
		ogImage: ogImage.trim(),
		h1,
		h2,
		htmlLang: lang,
		wordCount,
		readingMinutesApprox: Math.max(1, Math.round(wordCount / 200)),
		links: { internal: internalLinks, external: externalLinks },
		images: { total: imagesTotal, withAlt: imagesWithAlt },
	};
}

function extractTechnicalSeoSignals(html, pageUrl) {
	const $ = load(html);
	const u = new URL(pageUrl);
	const hasViewport = !!$('meta[name="viewport"]').length;
	const hasJsonLd = $('script[type="application/ld+json"]').length > 0;
	const hasCharset = !!$('meta[charset]').length || !!$('meta[http-equiv="Content-Type"]').length;
	const hreflang = $('link[rel="alternate"][hreflang]')
		.map((_, el) => $(el).attr("hreflang"))
		.get()
		.filter(Boolean);
	return {
		https: u.protocol === "https:",
		hasCanonical: !!$('link[rel="canonical"]').length,
		hasViewport,
		hasJsonLd,
		hasCharset,
		hreflangCount: hreflang.length,
	};
}

/**
 * SERP results using Google Custom Search when configured, else DuckDuckGo HTML (same strategy as /google-search).
 */
async function fetchSerpResults(query, num = 8) {
	const capped = Math.min(Math.max(Number(num) || 8, 1), 10);
	const apiKey =
		process.env.GOOGLE_CSE_API_KEY || process.env.GOOGLE_API_KEY;
	const cx = process.env.GOOGLE_CSE_ID;
	if (apiKey && cx) {
		try {
			const params = new URLSearchParams({
				key: apiKey,
				cx,
				q: query,
				num: String(capped),
			});
			const res = await fetch(
				`https://www.googleapis.com/customsearch/v1?${params}`,
				{ signal: AbortSignal.timeout(20000) },
			);
			const data = await res.json().catch(() => ({}));
			if (res.ok && Array.isArray(data.items)) {
				const results = data.items.map((it) => ({
					title: it.title || "",
					link: it.link || "",
					description: it.snippet || "",
				}));
				return {
					results,
					source: "google-custom-search-api",
					searchQuery: query,
				};
			}
		} catch {
			/* fall through to DDG */
		}
	}
	const ddg = await fetchDdgSerp(query, capped);
	return {
		results: ddg.results,
		source: "duckduckgo-html",
		searchQuery: query,
		searchUrl: ddg.searchUrl,
	};
}

async function checkUrlReachable(targetUrl, timeoutMs = 9000) {
	try {
		const res = await fetch(targetUrl, {
			method: "HEAD",
			redirect: "follow",
			signal: AbortSignal.timeout(timeoutMs),
			headers: { "User-Agent": UA },
		});
		if (res.status === 405 || res.status === 501 || res.status === 403) {
			const res2 = await fetch(targetUrl, {
				method: "GET",
				redirect: "follow",
				signal: AbortSignal.timeout(timeoutMs),
				headers: { "User-Agent": UA },
			});
			return res2.status >= 200 && res2.status < 400;
		}
		return res.status >= 200 && res.status < 400;
	} catch {
		return false;
	}
}

async function extractLinkAnalysis(html, pageUrl, options = {}) {
	const maxBrokenChecks = options.maxBrokenChecks ?? 45;
	const $ = load(html);
	const base = new URL(pageUrl);
	const anchors = [];
	const internalPaths = new Set();

	$("a[href]").each((_, el) => {
		const raw = ($(el).attr("href") || "").trim();
		if (!raw || raw.startsWith("#") || raw.toLowerCase().startsWith("javascript:")) {
			return;
		}
		let abs;
		try {
			abs = new URL(raw, pageUrl);
		} catch {
			return;
		}
		if (!abs.protocol.startsWith("http")) return;
		const text = $(el).text().replace(/\s+/g, " ").trim().slice(0, 200);
		const isInternal = abs.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
		if (isInternal) {
			internalPaths.add(abs.pathname + abs.search);
		}
		anchors.push({
			href: abs.href,
			anchorText: text || "(no text)",
			isInternal,
		});
	});

	const broken = [];
	const toCheck = anchors
		.filter((a) => !a.isInternal)
		.slice(0, maxBrokenChecks);
	for (let i = 0; i < toCheck.length; i += 5) {
		const batch = toCheck.slice(i, i + 5);
		await Promise.all(
			batch.map(async (a) => {
				const ok = await checkUrlReachable(a.href);
				if (!ok) broken.push({ href: a.href, anchorText: a.anchorText });
			}),
		);
	}

	const opportunities = [];
	$("h2, h3").each((_, el) => {
		const $el = $(el);
		const t = $el.text().replace(/\s+/g, " ").trim();
		if (t.length < 12 || opportunities.length >= 12) return;
		const hasChildLink = $el.find("a[href]").length > 0;
		if (!hasChildLink) {
			opportunities.push({
				type: "heading_without_link",
				heading: t.slice(0, 160),
				suggestion:
					"Add a contextual internal or external link from this heading to a relevant resource.",
			});
		}
	});
	if (internalPaths.size >= 2) {
		opportunities.push({
			type: "internal_link_mesh",
			suggestion:
				"Cross-link related sections: ensure pillar pages and sibling articles reference each other where topics overlap.",
			pathsSample: [...internalPaths].slice(0, 8),
		});
	}

	return {
		summary: {
			internal: anchors.filter((a) => a.isInternal).length,
			external: anchors.filter((a) => !a.isInternal).length,
			total: anchors.length,
		},
		anchors: anchors.slice(0, 80),
		broken,
		opportunities,
	};
}

async function measureTtfbApprox(pageUrl) {
	const t0 = performance.now();
	try {
		const res = await fetch(pageUrl, {
			redirect: "follow",
			signal: AbortSignal.timeout(22000),
			headers: {
				"User-Agent": UA,
				Accept: "text/html,application/xhtml+xml",
			},
		});
		const reader = res.body?.getReader?.();
		if (!reader) {
			await res.text();
			return {
				ttfbMs: Math.round(performance.now() - t0),
				note: "Approximate time-to-first-byte (full response if streaming unavailable).",
			};
		}
		await reader.read();
		await reader.cancel();
		return {
			ttfbMs: Math.round(performance.now() - t0),
			note: "Approximate time to first byte (first chunk).",
		};
	} catch (e) {
		return { ttfbMs: null, error: e?.message || "ttfb_failed" };
	}
}

async function fetchPageSpeedInsights(pageUrl) {
	const key =
		process.env.GOOGLE_PAGESPEED_API_KEY ||
		process.env.GOOGLE_API_KEY ||
		process.env.GOOGLE_CSE_API_KEY;
	if (!key) return null;
	try {
		const params = new URLSearchParams({
			url: pageUrl,
			key,
			category: "performance",
			strategy: "mobile",
		});
		const res = await fetch(
			`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`,
			{ signal: AbortSignal.timeout(120_000) },
		);
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			return {
				error: data?.error?.message || `PageSpeed HTTP ${res.status}`,
			};
		}
		const lh = data?.lighthouseResult;
		const audits = lh?.audits || {};
		const cats = lh?.categories || {};
		const perfScore = cats?.performance?.score != null
			? Math.round(cats.performance.score * 100)
			: null;
		const g = (id) => audits[id];
		const num = (id) => {
			const a = g(id);
			const v = a?.numericValue;
			return v != null && Number.isFinite(v) ? v : null;
		};
		const disp = (id) => g(id)?.displayValue || g(id)?.title || null;
		return {
			source: "pagespeed-insights-v5",
			strategy: "mobile",
			pageSpeedScore: perfScore,
			lcp: {
				valueMs: num("largest-contentful-paint"),
				display: disp("largest-contentful-paint"),
			},
			cls: {
				value: num("cumulative-layout-shift"),
				display: disp("cumulative-layout-shift"),
			},
			ttfb: {
				valueMs: num("server-response-time"),
				display: disp("server-response-time"),
			},
			firstContentfulPaint: {
				valueMs: num("first-contentful-paint"),
				display: disp("first-contentful-paint"),
			},
			speedIndex: {
				valueMs: num("speed-index"),
				display: disp("speed-index"),
			},
		};
	} catch (e) {
		return { error: e?.message || "pagespeed_failed" };
	}
}

async function buildPerformanceMetrics(pageUrl) {
	const [psi, ttfbApprox] = await Promise.all([
		fetchPageSpeedInsights(pageUrl),
		measureTtfbApprox(pageUrl),
	]);
	if (psi && !psi.error && psi.source) {
		return {
			...psi,
			labNote:
				"LCP/CLS/TTFB from Google PageSpeed Insights (mobile). Requires GOOGLE_PAGESPEED_API_KEY or GOOGLE_API_KEY.",
			fallbackTtfbProbe: ttfbApprox,
		};
	}
	return {
		source: "fetch-probe",
		pageSpeedScore: null,
		lcp: { valueMs: null, display: "Set GOOGLE_API_KEY for PageSpeed Insights (free quota)." },
		cls: { value: null, display: null },
		ttfb: {
			valueMs: ttfbApprox.ttfbMs,
			display:
				ttfbApprox.ttfbMs != null
					? `~${ttfbApprox.ttfbMs} ms (first-byte probe)`
					: null,
		},
		note: "Full Web Vitals need PageSpeed API. TTFB here is a simple first-chunk probe from this server.",
	};
}

function scoreOnPageSub(onPage) {
	let s = 0;
	if (onPage.title?.length >= 15 && onPage.title?.length <= 70) s += 28;
	else if (onPage.title) s += 10;
	if (onPage.metaDescription?.length >= 50 && onPage.metaDescription?.length <= 170) {
		s += 28;
	} else if (onPage.metaDescription) s += 8;
	if (onPage.h1?.length === 1) s += 22;
	else if (onPage.h1?.length > 1) s += 8;
	else s += 0;
	if (onPage.ogImage) s += 12;
	if (onPage.h2?.length >= 2) s += 10;
	return Math.min(100, s);
}

function scoreTechnicalSub(tech) {
	let s = 0;
	if (tech.https) s += 25;
	if (tech.hasCanonical) s += 20;
	if (tech.hasViewport) s += 20;
	if (tech.hasJsonLd) s += 18;
	if (tech.hasCharset) s += 7;
	if (tech.hreflangCount > 0) s += 10;
	return Math.min(100, s);
}

function scoreContentSub(onPage, linkAnalysis) {
	let s = 0;
	const wc = onPage.wordCount || 0;
	if (wc >= 1200) s += 35;
	else if (wc >= 600) s += 25;
	else if (wc >= 300) s += 15;
	else s += 5;
	const img = onPage.images;
	if (img?.total && img.withAlt / img.total > 0.6) s += 25;
	else if (img?.total) s += 10;
	const li = linkAnalysis?.summary;
	if (li && li.internal >= 3) s += 20;
	else if (li && li.internal >= 1) s += 10;
	if (li && li.external >= 1 && li.external <= 25) s += 10;
	if ((onPage.h2?.length || 0) >= 3) s += 10;
	return Math.min(100, s);
}

function buildKeywordScore({ onPage, technical, linkAnalysis, performanceMetrics }) {
	const onP = scoreOnPageSub(onPage);
	const tech = scoreTechnicalSub(technical);
	const content = scoreContentSub(onPage, linkAnalysis);
	let overall = Math.round(onP * 0.34 + tech * 0.33 + content * 0.33);
	const pss = performanceMetrics?.pageSpeedScore;
	if (typeof pss === "number") {
		if (pss < 50) overall = Math.max(0, overall - 12);
		else if (pss < 90) overall = Math.max(0, overall - 5);
	}
	overall = Math.max(0, Math.min(100, overall));
	return {
		overall,
		breakdown: {
			onPage: onP,
			technical: tech,
			content,
		},
		...(typeof pss === "number" && {
			note: `Overall nudged by mobile PageSpeed score (${pss}). Breakdown is on-page / technical / content only.`,
		}),
	};
}

function inferContentPatterns(titles) {
	const patterns = new Set();
	for (const t of titles) {
		const s = (t || "").toLowerCase();
		if (/\b(vs\.?|versus|compare|comparison)\b/.test(s)) patterns.add("comparison articles");
		if (/\b(top \d+|best \d+|best |ranked)\b/.test(s)) patterns.add("listicles");
		if (/\b(how to|guide|tutorial|step[s]?)\b/.test(s)) patterns.add("how-to guides");
		if (/\b(review|rating|g2)\b/.test(s)) patterns.add("reviews");
		if (/\b(alternative|alternatives)\b/.test(s)) patterns.add("alternatives roundups");
	}
	return [...patterns];
}

function topDomainsFromResults(rows, excludeHost, limit = 12) {
	const counts = new Map();
	for (const r of rows) {
		const h = hostOf(r.link || r.url || "");
		if (!h || h === excludeHost) continue;
		counts.set(h, (counts.get(h) || 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([domain, hits]) => ({ domain, hits }));
}

async function fetchHtmlWordCount(targetUrl) {
	try {
		const html = await fetchPageHtml(targetUrl);
		const text = load(html)("body").text().replace(/\s+/g, " ").trim();
		return text.split(/\s+/).filter(Boolean).length;
	} catch {
		return null;
	}
}

async function averageWordCountForUrls(urls, sample = 6) {
	const slice = urls.slice(0, sample);
	const counts = [];
	for (const u of slice) {
		const n = await fetchHtmlWordCount(u);
		if (n != null) counts.push(n);
	}
	if (!counts.length) return { avgWordCount: null, sampled: 0 };
	const sum = counts.reduce((a, b) => a + b, 0);
	return {
		avgWordCount: Math.round(sum / counts.length),
		sampled: counts.length,
		wordCounts: counts,
	};
}

function parseG2ProductHtml(html, pageUrl) {
	const $ = load(html);
	let rating = null;
	let reviewCount = null;
	$('script[type="application/ld+json"]').each((_, el) => {
		try {
			const raw = $(el).html();
			const j = JSON.parse(raw);
			const nodes = Array.isArray(j) ? j : [j];
			for (const node of nodes) {
				const ag = node?.aggregateRating;
				if (ag?.ratingValue != null) rating = Number(ag.ratingValue);
				if (ag?.reviewCount != null) reviewCount = Number(ag.reviewCount);
			}
		} catch {
			/* ignore */
		}
	});
	const title = $("h1").first().text().trim() || $("title").first().text().trim();
	return {
		pageUrl,
		productTitle: title.slice(0, 200),
		rating,
		reviewCount,
		note: "Parsed from JSON-LD where present; G2 markup changes may affect fields.",
	};
}

async function fetchG2ProductInsights(g2ResultUrl) {
	if (!g2ResultUrl || !g2ResultUrl.includes("g2.com")) return null;
	try {
		const html = await fetchPageHtml(g2ResultUrl);
		return parseG2ProductHtml(html, g2ResultUrl);
	} catch (e) {
		return { error: e?.message || "g2_fetch_failed", pageUrl: g2ResultUrl };
	}
}

function deriveSeedKeyword({ keyword, title, h1, url }) {
	if (keyword && String(keyword).trim()) {
		return String(keyword).trim().slice(0, 200);
	}
	if (h1 && h1[0]) {
		return h1[0].slice(0, 120);
	}
	if (title) {
		const t = title.split(/\s*[|\u2013\u2014-]\s*/)[0].trim();
		return t.slice(0, 120);
	}
	try {
		const host = new URL(url).hostname.replace(/^www\./, "");
		return host.split(".")[0] || "page";
	} catch {
		return "page";
	}
}

function topWordsFromText(text, limit = 30) {
	const raw = (text || "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
	const freq = new Map();
	for (const w of raw) {
		if (STOP.has(w)) continue;
		freq.set(w, (freq.get(w) || 0) + 1);
	}
	return [...freq.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([word, count]) => ({ word, count }));
}

async function getGoogleAutocompleteSuggestions(keyword) {
	const variants = [
		keyword,
		`${keyword} `,
		`how to ${keyword}`,
		`best ${keyword}`,
		`${keyword} for`,
	];
	const out = new Set();
	for (const q of variants) {
		try {
			const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`;
			const res = await fetch(url, {
				headers: { "User-Agent": UA, Accept: "application/json" },
				signal: AbortSignal.timeout(12000),
			});
			if (!res.ok) continue;
			const data = await res.json();
			const list = Array.isArray(data?.[1]) ? data[1] : [];
			for (const s of list) {
				if (typeof s === "string") out.add(s);
			}
		} catch {
			/* continue */
		}
	}
	return [...out];
}

async function getTrendsRelatedQueries(keyword, geo) {
	try {
		const raw = await googleTrends.relatedQueries({
			keyword,
			hl: "en-US",
			geo: geo || "US",
		});
		const j = JSON.parse(raw);
		const lists = j?.default?.rankedList || [];
		const top = (lists[0]?.rankedKeyword || []).map((r) => ({
			query: r.query,
			value: r.value,
			formattedValue: r.formattedValue,
		}));
		const rising = (lists[1]?.rankedKeyword || []).map((r) => ({
			query: r.query,
			value: r.value,
			formattedValue: r.formattedValue,
		}));
		return { top, rising };
	} catch (e) {
		return { top: [], rising: [], error: e?.message || "trends_failed" };
	}
}

async function getTrendsInterestOverTime(keyword, geo) {
	try {
		const raw = await googleTrends.interestOverTime({
			keyword,
			hl: "en-US",
			geo: geo || "US",
		});
		const j = JSON.parse(raw);
		const timeline = j?.default?.timelineData || [];
		const points = timeline.map((t) => ({
			time: t.formattedTime || t.time,
			value: Array.isArray(t.value) ? t.value[0] : t.value,
		}));
		const averages = j?.default?.averages || null;
		return {
			note: "Values are relative search interest (0–100), not absolute volume.",
			dataPoints: points.slice(-24),
			averages,
		};
	} catch (e) {
		return {
			note: "Interest over time unavailable.",
			dataPoints: [],
			error: e?.message || "trends_failed",
		};
	}
}

const OPENROUTER_PROMPT_SNIPPET_MAX = Math.min(
	32000,
	Math.max(
		4000,
		Number.parseInt(process.env.OPENROUTER_PROMPT_SNIPPET_MAX || "12000", 10) ||
			12000,
	),
);

function truncateMessagesForApiResponse(messages, maxPerPart = OPENROUTER_PROMPT_SNIPPET_MAX) {
	if (!Array.isArray(messages)) return [];
	return messages.map((m) => {
		const raw =
			typeof m.content === "string"
				? m.content
				: JSON.stringify(m.content ?? "");
		const truncated = raw.length > maxPerPart;
		return {
			role: m.role,
			content: truncated ? `${raw.slice(0, maxPerPart)}…` : raw,
			...(truncated && { truncated: true }),
		};
	});
}

async function openRouterBrief(system, user, maxOut = 900) {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key?.trim()) return null;
	const modelResolved =
		process.env.OPENROUTER_MODEL ||
		process.env.OPENROUTER_AGENT_MODEL ||
		"openai/gpt-4o-mini";
	const messages = [
		{ role: "system", content: system },
		{ role: "user", content: user.slice(0, 14000) },
	];
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		signal: AbortSignal.timeout(90_000),
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({
			model: modelResolved,
			messages,
			temperature: 0.35,
			max_tokens: maxOut,
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		return { error: data?.error?.message || `HTTP ${res.status}` };
	}
	const content = data?.choices?.[0]?.message?.content || "";
	const u = data?.usage;
	const usage = {
		prompt_tokens: u?.prompt_tokens ?? 0,
		completion_tokens: u?.completion_tokens ?? 0,
		total_tokens: u?.total_tokens ?? 0,
	};
	return {
		text: content.trim(),
		usage,
		tokenUsage: {
			promptTokens: usage.prompt_tokens,
			completionTokens: usage.completion_tokens,
			totalTokens: usage.total_tokens,
		},
		model: data?.model || modelResolved,
		aiPrompt: truncateMessagesForApiResponse(messages),
	};
}

const keywordBodySchema = z.object({
	url: z.string().url(),
	keyword: z.string().max(200).optional(),
	useAi: z.boolean().optional(),
	geo: z.string().length(2).optional().default("US"),
});

const competitorBodySchema = z.object({
	url: z.string().url(),
	useAi: z.boolean().optional(),
	geo: z.string().length(2).optional().default("US"),
});

const g2CompetitorDeepResearchSchema = z.object({
	url: z.string().url(),
	/** Override product / search phrase (otherwise derived from page or G2 URL). */
	query: z.string().max(200).optional(),
	maxCompetitors: z.number().min(3).max(25).optional().default(12),
	useAi: z.boolean().optional().default(true),
	geo: z.string().length(2).optional().default("US"),
});

function isG2ProductUrlString(str) {
	return /^https?:\/\/(www\.)?g2\.com\/products\//i.test(String(str || ""));
}

function normalizeG2ProductUrl(u) {
	try {
		const x = new URL(u);
		if (!/g2\.com$/i.test(x.hostname.replace(/^www\./, ""))) return null;
		return `${x.origin}${x.pathname.replace(/\/$/, "")}`;
	} catch {
		return null;
	}
}

function g2LabelFromProductUrl(pageUrl) {
	try {
		const p = new URL(pageUrl).pathname;
		const m = p.match(/\/products\/([^/?#]+)/);
		return m ? decodeURIComponent(m[1].replace(/-/g, " ")) : "";
	} catch {
		return "";
	}
}

/**
 * G2-focused competitor discovery: resolve anchor product on G2 (from URL or Google/DDG SERP),
 * then find competitor product pages via SERP. Enriches each with JSON-LD rating/reviews from HTML fetch.
 * Optional OpenRouter synthesis. For Puppeteer + full-page scrape, call the API route with deepScrape.
 */
export async function runG2CompetitorDeepResearch(raw) {
	const parsed = g2CompetitorDeepResearchSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(parsed.error.issues.map((e) => e.message).join("; "));
	}
	const { url, query: queryOverride, maxCompetitors, useAi } = parsed.data;
	assertPublicHttpUrl(url);

	let anchorUrl = null;
	let productLabel = (queryOverride && String(queryOverride).trim()) || "";

	if (isG2ProductUrlString(url)) {
		anchorUrl = normalizeG2ProductUrl(url);
		productLabel = productLabel || g2LabelFromProductUrl(url);
	} else {
		const html = await fetchPageHtml(url);
		const onPage = extractOnPageSeo(html, url);
		const seed = deriveSeedKeyword({
			keyword: queryOverride,
			title: onPage.title,
			h1: onPage.h1,
			url,
		});
		productLabel = productLabel || seed;

		const serp1 = await fetchSerpResults(`${seed} site:g2.com/products`, 10);
		let hit = (serp1.results || []).find((r) =>
			/g2\.com\/products\//i.test(r.link),
		);
		if (hit?.link) anchorUrl = normalizeG2ProductUrl(hit.link);
		if (!anchorUrl) {
			const serp2 = await fetchSerpResults(`${seed} g2 reviews`, 10);
			hit = (serp2.results || []).find((r) =>
				/g2\.com\/products\//i.test(r.link),
			);
			if (hit?.link) anchorUrl = normalizeG2ProductUrl(hit.link);
		}
	}

	const anchorInsights = anchorUrl
		? await fetchG2ProductInsights(anchorUrl)
		: null;

	if (!String(productLabel || "").trim()) {
		productLabel = "b2b software";
	}

	const searchQueries = [
		`${productLabel} alternatives site:g2.com`,
		`${productLabel} competitors site:g2.com`,
		`${productLabel} vs site:g2.com`,
	];
	const seen = new Set();
	if (anchorUrl) {
		const a = normalizeG2ProductUrl(anchorUrl);
		if (a) seen.add(a);
	}
	const rawCompetitors = [];
	for (const q of searchQueries) {
		const sr = await fetchSerpResults(q, 10);
		for (const row of sr.results || []) {
			const link = row.link;
			if (!link || !/g2\.com\/products\//i.test(link)) continue;
			const nu = normalizeG2ProductUrl(link);
			if (!nu || seen.has(nu)) continue;
			seen.add(nu);
			rawCompetitors.push({
				discoveredViaQuery: q,
				serpSource: sr.source,
				title: row.title || "",
				url: nu,
				snippet: row.description || "",
			});
			if (rawCompetitors.length >= maxCompetitors) break;
		}
		if (rawCompetitors.length >= maxCompetitors) break;
	}

	const competitors = [];
	for (const c of rawCompetitors) {
		const g2 = await fetchG2ProductInsights(c.url);
		competitors.push({
			...c,
			g2,
		});
	}

	let aiSynthesis = null;
	let g2BriefOpenRouter = null;
	if (useAi) {
		const r = await openRouterBrief(
			`You are a B2B software market analyst. Use ONLY the JSON below (G2 SERP snippets + JSON-LD fields when present). Output Markdown with:
## Anchor product (if any)
Short bullets: name, URL, rating/reviews if present.
## Competitors
For each competitor: **name**, link, rating/reviews if present, 1–2 differentiation angles implied by the snippet (no invented metrics).
## Risks / gaps
3–6 bullets on where buyers might compare products (generic, not fabricated).
If data is missing, say "insufficient data". Under 500 words.`,
			JSON.stringify({
				productLabel,
				anchor: anchorUrl
					? { url: anchorUrl, ...anchorInsights }
					: null,
				competitors: competitors.map((c) => ({
					title: c.title,
					url: c.url,
					snippet: c.snippet,
					g2: c.g2,
				})),
			}),
			2200,
		);
		aiSynthesis = r?.text || (r?.error ? String(r.error) : null);
		if (r && !r.error && r.usage) g2BriefOpenRouter = r;
	}

	return {
		timestamp: new Date().toISOString(),
		url,
		productLabel,
		anchorProduct: anchorUrl
			? { url: anchorUrl, ...anchorInsights }
			: null,
		competitors,
		serpDiscovery: {
			queriesUsed: searchQueries,
			note: "Competitor URLs are discovered via Google CSE (if configured) or DuckDuckGo HTML SERP.",
		},
		...(aiSynthesis && { aiSynthesis }),
		...(g2BriefOpenRouter && {
			usage: g2BriefOpenRouter.usage,
			tokenUsage: g2BriefOpenRouter.tokenUsage,
			model: g2BriefOpenRouter.model,
			aiPrompt: g2BriefOpenRouter.aiPrompt,
		}),
		note: "Ratings/reviews come from public HTML JSON-LD when available. For full-page scrape + structured problems/strengths, use POST /seo-g2-competitor-deep-research with deepScrape: true on the API server.",
	};
}

/**
 * Keyword / topic analysis: page SEO signals + suggestions + trends + DDG SERP context.
 */
export async function runKeywordAnalysis(raw) {
	const parsed = keywordBodySchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(parsed.error.issues.map((e) => e.message).join("; "));
	}
	const { url, keyword, useAi, geo } = parsed.data;
	assertPublicHttpUrl(url);

	const html = await fetchPageHtml(url);
	let onPage = extractOnPageSeo(html, url);
	const technical = extractTechnicalSeoSignals(html, url);
	const seed = deriveSeedKeyword({
		keyword,
		title: onPage.title,
		h1: onPage.h1,
		url,
	});

	const bodySample = load(html)("body").text().replace(/\s+/g, " ").slice(0, 8000);

	const [linkAnalysis, performanceMetrics, serpBundle] = await Promise.all([
		extractLinkAnalysis(html, url),
		buildPerformanceMetrics(url),
		Promise.all([
			getGoogleAutocompleteSuggestions(seed),
			getTrendsRelatedQueries(seed, geo),
			getTrendsInterestOverTime(seed, geo),
			fetchDdgSerp(seed, 10),
		]),
	]);

	const [autocompleteSuggestions, trendsRelated, trendsInterest, ddgSerp] =
		serpBundle;

	onPage = {
		...onPage,
		links: linkAnalysis.summary,
	};

	const contentKeywords = topWordsFromText(bodySample, 35);

	const score = buildKeywordScore({
		onPage,
		technical,
		linkAnalysis,
		performanceMetrics,
	});

	let aiBrief = null;
	let keywordBriefOpenRouter = null;
	if (useAi) {
		const payload = {
			url,
			seedKeyword: seed,
			onPageTitle: onPage.title,
			h1: onPage.h1,
			score,
			topContentTerms: contentKeywords.slice(0, 15),
			autocompleteSample: autocompleteSuggestions.slice(0, 12),
			trendsRelatedTop: trendsRelated.top?.slice(0, 8),
		};
		const r = await openRouterBrief(
			`You help content creators with SEO. Given JSON from free tools only, respond with 2 short sections in plain text: (1) "Angles" — 4 bullet ideas for blog posts. (2) "Keywords to weave in" — 6–10 phrases. No JSON, no hype, under 350 words.`,
			JSON.stringify(payload),
			700,
		);
		aiBrief = r?.text || r?.error || null;
		if (r && !r.error && r.usage) keywordBriefOpenRouter = r;
	}

	return {
		timestamp: new Date().toISOString(),
		url,
		seedKeyword: seed,
		geo,
		score,
		onPage,
		technicalSeo: technical,
		linkAnalysis,
		performanceMetrics,
		columns: {
			contentTermFrequency: contentKeywords,
			googleAutocomplete: autocompleteSuggestions,
			googleTrendsRelatedQueries: trendsRelated,
			googleTrendsInterestOverTime: trendsInterest,
			duckduckgoOrganicSerp: ddgSerp,
		},
		...(aiBrief && { aiBrief }),
		...(keywordBriefOpenRouter && {
			usage: keywordBriefOpenRouter.usage,
			tokenUsage: keywordBriefOpenRouter.tokenUsage,
			model: keywordBriefOpenRouter.model,
			aiPrompt: keywordBriefOpenRouter.aiPrompt,
		}),
	};
}

function hostOf(u) {
	try {
		return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

function heuristicSeoScore(onPage) {
	let score = 0;
	const reasons = [];
	if (onPage.title?.length >= 10 && onPage.title?.length <= 70) {
		score += 15;
		reasons.push("Title length reasonable");
	} else if (onPage.title) {
		reasons.push("Title length suboptimal for SERP display");
	}
	if (onPage.metaDescription?.length >= 50 && onPage.metaDescription?.length <= 170) {
		score += 15;
		reasons.push("Meta description present and length OK");
	} else {
		reasons.push("Improve meta description (roughly 50–160 chars)");
	}
	if (onPage.h1?.length === 1) {
		score += 15;
		reasons.push("Single H1");
	} else if (onPage.h1?.length > 1) {
		reasons.push("Multiple H1s — prefer one primary H1");
	} else {
		reasons.push("Missing H1");
	}
	if (onPage.ogImage) {
		score += 10;
		reasons.push("og:image set");
	}
	if (onPage.canonical) score += 10;
	if (onPage.images.total && onPage.images.withAlt / onPage.images.total > 0.5) {
		score += 10;
		reasons.push("Many images have alt text");
	}
	if (onPage.wordCount >= 300) {
		score += 10;
		reasons.push("Substantial body copy");
	}
	if (onPage.links.internal >= 3) score += 5;
	return { score: Math.min(100, score), checklist: reasons };
}

/**
 * Competitor-style audit: DDG + Google CSE/DDG SERP for Reddit & G2, optional G2 product scrape.
 */
export async function runCompetitorAudit(raw) {
	const parsed = competitorBodySchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(parsed.error.issues.map((e) => e.message).join("; "));
	}
	const { url, useAi, geo } = parsed.data;
	assertPublicHttpUrl(url);

	const html = await fetchPageHtml(url);
	const onPage = extractOnPageSeo(html, url);
	const seed = deriveSeedKeyword({
		keyword: null,
		title: onPage.title,
		h1: onPage.h1,
		url,
	});
	const selfHost = hostOf(url);

	const queries = [
		`${seed} alternatives`,
		`best ${seed}`,
		`${seed} vs`,
	];
	const redditQuery = `${seed} site:reddit.com`;
	const g2Query = `${seed} site:g2.com`;

	const redditSerpP = fetchSerpResults(redditQuery, 10);
	const g2SerpP = fetchSerpResults(g2Query, 8);
	const serpLists = await Promise.all(
		queries.map((q) => fetchDdgSerp(q, 6)),
	);
	const [redditSerp, g2Serp] = await Promise.all([redditSerpP, g2SerpP]);

	const redditResults = (redditSerp.results || []).filter((r) =>
		(r.link || "").includes("reddit.com"),
	);
	const g2Results = (g2Serp.results || []).filter((r) =>
		(r.link || "").includes("g2.com"),
	);

	let g2ProductPage = null;
	const g2ProductUrl =
		g2Results.find((r) => /g2\.com\/products\//i.test(r.link))?.link ||
		g2Results[0]?.link ||
		null;
	if (g2ProductUrl) {
		g2ProductPage = await fetchG2ProductInsights(g2ProductUrl);
	}

	const competitorCandidates = [];
	const seenHosts = new Set([selfHost]);
	for (let i = 0; i < serpLists.length; i++) {
		const label = queries[i];
		for (const row of serpLists[i].results) {
			const h = hostOf(row.link);
			if (!h || seenHosts.has(h)) continue;
			seenHosts.add(h);
			competitorCandidates.push({
				discoveredViaQuery: label,
				source: "duckduckgo",
				title: row.title,
				url: row.link,
				description: row.description,
				host: h,
			});
			if (competitorCandidates.length >= 18) break;
		}
		if (competitorCandidates.length >= 18) break;
	}

	for (const row of redditResults) {
		const h = hostOf(row.link);
		if (!h || seenHosts.has(h)) continue;
		seenHosts.add(h);
		competitorCandidates.push({
			discoveredViaQuery: redditQuery,
			source: "reddit-serp",
			title: row.title,
			url: row.link,
			description: row.description,
			host: h,
		});
	}
	for (const row of g2Results) {
		const h = hostOf(row.link);
		if (!h || seenHosts.has(h)) continue;
		seenHosts.add(h);
		competitorCandidates.push({
			discoveredViaQuery: g2Query,
			source: "g2-serp",
			title: row.title,
			url: row.link,
			description: row.description,
			host: h,
		});
	}

	const allTitles = [
		...competitorCandidates.map((c) => c.title),
		...redditResults.map((r) => r.title),
		...g2Results.map((r) => r.title),
	];
	const contentPatterns = inferContentPatterns(allTitles);
	const topDomains = topDomainsFromResults(
		[
			...competitorCandidates,
			...redditResults.map((r) => ({ link: r.link })),
			...g2Results.map((r) => ({ link: r.link })),
		],
		selfHost,
		15,
	);

	const sampleUrls = [
		...new Set(
			competitorCandidates
				.filter((c) => c.source === "duckduckgo")
				.map((c) => c.url),
		),
	].slice(0, 6);
	const avgMeta = await averageWordCountForUrls(sampleUrls, 6);

	const audit = heuristicSeoScore(onPage);

	let aiBrief = null;
	let auditBriefOpenRouter = null;
	if (useAi) {
		const r = await openRouterBrief(
			`You are an SEO auditor. Given a page summary and competitor signals (DDG + Reddit/G2 SERP; noisy). Give: (1) 5 prioritized fixes for the audited URL. (2) 3 content gaps vs competitors. Plain bullets, under 300 words. Do not invent metrics.`,
			JSON.stringify({
				auditedUrl: url,
				onPage,
				auditScore: audit,
				competitorSample: competitorCandidates.slice(0, 12),
				redditThreads: redditResults.slice(0, 5),
				g2: g2ProductPage,
			}),
			800,
		);
		aiBrief = r?.text || r?.error || null;
		if (r && !r.error && r.usage) auditBriefOpenRouter = r;
	}

	return {
		timestamp: new Date().toISOString(),
		url,
		seedKeyword: seed,
		geo,
		onPage,
		seoHeuristic: audit,
		next: {
			g2CompetitorDeepResearch: {
				method: "POST",
				path: "/seo-g2-competitor-deep-research",
				body: {
					url,
					deepScrape: true,
					useAi: true,
					note: "G2-only competitor URLs, ratings from JSON-LD, optional Puppeteer + LLM problems/strengths.",
				},
			},
		},
		competitors: {
			topDomains,
			contentPatterns,
			avgWordCount: avgMeta.avgWordCount,
			avgWordCountMeta: {
				sampled: avgMeta.sampled,
				wordCounts: avgMeta.wordCounts,
				note: "Averaged from a small sample of DuckDuckGo-discovered competitor URLs; use as a rough benchmark.",
			},
			reddit: {
				query: redditQuery,
				source: redditSerp.source,
				results: redditResults,
			},
			g2: {
				googleSearchQuery: g2Query,
				source: g2Serp.source,
				results: g2Results,
				productPage: g2ProductPage,
			},
			duckduckgo: {
				note: "Generic commercial-intent queries; not exhaustive.",
				queriesUsed: queries,
				urls: competitorCandidates.filter((c) => c.source === "duckduckgo"),
			},
			allUrls: competitorCandidates,
		},
		...(aiBrief && { aiBrief }),
		...(auditBriefOpenRouter && {
			usage: auditBriefOpenRouter.usage,
			tokenUsage: auditBriefOpenRouter.tokenUsage,
			model: auditBriefOpenRouter.model,
			aiPrompt: auditBriefOpenRouter.aiPrompt,
		}),
	};
}

export { assertPublicHttpUrl, extractOnPageSeo };
