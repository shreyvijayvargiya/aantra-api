import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import serviceAccount from "./service-account-file.js";
import { getDownloadURL, getStorage } from "firebase-admin/storage";

if (getApps().length === 0) {
	initializeApp({
		credential: cert(serviceAccount),
	projectId: "vaantra-4c87e",
	});
}

const firestore = getFirestore();
const storage = getStorage();
const auth = getAuth();

export { firestore, storage, getDownloadURL, auth };
