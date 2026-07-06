---
"@paddock/server": minor
"@paddock/web": minor
---

Add voice dictation to the chat composer (#voice). A microphone button next to
Send lets you record a spoken message that is transcribed with Whisper and
dropped into the text area. Works on desktop and mobile.

Two backends, selected per-instance via `PADDOCK_WHISPER_*` env (mirroring
HushPod's whisper config so both can share one server):

- **remote** — POST audio to an OpenAI-compatible `/audio/transcriptions`
  endpoint (`PADDOCK_WHISPER_ENDPOINT`, e.g. a GPU box running
  whisper-server / faster-whisper-server / speaches).
- **local** — run whisper.cpp on the box via the optional `nodejs-whisper`
  dependency (needs `ffmpeg`).

Dictation is **off by default** — a plain instance shows no mic button. When
enabled but the browser can't capture audio (e.g. served over plain HTTP, which
blocks `getUserMedia`), the button is shown disabled with an explanatory tooltip
rather than failing silently.
