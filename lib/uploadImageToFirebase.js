import { storage } from "../firebase.js";

export const uploadImageToFirebaseStorage = async (
	uniqueFileName,
	websiteScreenshot,
	url,
	title
) => {
	// Upload to Firebase storage
	const bucket = storage.bucket(process.env.FIREBASE_BUCKET);
	const file = bucket.file(`ihr-website-screenshot/${uniqueFileName}`);

	try {
		await file.save(websiteScreenshot, {
			metadata: {
				contentType: "image/png",
				cacheControl: "public, max-age=3600",
			},
		});

		// Make the file publicly accessible
		await file.makePublic();

		// Get the public URL
		const screenshotUrl = `https://storage.googleapis.com/${process.env.FIREBASE_BUCKET}/${file.name}`;

		return {
			success: true,
			url: url,
			title: title,
			screenshot: screenshotUrl,
			storagePath: `ihr-website-screenshot/${uniqueFileName}`,
			timestamp: new Date().toISOString(),
		};
	} catch (firebaseError) {
		console.error("❌ Error uploading to Firebase storage:", firebaseError);

		return {
			success: false,
			error: "Failed to upload screenshot to Firebase storage",
			details: firebaseError.message,
		};
	}
};
