---
"@paddock/server": minor
"@paddock/web": minor
---

Per-message sender provenance: attribute machine-injected turns in chat history (#290)

Chats now record WHO injected each machine-added turn — `send_message` from another
chat, a schedule fire, or a spawn kickoff — and surface it per-message in the
transcript. Human-typed messages stay unlabelled (the default); a machine-injected
turn gets a subtle attribution above its bubble ("↩ sent by _⟨chat⟩_", linking to the
sending chat, or "⏰ scheduled by _⟨name⟩_"). This is the per-message analog of the
per-chat provenance badge (#261/#267), backed by a new `MessageProvenanceStore` sidecar
joined into the message DTO by injected-content order.

Also fixes the related live-streaming bug: an injected message now streams into an
already-open recipient chat immediately (a new `chat:injected` WebSocket frame),
instead of only showing the assistant's reply and requiring a manual refresh.
