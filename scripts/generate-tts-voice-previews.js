#!/usr/bin/env node
/**
 * Pre-generate TTS voice preview WAVs and write resources/tts-voices.json.
 * Use before deploy so GET /api/translate/tts-voices returns audio_url immediately.
 *
 *   npm run tts-voices:seed
 */
import dotenv from "dotenv";

dotenv.config();

const { seedTtsVoicePreviewsFromCli } = await import(
	"../lib/openRouterTtsVoicePreviews.js"
);

await seedTtsVoicePreviewsFromCli();
