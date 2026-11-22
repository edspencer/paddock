---
"@paddock/server": minor
"@paddock/web": minor
---

Voice dictation has a `browser` mode (`PADDOCK_WHISPER_MODE=browser`, or `transcription.mode: browser` in the instance settings). The composer then uses the browser's own speech recognition, and no audio is sent to the server. `GET /api/transcription` reports a `null` model in this mode, and `POST /api/transcribe` answers `409`.
