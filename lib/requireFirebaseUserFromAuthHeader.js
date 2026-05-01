import { getAuth } from "firebase-admin/auth";
import "../config/firebase.js";

/**
 * Expects `Authorization: Bearer <firebase id token>`.
 * Returns decoded token (includes `uid`, etc.) or throws.
 * @param {string | undefined} authorizationHeader
 * @returns {Promise<import("firebase-admin/auth").DecodedIdToken>}
 */
export async function requireFirebaseUserFromAuthHeader(authorizationHeader) {
	if (!authorizationHeader?.startsWith("Bearer ")) {
		throw new Error("Missing Authorization: Bearer");
	}
	const idToken = authorizationHeader.slice("Bearer ".length).trim();
	if (!idToken) throw new Error("Empty bearer token");
	return getAuth().verifyIdToken(idToken);
}
