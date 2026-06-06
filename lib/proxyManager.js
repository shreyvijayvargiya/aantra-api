/**
 * Rotating proxy pool for yt-dlp / video downloads (e.g. Bright Data residential IPs).
 *
 * Configure via one of:
 *   VIDEO_TRANSLATE_PROXIES_JSON — JSON array of { host, port, username, password }
 *   BRIGHTDATA_PROXY_HOST, BRIGHTDATA_PROXY_PORT, BRIGHTDATA_PROXY_PASSWORD, and one of:
 *     BRIGHTDATA_PROXY_USERNAME — single full Bright Data username (zone or ip session)
 *     BRIGHTDATA_PROXY_USER — alias for BRIGHTDATA_PROXY_USERNAME
 *     BRIGHTDATA_PROXY_USERNAMES — comma-separated full Bright Data usernames, or
 *     BRIGHTDATA_PROXY_CUSTOMER + BRIGHTDATA_PROXY_ZONE (+ optional BRIGHTDATA_PROXY_IPS)
 *       without IPS: brd-customer-{customer}-zone-{zone} (rotating zone)
 *       with IPS: brd-customer-{customer}-zone-{zone}-ip-{ip} per IP
 *
 * Optional:
 *   VIDEO_TRANSLATE_PROXY_MAX_ROTATIONS — max distinct proxies to try per download (default: all)
 *   VIDEO_TRANSLATE_PROXY_HEALTH_CHECK=1 — puppeteer httpbin check every 5m (off by default on Fly)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Trim Fly/.env secrets; strip accidental wrapping quotes. */
