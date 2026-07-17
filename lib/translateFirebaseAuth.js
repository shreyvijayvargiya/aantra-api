import { timingSafeEqual } from "node:crypto";
import { firestore } from "../config/firebase.js";
import { requireFirebaseUserFromAuthHeader } from "./requireFirebaseUserFromAuthHeader.js";
import { scheduleMiddlewareTranslateApiLog } from "./translateApiLogger.js";

const USER_COLLECTION = process.env.TRANSLATE_USER_COLLECTION?.trim() || "users";
const CREDIT_FIELD =
	process.env.TRANSLATE_CREDIT_BALANCE_FIELD?.trim() || "translateCreditMinutes";
const MIN_BALANCE = (() => {
	const n = Number.parseFloat(
		process.env.TRANSLATE_MIN_CREDIT_BALANCE || "1",
	);
	return Number.isFinite(n) && n >= 0 ? n : 0.01;
})();

/**
 * Hono c.set key for successful auth (read in handlers if needed).
 * { type: "bypass" | "firebase", uid: string | null }
 */
export const TRANSLATE_AUTH_CONTEXT_KEY = "translateAuth";

function isAuthEnabled() {
	const raw = process.env.TRANSLATE_FIREBASE_AUTH_ENABLED;
	if (raw === undefined || String(raw).trim() === "") return true;
	const s = String(raw).trim().toLowerCase();
	if (s === "0" || s === "false" || s === "no" || s === "off") {
		return false;
	}
	return true;
}

/**
 * @param {import("hono").Context} c
 * @returns {boolean}
 */
export function isOpenRouterTranslateRoute(c) {
	const p = c.req.path;
	const method = c.req.method;
	if (method !== "POST") return false;
	return (
		p === "/api/voice-translate/text" ||
		p === "/api/video-translate/text" ||
		p === "/api/video-translate" ||
		p === "/api/video-translate/long"
	);
}

/**
 * @param {import("hono").Context} c
 */
function parseBearerToken(c) {
	const h = c.req.header("Authorization") || c.req.header("authorization");
	if (!h?.startsWith("Bearer ")) return null;
	const t = h.slice(7).trim();
	return t || null;
}

function tokenEqualsBypass(supplied, expected) {
	if (supplied == null || expected == null) return false;
	const a = Buffer.from(String(supplied), "utf8");
	const b = Buffer.from(String(expected), "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

function authJson(c, payload, status) {
	const code = Number(status) || 0;
	scheduleMiddlewareTranslateApiLog(c, payload, status);
	if (code >= 400) {
		console.error(
			`[translate-auth] ${c.req.method} ${c.req.path} HTTP ${code}`,
			payload?.code || payload?.error || "",
			payload,
		);
	}
	return c.json(payload, status);
}

/**
 * Returns a Response to short-circuit, or null to allow the request to continue.
 * @param {import("hono").Context} c
 * @returns {Promise<import("hono").Response | null>}
 */
export async function runOpenRouterTranslateAuth(c) {
	if (!isAuthEnabled()) return null;
	if (!isOpenRouterTranslateRoute(c)) return null;

	const token = parseBearerToken(c);
	const authHeader = c.req.header("Authorization") || c.req.header("authorization");
	if (!token) {
		return authJson(
			c,
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide Authorization: Bearer <token>",
			},
			401,
		);
	}

	const bypass = process.env.TRANSLATE_BYPASS_BEARER_TOKEN?.trim();
	if (bypass && tokenEqualsBypass(token, bypass)) {
		/** Service / CI key: no Firebase user; skips Firestore credit check. */
		if (typeof c.set === "function") {
			c.set(TRANSLATE_AUTH_CONTEXT_KEY, { type: "bypass", uid: null });
		}
		return null;
	}

	/** @type {string} */
	let uid;
	try {
		const decoded = await requireFirebaseUserFromAuthHeader(authHeader);
		uid = decoded.uid;
	} catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		if (
			errMsg === "Missing Authorization: Bearer" ||
			errMsg === "Empty bearer token"
		) {
			return authJson(
				c,
				{
					error: "Authentication required",
					code: "MISSING_AUTH_TOKEN",
					details: errMsg,
				},
				401,
			);
		}
		return authJson(
			c,
			{
				error: "Invalid or expired ID token",
				code: "INVALID_ID_TOKEN",
				details: errMsg.slice(0, 200),
			},
			401,
		);
	}

	const xUid = (
		c.req.header("X-User-Id") ||
		c.req.header("x-user-id") ||
		""
	).trim();
	if (xUid && xUid !== uid) {
		if (typeof c.set === "function") {
			c.set(TRANSLATE_AUTH_CONTEXT_KEY, { type: "firebase", uid });
		}
		return authJson(
			c,
			{
				error: "X-User-Id does not match authenticated user",
				code: "UID_HEADER_MISMATCH",
			},
			403,
		);
	}

	let snap;
	try {
		snap = await firestore.collection(USER_COLLECTION).doc(uid).get();
	} catch (e) {
		if (typeof c.set === "function") {
			c.set(TRANSLATE_AUTH_CONTEXT_KEY, { type: "firebase", uid });
		}
		return authJson(
			c,
			{
				error: "Failed to read user credits",
				code: "CREDIT_LOOKUP_ERROR",
				details: String(e?.message || e).slice(0, 200),
			},
			503,
		);
	}
	const raw = snap.exists ? snap.data() : null;
	const balance = Number(raw?.[CREDIT_FIELD] ?? 0);
	if (!Number.isFinite(balance) || balance < MIN_BALANCE) {
		if (typeof c.set === "function") {
			c.set(TRANSLATE_AUTH_CONTEXT_KEY, { type: "firebase", uid });
		}
		return authJson(
			c,
			{
				error: "Insufficient translate credit balance",
				code: "INSUFFICIENT_CREDITS",
				details: {
					min_required: MIN_BALANCE,
					credit_field: CREDIT_FIELD,
					collection: USER_COLLECTION,
					balance: Number.isFinite(balance) ? balance : 0,
				},
			},
			403,
		);
	}

	if (typeof c.set === "function") {
		c.set(TRANSLATE_AUTH_CONTEXT_KEY, { type: "firebase", uid });
	}
	return null;
}

/**
 * Hono middleware — register with `app.use("*", openRouterTranslateAuthMiddleware)`.
 * Remove or comment out the `app.use` line to turn off the plugin.
 */
export async function openRouterTranslateAuthMiddleware(c, next) {
	const block = await runOpenRouterTranslateAuth(c);
	if (block) return block;
	await next();
}
