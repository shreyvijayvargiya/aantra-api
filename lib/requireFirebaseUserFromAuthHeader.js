import { auth } from "../config/firebase.js";

/**
 * Expects `Authorization: Bearer <Firebase ID token>`.
 * Verifies the token with firebase-admin `verifyIdToken`.
 * @param {string | undefined} authorizationHeader
 * @returns {Promise<import("firebase-admin/auth").DecodedIdToken>}
 */
export async function requireFirebaseUserFromAuthHeader(authorizationHeader) {
	if (!authorizationHeader?.startsWith("Bearer ")) {
		throw new Error("Missing Authorization: Bearer");
	}
	const idToken = authorizationHeader.slice("Bearer ".length).trim();
	if (!idToken) throw new Error("Empty bearer token");

	try {
		return await auth.verifyIdToken(idToken);
	} catch (e) {
		const code = e?.code || e?.errorInfo?.code || "";
		const msg = e instanceof Error ? e.message : String(e);
		if (code === "auth/id-token-expired") {
			throw new Error("Firebase ID token expired");
		}
		if (code === "auth/argument-error") {
			throw new Error("Malformed Firebase ID token");
		}
		if (code === "auth/id-token-revoked") {
			throw new Error("Firebase ID token revoked");
		}
		throw new Error(msg || "Firebase ID token verification failed");
	}
}