export function cleanProxyEnvSecret(value) {
	if (value == null) return "";
	let s = String(value).trim();
	if (
		(s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'"))
	) {
		s = s.slice(1, -1).trim();
	}
	return s;
}

function normalizeProxyEntry(raw) {
	if (!raw || typeof raw !== "object") return null;
	const host = cleanProxyEnvSecret(raw.host);
	const port = Number(raw.port);
	const username = cleanProxyEnvSecret(raw.username);
	const password = cleanProxyEnvSecret(raw.password);
	if (!host || !Number.isFinite(port) || !username || !password) return null;
	return {
		host,
		port,
		username,
		password,
		lastUsed: 0,
		failCount: 0,
		isHealthy: true,
	};
}

export function loadVideoTranslateProxiesFromEnv() {
	const json = cleanProxyEnvSecret(process.env.VIDEO_TRANSLATE_PROXIES_JSON);
	if (json) {
		try {
			const parsed = JSON.parse(json);
			if (Array.isArray(parsed)) {
				return parsed.map(normalizeProxyEntry).filter(Boolean);
			}
		} catch (e) {
			console.error("[proxy] invalid VIDEO_TRANSLATE_PROXIES_JSON:", e?.message);
		}
	}

	const host =
		cleanProxyEnvSecret(process.env.BRIGHTDATA_PROXY_HOST) || "brd.superproxy.io";
	const port = Number(process.env.BRIGHTDATA_PROXY_PORT || 33335);
	const password = cleanProxyEnvSecret(process.env.BRIGHTDATA_PROXY_PASSWORD);
	const singleUsername = cleanProxyEnvSecret(
		process.env.BRIGHTDATA_PROXY_USERNAME || process.env.BRIGHTDATA_PROXY_USER,
	);
	const usersRaw = cleanProxyEnvSecret(process.env.BRIGHTDATA_PROXY_USERNAMES);

	if (password && singleUsername) {
		const one = normalizeProxyEntry({
			host,
			port,
			username: singleUsername,
			password,
		});
		return one ? [one] : [];
	}

	if (password && usersRaw) {
		return usersRaw
			.split(",")
			.map((u) => cleanProxyEnvSecret(u))
			.filter(Boolean)
			.map((username) =>
				normalizeProxyEntry({ host, port, username, password }),
			)
			.filter(Boolean);
	}

	const customer = cleanProxyEnvSecret(process.env.BRIGHTDATA_PROXY_CUSTOMER);
	const zone = cleanProxyEnvSecret(process.env.BRIGHTDATA_PROXY_ZONE);
	const ipsRaw = cleanProxyEnvSecret(process.env.BRIGHTDATA_PROXY_IPS);

	if (password && customer && zone && ipsRaw) {
		return ipsRaw
			.split(",")
			.map((ip) => cleanProxyEnvSecret(ip))
			.filter(Boolean)
			.map((ip) =>
				normalizeProxyEntry({
					host,
					port,
					username: `brd-customer-${customer}-zone-${zone}-ip-${ip}`,
					password,
				}),
			)
			.filter(Boolean);
	}

	if (password && customer && zone) {
		const one = normalizeProxyEntry({
			host,
			port,
			username: `brd-customer-${customer}-zone-${zone}`,
			password,
		});
		return one ? [one] : [];
	}

	return [];
}

export function getVideoTranslateProxyMaxRotations(proxyCount) {
	if (!proxyCount) return 0;
	const raw = Number.parseInt(
		process.env.VIDEO_TRANSLATE_PROXY_MAX_ROTATIONS || "",
		10,
	);
	if (Number.isFinite(raw) && raw > 0) {
		return Math.min(raw, proxyCount);
	}
	return proxyCount;
}

export function proxyPoolKey(proxy) {
	return `${proxy.username}@${proxy.host}:${proxy.port}`;
}

/** @param {{ host: string, port: number, username: string, password: string }} proxy */
export function buildYtDlpProxyUrl(proxy) {
	const user = encodeURIComponent(proxy.username);
	const pass = encodeURIComponent(proxy.password);
	return `http://${user}:${pass}@${proxy.host}:${proxy.port}`;
}

/** Proxy URL without credentials (use with Proxy-Authorization header). */
export function buildYtDlpProxyHostUrl(proxy) {
	return `http://${proxy.host}:${proxy.port}`;
}

export function buildProxyAuthorizationHeader(proxy) {
	const token = Buffer.from(`${proxy.username}:${proxy.password}`, "utf8").toString(
		"base64",
	);
	return `Basic ${token}`;
}

/**
 * yt-dlp proxy options: embedded URL (default) or host + Proxy-Authorization header.
 * @param {{ host: string, port: number, username: string, password: string }} proxy
 * @param {"url" | "header"} mode
 */
export function buildYtDlpProxyExecOptions(proxy, mode = "url") {
	if (mode === "header") {
		return {
			proxy: buildYtDlpProxyHostUrl(proxy),
			addHeader: [
				`Proxy-Authorization: ${buildProxyAuthorizationHeader(proxy)}`,
			],
		};
	}
	return { proxy: buildYtDlpProxyUrl(proxy) };
}

export function isProxyAuthError(stderr) {
	return /407|auth failed|proxy authentication required|tunnel connection failed/i.test(
		String(stderr || ""),
	);
}

/**
 * Quick curl check — logs actionable errors for Fly secrets (407 = bad password/username).
 * @param {ReturnType<typeof normalizeProxyEntry>} proxy
 */
export async function probeProxyAuth(proxy) {
	const proxyUrl = buildYtDlpProxyUrl(proxy);
	const key = proxyPoolKey(proxy);
	try {
		const { stdout } = await execFileAsync(
			"curl",
			[
				"-sS",
				"-m",
				"20",
				"-x",
				proxyUrl,
				"-o",
				"/dev/null",
				"-w",
				"%{http_code}",
				"https://httpbin.org/ip",
			],
			{ timeout: 25_000 },
		);
		const code = String(stdout || "").trim();
		if (code === "200") {
			console.log(`[proxy] probe OK ${key} (http ${code})`);
			return { ok: true, httpCode: code };
		}
		console.error(
			`[proxy] probe failed ${key} — http ${code}. Check BRIGHTDATA_PROXY_PASSWORD and username (zone password, not account password).`,
		);
		return { ok: false, httpCode: code };
	} catch (e) {
		const msg = String(e?.stderr || e?.message || e);
		const auth = isProxyAuthError(msg);
		console.error(
			`[proxy] probe failed ${key}${auth ? " (407 auth — fix Fly secrets)" : ""}: ${msg.slice(0, 400)}`,
		);
		return { ok: false, authError: auth, error: msg };
	}
}

/** Run one probe on startup when pool is configured (non-blocking). */
export async function validateVideoTranslateProxyPoolAtStartup(manager) {
	if (!manager?.hasProxies?.()) return;
	const proxy = manager.getNextProxy();
	if (!proxy) return;
	const result = await probeProxyAuth(proxy);
	if (result.authError) {
		console.error(
			"[proxy] YouTube downloads will fail until Bright Data credentials are fixed. " +
				"Set BRIGHTDATA_PROXY_USERNAME (or CUSTOMER+ZONE) and BRIGHTDATA_PROXY_PASSWORD on Fly. " +
				"Use the zone password from Bright Data dashboard → Proxies → your zone → Access parameters.",
		);
	}
}

export class ProxyManager {
	/** @param {ReturnType<typeof normalizeProxyEntry>[]} proxies */
	constructor(proxies = []) {
		this.proxies = proxies;
		this.healthCheckInterval = null;
		if (
			this.proxies.length > 0 &&
			process.env.VIDEO_TRANSLATE_PROXY_HEALTH_CHECK === "1"
		) {
			this.startHealthCheck();
		} else if (this.proxies.length > 0) {
			console.log(
				`[proxy] loaded ${this.proxies.length} proxies (health check disabled)`,
			);
		} else {
			console.warn(
				"[proxy] no proxies configured — set BRIGHTDATA_PROXY_* or VIDEO_TRANSLATE_PROXIES_JSON for YouTube on cloud hosts",
			);
		}
	}

	hasProxies() {
		return this.proxies.length > 0;
	}

	get count() {
		return this.proxies.length;
	}

	getHealthyCount() {
		return this.proxies.filter((p) => p.isHealthy).length;
	}

	getNextProxy() {
		const now = Date.now();
		const cooldownPeriod = 5000;

		const availableProxies = this.proxies.filter(
			(proxy) => proxy.isHealthy && now - proxy.lastUsed > cooldownPeriod,
		);

		if (availableProxies.length === 0) {
			this.proxies.forEach((proxy) => {
				proxy.lastUsed = 0;
				proxy.failCount = 0;
				proxy.isHealthy = true;
			});
			return this.proxies[0] ?? null;
		}

		const sortedProxies = availableProxies.sort((a, b) => {
			if (a.failCount !== b.failCount) return a.failCount - b.failCount;
			const aLatency =
				typeof a.avgLatency === "number" ? a.avgLatency : Infinity;
			const bLatency =
				typeof b.avgLatency === "number" ? b.avgLatency : Infinity;
			if (aLatency !== bLatency) return aLatency - bLatency;
			return a.lastUsed - b.lastUsed;
		});

		const selectedProxy = sortedProxies[0];
		selectedProxy.lastUsed = now;
		return selectedProxy;
	}

	/** @param {{ username: string }} proxy */
	_findProxy(proxy) {
		return this.proxies.find((p) => p.username === proxy.username) ?? null;
	}

	markProxyFailed(proxy) {
		const entry = this._findProxy(proxy);
		if (!entry) return;
		entry.failCount++;
		entry.lastFailureAt = Date.now();
		if (entry.failCount >= 3) {
			entry.isHealthy = false;
			console.warn(
				`[proxy] ${proxyPoolKey(entry)} unhealthy after ${entry.failCount} failures`,
			);
		}
	}

	markProxySuccess(proxy) {
		const entry = this._findProxy(proxy);
		if (!entry) return;
		entry.failCount = Math.max(0, entry.failCount - 1);
		if (entry.failCount === 0) entry.isHealthy = true;
	}

	markProxyLatency(proxy, latencyMs) {
		const entry = this._findProxy(proxy);
		if (!entry || typeof latencyMs !== "number") return;
		if (typeof entry.avgLatency !== "number") {
			entry.avgLatency = latencyMs;
			entry.totalRequests = 1;
			return;
		}
		const alpha = 0.3;
		entry.avgLatency = alpha * latencyMs + (1 - alpha) * entry.avgLatency;
		entry.totalRequests = (entry.totalRequests || 0) + 1;
	}

	recordProxyResult(proxy, success, latencyMs) {
		if (!proxy) return;
		if (typeof latencyMs === "number") {
			this.markProxyLatency(proxy, latencyMs);
		}
		if (success) {
			this.markProxySuccess(proxy);
		} else {
			this.markProxyFailed(proxy);
		}
	}

	async checkProxyHealth(proxy) {
		let browser;
		try {
			const puppeteer = (await import("puppeteer-core")).default;
			const proxyArg = `--proxy-server=http://${proxy.host}:${proxy.port}`;
			const launchArgs = [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--disable-gpu",
				proxyArg,
			];

			const executablePath =
				process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
				(process.env.NODE_ENV === "production"
					? "/usr/bin/chromium"
					: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

			browser = await puppeteer.launch({
				headless: true,
				executablePath,
				args: launchArgs,
			});

			const page = await browser.newPage();
			await page.setUserAgent(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			);
			if (proxy.username && proxy.password) {
				await page.authenticate({
					username: proxy.username,
					password: proxy.password,
				});
			}
			await page.goto("https://httpbin.org/ip", { timeout: 15000 });
			const content = await page.$eval("body", (el) => el.textContent);
			await page.close();
			await browser.close();

			if (content.includes("origin")) {
				this.markProxySuccess(proxy);
				return true;
			}
			this.markProxyFailed(proxy);
			return false;
		} catch {
			if (browser) await browser.close().catch(() => {});
			this.markProxyFailed(proxy);
			return false;
		}
	}

	startHealthCheck() {
		this.healthCheckInterval = setInterval(
			async () => {
				console.log("[proxy] running health check...");
				await Promise.allSettled(
					this.proxies.map((proxy) => this.checkProxyHealth(proxy)),
				);
				const healthyCount = this.getHealthyCount();
				console.log(
					`[proxy] health check: ${healthyCount}/${this.proxies.length} healthy`,
				);
			},
			5 * 60 * 1000,
		);
	}

	stopHealthCheck() {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
	}

	getStats() {
		const total = this.proxies.length;
		const healthy = this.getHealthyCount();
		return {
			total,
			healthy,
			failed: this.proxies.filter((p) => p.failCount > 0).length,
			healthPercentage: total ? Math.round((healthy / total) * 100) : 0,
			proxies: this.proxies.map((p) => ({
				id: proxyPoolKey(p),
				host: p.host,
				port: p.port,
				isHealthy: p.isHealthy,
				failCount: p.failCount,
				lastUsed: p.lastUsed,
			})),
		};
	}
}

/** @type {ProxyManager | null} */
let singleton = null;

export function getVideoTranslateProxyManager() {
	if (!singleton) {
		const proxies = loadVideoTranslateProxiesFromEnv();
		singleton = new ProxyManager(proxies);
	}
	return singleton;
}
