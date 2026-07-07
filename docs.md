# API Documentation (Aantraa API)

Base server: this repo runs a Hono server (`index.js`) on port `3000` by default.

All endpoints return JSON unless noted (SSE stream).

## Authentication

- **Required** (non-empty `Authorization` header) for:
  - `POST /api/video-translate`
  - `POST /api/voice-translate/text`
  - `POST /api/video-translate/text` (alias)
  - `POST /api/video-caption`
  - `POST /api/viral-clip-cut`
- **Not required** for:
  - `GET /`
  - `GET /api/video-translate/languages`
  - `GET /api/video-translate/tts-voices`
  - `GET /api/translate/tts-voices`
  - `GET /api/audio-to-text/languages`
  - `GET /api/audio-to-text/voices`
  - `POST /api/audio-to-text`
  - `GET /api/video-translate/caption`
  - `GET /api/video-translate/:id`
  - `GET /api/video-caption/:id`
  - `GET /api/viral-clip-cut/:id`

**Authorization header format**

- **Preferred**: `Authorization: Bearer <token>`
- Also accepted by these endpoints: `Authorization: <token>` (raw string)

## Content types

Many POST endpoints support either:

- **JSON**: `Content-Type: application/json`
- **Multipart upload**: `Content-Type: multipart/form-data`
  - Use this to upload files (`file`, `video`, or `audio` depending on the endpoint).

## Rate limits (per IP)

These are enforced in `index.js`:

- `POST /api/audio-to-text`: **30 / 10 min**
- `POST /api/voice-translate/text` and `POST /api/video-translate/text`: **20 / 10 min**
- `POST /api/video-translate`: **10 / 10 min**
- `POST /api/video-caption`: **10 / 10 min**
- `POST /api/viral-clip-cut`: **10 / 10 min**

When rate-limited:

- HTTP `429`
- Response includes `retryAfter` (seconds)
- Headers include `Retry-After`, `X-RateLimit-*`

---

## GET /

Health check.

**Response**

- `message`: string
- `api_version`: string (`VERCEL_GIT_COMMIT_SHA` short SHA, or `"local"`)
- `free_tts`: boolean

---

## GET /api/video-translate/languages

Returns supported target languages list for video translation.

**Query params**: none

**Response**

- `data.languages` (or similar list; see implementation in `lib/videoTranslateOpenRouter.js`)

---

## GET /api/translate/tts-voices
## GET /api/video-translate/tts-voices

Returns OpenRouter TTS voice catalog + preview WAV URLs (generated/cached via `resources/tts-voices.json`).

**Query params**: none

**Response**

- `error`: `null` or string
- `data`:
  - `voices`: array
  - `default_voice_id`, `default_tts_voice` (when available)
  - `previews_complete`: boolean (used for cache headers)

---

## GET /api/audio-to-text/languages

Same language list as video translate.

---

## GET /api/audio-to-text/voices

Free-tier voice catalog (Kokoro) + free TTS model presets.

**Response `data`**

- `tier`: `"free"`
- `tts_engine`: `"piper"` or `"openrouter"`
- `model`: string (default model label)
- `default_voice_id`: string
- `default_tts_voice`: string
- `preview_text`: string
- `voices`: array
- `voices_by_gender`: object
- `tts_models`: list of supported model presets
- `default_tts_model`: preset name
- `default_tts_engine`: engine name
- `cost_note`: string

---

## POST /api/audio-to-text

Free tier: **text → (optional translate) → TTS → UploadThing audio URL**.

No Authorization required.

### Request (JSON)

**Required**

- `text` (string) — or `source_text` (alias)

**Optional**

- `language` (string) — target language label
  - Alias: `output_language`
- **Translation inputs (only used when `language`/`output_language` is set)**
  - `source_language` (string) — ISO hint (e.g. `"en"`)
  - `source_nllb` (string) — FLORES / NLLB code (e.g. `"eng_Latn"`)
  - `transcript_language` (string) — ISO hint
  - `translate_model` (string) — translation model preset (implementation in `lib/freeTextTranslate.js`)
- **Voice selection**
  - `tts_voice` (string) — friendly voice label
  - `voice_id` (string)
  - `brand_voice_id` (string)
