/**
 * Optional OpenRouter translate auth: Firebase ID token verification + Firestore credit check.
 * Groq routes (`/api/groq/*`) are never touched.
 *
 * Enable with env: TRANSLATE_FIREBASE_AUTH_ENABLED=1
 * Disable: unset the variable, or set to 0 (middleware no-ops).
 *
 * @module lib/translateFirebaseAuth
 */
import { timingSafeEqual } from "node:crypto";
import { firestore } from "../config/firebase.js";
import { requireFirebaseUserFromAuthHeader } from "./requireFirebaseUserFromAuthHeader.js";

const USER_COLLECTION = process.env.TRANSLATE_USER_COLLECTION?.trim() || "users";
const CREDIT_FIELD =
	process.env.TRANSLATE_CREDIT_BALANCE_FIELD?.trim() || "translateCreditMinutes";
const MIN_BALANCE = (() => {
	const n = Number.parseFloat(
		process.env.TRANSLATE_MIN_CREDIT_BALANCE || "0.01",
	);
	return Number.isFinite(n) && n >= 0 ? n : 0.01;
})();

/**
 * Hono c.set key for successful auth (read in handlers if needed).
 * { type: "bypass" | "firebase", uid: string | null }
 */
export const TRANSLATE_AUTH_CONTEXT_KEY = "translateAuth";

function isAuthEnabled() {
	const v = process.env.TRANSLATE_FIREBASE_AUTH_ENABLED;
	return v === "1" || v === "true" || v === "yes";
}

/**
 * @param {import("hono").Context} c
 * @returns {boolean}
 */
export function isOpenRouterTranslateRoute(c) {
	if (c.req.path.startsWith("/api/groq/")) return false;
	const p = c.req.path;
	const method = c.req.method;
	if (p === "/api/voice-translate/text" && method === "POST") return true;
	if (p === "/api/video-translate/text" && method === "POST") return true;
	if (p.startsWith("/api/video-translate")) return true;
	return false;
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
		return c.json(
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
			return c.json(
				{
					error: "Authentication required",
					code: "MISSING_AUTH_TOKEN",
					details: errMsg,
				},
				401,
			);
		}
		return c.json(
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
		return c.json(
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
		return c.json(
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
		return c.json(
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
