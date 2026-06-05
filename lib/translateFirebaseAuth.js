/**
 * OpenRouter translate auth: Firebase ID token verification (firebase-admin) + Firestore credits.
 * Groq routes (`/api/groq/*`) are never touched. Applied only to POST voice/video translate
 * (not GET /languages, caption, or job status).
 *
 * Firebase token verification is always on for protected routes.
 * Credit check: enabled by default. Disable with TRANSLATE_FIREBASE_AUTH_ENABLED=0 (or false / no / off).
 * Service key: set TRANSLATE_BYPASS_BEARER_TOKEN (must be sent as Authorization: Bearer …).
 *
 * @module lib/translateFirebaseAuth
 */
import { timingSafeEqual } from "node:crypto";
import { firestore } from "../config/firebase.js";
import { requireFirebaseUserFromAuthHeader } from "./requireFirebaseUserFromAuthHeader.js";

const USER_COLLECTION = process.env.TRANSLATE_USER_COLLECTION?.trim() || "users";
const CREDIT_BALANCE_FIELD = process.env.TRANSLATE_CREDIT_BALANCE_FIELD?.trim() || "";
const CREDITS_CREDITED_FIELD =
	process.env.TRANSLATE_CREDITS_CREDITED_FIELD?.trim() || "usageMinutesCredited";
const CREDITS_USED_FIELD =
	process.env.TRANSLATE_CREDITS_USED_FIELD?.trim() || "usageMinutesUsed";
const LEGACY_CREDIT_FIELD = "translateCreditMinutes";
const MIN_BALANCE = (() => {
	const n = Number.parseFloat(
		process.env.TRANSLATE_MIN_CREDIT_BALANCE || "0.01",
	);
	return Number.isFinite(n) && n >= 0 ? n : 0.01;
})();

/**
 * Hono c.set key after successful auth.
 * { type: "bypass" | "firebase", uid: string | null, email?: string, balance?: number }
 */
export const TRANSLATE_AUTH_CONTEXT_KEY = "translateAuth";

function isCreditCheckEnabled() {
	const raw = process.env.TRANSLATE_FIREBASE_AUTH_ENABLED;
	if (raw === undefined || String(raw).trim() === "") return true;
	const s = String(raw).trim().toLowerCase();
	if (s === "0" || s === "false" || s === "no" || s === "off") {
		return false;
	}
	return true;
}

function toFiniteNumber(value, fallback = 0) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * Remaining translate minutes (aantraa frontend: credited − used).
 * @param {Record<string, unknown> | null | undefined} doc
 */
export function getTranslateCreditBalance(doc) {
	if (!doc || typeof doc !== "object") return 0;

	if (CREDIT_BALANCE_FIELD && doc[CREDIT_BALANCE_FIELD] != null) {
		return toFiniteNumber(doc[CREDIT_BALANCE_FIELD], 0);
	}

	const credited = toFiniteNumber(doc[CREDITS_CREDITED_FIELD], 0);
	const used = toFiniteNumber(doc[CREDITS_USED_FIELD], 0);
	if (credited > 0 || doc[CREDITS_CREDITED_FIELD] != null) {
		return Math.max(0, credited - used);
	}

	return toFiniteNumber(doc[LEGACY_CREDIT_FIELD], 0);
}

/**
 * @param {import("hono").Context} c
 * @returns {boolean}
 */
export function isOpenRouterTranslateRoute(c) {
	if (c.req.path.startsWith("/api/groq/")) return false;
	const p = c.req.path;
	const method = c.req.method;
	if (method !== "POST") return false;
	return (
		p === "/api/voice-translate/text" ||
		p === "/api/video-translate/text" ||
		p === "/api/video-translate"
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
 * Verify Authorization Bearer token with firebase-admin and optional Firestore credits.
 * Returns a Response to short-circuit, or null to allow the request to continue.
 * @param {import("hono").Context} c
 * @returns {Promise<import("hono").Response | null>}
 */
export async function runOpenRouterTranslateAuth(c) {
	if (!isOpenRouterTranslateRoute(c)) return null;

	const token = parseBearerToken(c);
	const authHeader = c.req.header("Authorization") || c.req.header("authorization");
	if (!token) {
		return authJson(
			c,
			{
				error: "Authentication required",
				code: "MISSING_AUTH_TOKEN",
				details: "Provide Authorization: Bearer <Firebase ID token>",
			},
			401,
		);
	}

	const bypass = process.env.TRANSLATE_BYPASS_BEARER_TOKEN?.trim();
	if (bypass && tokenEqualsBypass(token, bypass)) {
		if (typeof c.set === "function") {
			c.set(TRANSLATE_AUTH_CONTEXT_KEY, { type: "bypass", uid: null });
		}
		return null;
	}

	/** @type {string} */
	let uid;
	/** @type {import("firebase-admin/auth").DecodedIdToken} */
	let decoded;
	try {
		decoded = await requireFirebaseUserFromAuthHeader(authHeader);
		uid = decoded.uid;
		console.log(
			`[translate-auth] verified uid=${uid} email=${decoded.email || "(none)"}`,
		);
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
		return authJson(
			c,
			{
				error: "X-User-Id does not match authenticated user",
				code: "UID_HEADER_MISMATCH",
			},
			403,
		);
	}

	let balance;
	if (isCreditCheckEnabled()) {
		let snap;
		try {
			snap = await firestore.collection(USER_COLLECTION).doc(uid).get();
		} catch (e) {
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
		balance = getTranslateCreditBalance(raw);
		console.log(
			`[translate-auth] uid=${uid} balance=${balance} min=${MIN_BALANCE}`,
		);
		if (balance < MIN_BALANCE) {
			return authJson(
				c,
				{
					error: "Insufficient translate credit balance",
					code: "INSUFFICIENT_CREDITS",
					details: {
						min_required: MIN_BALANCE,
						balance,
						collection: USER_COLLECTION,
						credited_field: CREDITS_CREDITED_FIELD,
						used_field: CREDITS_USED_FIELD,
						...(CREDIT_BALANCE_FIELD
							? { credit_field: CREDIT_BALANCE_FIELD }
							: {}),
					},
				},
				403,
			);
		}
	}

	if (typeof c.set === "function") {
		c.set(TRANSLATE_AUTH_CONTEXT_KEY, {
			type: "firebase",
			uid,
			email: decoded.email ?? null,
			...(balance != null ? { balance } : {}),
		});
	}
	return null;
}

/**
 * Handler helper: ensure Firebase Bearer was verified (middleware or inline).
 * @param {import("hono").Context} c
 * @returns {Promise<import("hono").Response | null>}
 */
export async function enforceTranslateAuthResponse(c) {
	if (c.get?.(TRANSLATE_AUTH_CONTEXT_KEY)) return null;
	return runOpenRouterTranslateAuth(c);
}

/**
 * Hono middleware — register with `app.use("*", openRouterTranslateAuthMiddleware)`.
 */
export async function openRouterTranslateAuthMiddleware(c, next) {
	const block = await runOpenRouterTranslateAuth(c);
	if (block) return block;
	await next();
}
