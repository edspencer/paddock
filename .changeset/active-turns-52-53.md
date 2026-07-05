---
"@paddock/server": minor
"@paddock/web": minor
---

Surface which chats are streaming, and restore the Stop button when you return to
a live chat (#52, #53).

The server now exposes a session's live-turn status via a `chat:active` signal —
broadcast on every turn start/stop, sent as a snapshot to a newly-connected
socket, and sent in reply to a `chat:subscribe` for a running session. It carries
the running flag + the cancellable `jobId`.

- **#52 — Stop button restored on return.** Switching away from a still-streaming
  chat and back remounts the pane, which previously lost all in-flight state, so
  the composer showed Send (no Stop) and the running turn became uninterruptible.
  A remounting pane now learns its turn is live (with the job id) the instant it
  re-subscribes, so the Stop button — already correctly wired — comes back.
- **#53 — streaming indicators.** A persistent "agent is working…" pill (with
  cycling status text) shows under the transcript whenever a turn is in flight,
  including the initial thinking gap and the gaps between tool calls, and it lights
  up immediately on return to a streaming chat. The project sidebar shows a small
  pulsing dot next to any chat that is currently streaming — driven in real time
  from the `chat:active` broadcasts, so it works even for chats whose pane isn't
  mounted.