- **TTS engine/model**
  - `tts_engine` (string): `"openrouter" | "piper" | "auto"`
  - `tts_model` (string) — preset name; alias: `model`
  - `piper_model` (string) — path or identifier (only if using Piper)

### Request (multipart/form-data)

Same fields as JSON, as text fields. (No file upload on this endpoint—this endpoint is for text input.)

### Response (success)

- `error: null`
- `data` includes (typical):
  - `audio_url` (string) — uploaded WAV URL
  - `language` (string)
  - `translated` (boolean)
  - `translation_engine`, `translation_model` (when translation happened)
  - `tts_engine`, `tts_model`, voice info (when available)

### Response (error)

- `error` string
- `code` string (e.g. `TEXT_TOO_LONG`, `UNSUPPORTED_LANGUAGE`, etc.)
- May include `details`

---

## GET /api/video-translate/caption

Fetch caption result for a `video_translate_id`, or stream until captions are ready.

### Query params

**Required**

- `video_translate_id` (string)

**Optional**

- `stream` (boolean-ish): `1|true` to enable SSE streaming
  - Also enabled if `Accept: text/event-stream`

### Response (non-stream)

- If ready:
  - `error: null`
  - `data.caption_url` (string)
  - `data.caption` (string)
  - plus usage fields
- If not ready:
  - HTTP `404`
  - `code: "NOT_READY"`
  - `data.status` (job status)

### SSE stream mode

When streaming (`stream=1` or `Accept: text/event-stream`), events include:

- `progress`: `{"status": "<pending|running|...>" }`
- `caption`: `{"error": null, "data": { ...same as non-stream... }}`
- `error`: `{"error":"...", "code":"..." }`
- `done`: `{"ok": true|false }`

The server enforces a maximum wait (`VIDEO_TRANSLATE_CAPTION_SSE_MAX_MS`).

---

## POST /api/voice-translate/text
## POST /api/video-translate/text (alias)

Translate either **text** or **audio** into multiple target languages, optionally generating TTS audio per language.

### Authorization

**Required**: non-empty `Authorization` header.

### Request (JSON)

**Required**

- `languages` (array of strings) — alias: `output_languages`
  - Example: `["Hindi", "Spanish"]`
- Plus **one of**:
  - `text` (string) — alias: `source_text`
  - OR `audio_url` / `audioUrl` / `url` / `link` / `media_url` / `mediaUrl` / `video_url` / `videoUrl`

**Optional**

- `include_audio` (boolean-ish; default `true`) — set `false` to skip TTS
- **Model selection**
  - `model` (string) — preset key, e.g. `gemini`, `gpt-4o-mini`, `sonnet`, `kimi`, `grok`
  - `llm_model` (string) — alias for `model`
- **Pipeline controls**
  - `translation_engine` (string): `llm` (default) or `nllb`
  - `tts_engine` (string): `openrouter` (default) or `piper`
  - `glossary_refinement` (boolean-ish) — only relevant when using `nllb`
  - `glossary_refine_model` (string) — OpenRouter model id for glossary pass
- **Language hints for NLLB**
  - `source_nllb` (string) — FLORES code like `eng_Latn`
  - `transcript_language` (string) — ISO hint
  - `source_language` (string) — ISO hint
- **Piper**
  - `piper_model` (string) — required if `tts_engine=piper` and Piper not configured in env
- **OpenRouter TTS voice selection** (only if `tts_engine != piper`)
  - `tts_voice` (string)
  - `voice_id` (string)
  - `brand_voice_id` (string)

### Request (multipart/form-data)

**Required**

- `languages` or `output_languages`
- Plus one of:
  - `text` / `source_text`
  - OR a file upload: `audio` or `file`
  - OR a URL field listed above

**Optional**

- Same option fields as JSON (as text fields)

### Response (success)

