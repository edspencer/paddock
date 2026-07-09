---
"@paddock/web": patch
---

Fix voice dictation on touch devices: after tapping stop, iOS Safari's sticky `:hover` kept the mic button showing a stop icon (with the recording tint) instead of the transcribing spinner, so it looked like nothing was happening. Hover-only affordances on the dictation button are now gated behind a new `can-hover` Tailwind variant (`@media (hover: hover)`).