- `error: null`
- `data`:
  - `source_type`: `"text"` or `"audio"`
  - `source_text`: string (final source transcript used)
  - `audio_input_url` (string, only when input audio URL provided)
  - `transcribe_model` (string, only when input audio used)
  - `model` (OpenRouter model id used for translation)
  - `results`: array of objects, one per language:
    - `language` (string)
    - `transcript` (string)
    - If `include_audio=true`:
      - Either `audio_url`/`audioUrl` (when UploadThing is configured) OR `audio_base64`
      - `audio_format`: `"pcm16"` or `"wav"`
  - `pipeline`:
    - `translation`: `"llm"` or `"nllb"`
    - `tts`: `"openrouter"` or `"piper"`
    - Optional: `tts_voice`, `tts_voice_id`
    - `glossary_refinement`: boolean
    - `bulk_mt_model`: string|null
- Usage fields are also included at top-level (see `lib/openRouterUsage.js`)

---

## POST /api/video-translate

Creates one or more async jobs to translate/dub a video into one or more languages.

### Authorization

**Required**: non-empty `Authorization` header.

### Request (JSON)

**Required**

- One of these fields for the input video URL:
  - `video_url`, `videoUrl`, `url`, `video`, `source_url`, `sourceUrl`, `link`
- One of:
  - `output_language` (string)
  - `output_languages` (array of strings)

**Optional**

- `title` (string)
- `callback_id` (string)
- **Plan / caps selection** (used to determine max video bytes/minutes):
  - `plan` (string) — e.g. `free|pro|enterprise`
  - `user_plan` (string)
  - `subscription_plan` (string)
  - `tier` (string)
- **Model selection** (preset key):
  - `model` (string) — e.g. `gemini` (default), `gpt-4o-mini`, `sonnet`, `kimi`, `grok`
  - `llm_model` (string) — alias
- **Pipeline controls**
  - `translation_engine` (string): `llm` (default) or `nllb`
  - `tts_engine` (string): `openrouter` (default) or `piper`
  - `glossary_refinement` (boolean-ish)
  - `glossary_refine_model` (string) — OpenRouter model id for glossary pass
- **Language hints for NLLB**
  - `source_nllb` (string) — FLORES code like `eng_Latn`
  - `transcript_language` (string) — ISO hint
  - `source_language` (string) — ISO hint
- **Piper**
  - `piper_model` (string) — required if `tts_engine=piper` and Piper not configured in env
- **OpenRouter TTS voice selection** (only if `tts_engine != piper`)
  - `tts_voice` (string)
  - `voice_id` (string)
  - `brand_voice_id` (string)
- **Compatibility flags (accepted, but may be legacy)**
  - `translate_audio_only` (boolean; default `false`)
  - `keep_the_same_format` (boolean; default `false`)
  - `mode` (string; default `"fast"`)
  - `speaker_num` (number)
  - `enable_dynamic_duration` (string)
  - `callback_url` (string)

### Request (multipart/form-data)

**Required**

- Either:
  - file upload: `file` or `video`
  - OR a string URL in one of: `video_url`, `videoUrl`, `url`, `source_url`, `sourceUrl`, `link`, or `video` (string)
- One of:
  - `output_language`
  - `output_languages` (must be a JSON array string, e.g. `["Spanish","French"]`)

**Optional**

All optional JSON fields above can be sent as form text fields.

### Response (success)

- `error: null`
- `data`:
  - If a single language:
    - `video_translate_id` (string)
    - `video_translate_ids`: `null`
  - If multiple languages:
    - `video_translate_id`: `null`
    - `video_translate_ids` (string[])
  - `pipeline`:
    - `translation`: `"llm"` or `"nllb"`
    - `tts`: `"openrouter"` or `"piper"`
    - `glossary_refinement`: boolean
    - optional: `tts_voice`, `tts_voice_id`

---

## GET /api/video-translate/:id

Fetch a video-translate job status.

**Path params**

- `id` (string) — `video_translate_id`

**Response**

- `error: null`
- `data` (HeyGen-like shape):
  - `video_translate_id` (string)
  - `title` (string|null)
  - `output_language` (string|null)
  - `status` (`pending|running|success|failed`)
  - `url` (string|null) — best available video URL (final or source)
  - `caption_url` (string|null)
  - `caption` (string|null)
  - `message` (string|null) — error/status message
  - `callback_id` (string|null)
  - `transcript_original` (string|null)
  - `translated_transcript` (string|null)
  - `source_video_url` (string|null)
  - `engine` (string)
  - `pipeline` (object): translation/tts/voice/glossary/bulk model
  - Usage fields (see `lib/openRouterUsage.js`)

---

## POST /api/video-caption

Creates an async job to generate timed captions + (optionally) burn captions into the video.

### Authorization

**Required**: non-empty `Authorization` header.

### Request (JSON)

**Required**

- `video_url` or `videoUrl` (string)
- Caption language (at least one; resolved server-side):
  - `language` (string) OR `output_language` (string) OR `caption_language` (string)

**Optional**

- `caption_style` (string) — e.g. `top|bottom` (server normalizes)
  - aliases accepted: `caption_position`, `style`
- `caption_mode` (string) — e.g. transcribe vs translate-to-target (server normalizes)
- `burn_captions` (boolean-ish; default `true`)
  - alias: `burnCaptions`
- Model preset:
  - `model` (string) — preset key
  - `llm_model` (string) — alias

### Request (multipart/form-data)

**Required**

- Either file upload (`file` or `video`) OR `video_url`/`videoUrl`
- Language field: `language` or `output_language` or `caption_language`

**Optional**

Same as JSON fields as form text fields.

### Response (success)

- `error: null`
- `data.video_caption_id` (string)

---

## GET /api/video-caption/:id

Fetch a video-caption job status.

**Path params**

- `id` (string) — `video_caption_id`

**Response `data`**

- `video_caption_id` (string)
- `status` (string)
- `source_video_url` (string|null)
- `language` / `caption_language` (string|null)
- `caption_mode` (string)
- `caption_style` (string)
- `transcript` / `caption` (string|null)
- `summary` (string|null)
- `titles` (string[]|null)
- `thumbnail_texts` (string[]|null)
- `hooks` (string[]|null)
- `caption_url` (string|null) — VTT
- `srt_url` (string|null)
- `captioned_video_url` (string|null)
- `captions` (array|null) — timed segments
- `burn_captions` (boolean)
- Error fields (when failed): `error`, `error_code`, `user_message`, `error_detail?`, `error_upstream_status?`, `error_retryable?`
- Usage fields

---

## POST /api/viral-clip-cut

Creates an async job to find viral moments and cut clips from a video.

### Authorization

**Required**: non-empty `Authorization` header.

### Request (JSON)

**Required**

- `video_url` or `videoUrl` (string)

**Optional**

- `prompt` (string) — alias: `context`
- `language` (string) — default `"en"`
- Clip selection controls:
  - `clip_count` (number) — alias: `clipCount`
  - `max_clips` (number) — alias: `maxClips`
  - `min_clip_sec` (number) — alias: `minClipSec`
  - `max_clip_sec` (number) — alias: `maxClipSec`
  - `seconds_per_clip` (number) — alias: `secondsPerClip`
- Output format:
  - `target_aspect` (string) — alias: `targetAspect` (e.g. `9:16`)
- Model preset:
  - `model` (string)
  - `llm_model` (string)

### Request (multipart/form-data)

**Required**

- Either file upload (`file` or `video`) OR `video_url`/`videoUrl`

**Optional**

Same as JSON fields.

### Response (success)

- `error: null`
- `data.viral_clip_cut_id` (string)

---

## GET /api/viral-clip-cut/:id

Fetch a viral-clip-cut job status.

**Path params**

- `id` (string) — `viral_clip_cut_id`

**Response `data`**

- `viral_clip_cut_id` (string)
- `status` (string) — e.g. `pending|analyzing|cutting|uploading|success|failed`
- `source_video_url` (string|null)
- `prompt` (string|null)
- `language` (string|null)
- `summary` (string|null)
- `transcript` (string|null)
- `clip_count_requested` (number|null)
- `clip_count` (number|null)
- `clips` (array|null) — each clip typically includes:
  - `index` (number)
  - `title` (string)
  - `hook` (string)
  - `start_ms`, `end_ms`, `duration_ms` (numbers)
  - `virality_score` (number)
  - `reason` (string)
  - `video_url` / `videoUrl` (string)
- Clip config echo:
  - `target_aspect`, `min_clip_sec`, `max_clip_sec`, `max_clips`
- Error fields (when failed): `error`, `error_code`, `user_message`, `error_detail?`, `error_upstream_status?`, `error_retryable?`
- Usage fields

