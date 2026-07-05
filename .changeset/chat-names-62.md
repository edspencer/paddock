---
"@paddock/server": patch
---

Chat names no longer show the injected OVERVIEW blob (#62). For a project chat
with context preload, the first user message is the `<project-context>…` wrapper,
so the sidebar name fell back to unreadable overview text instead of the user's
request. (Claude Code's own 100-char preview truncates *inside* the wrapper, so a
naive preview-string strip can't recover it.)

The chat list now, only when there's no better name (no user rename, no
Claude-generated summary) and the preview is the preload wrapper, reads the
untruncated first user message and strips Paddock's wrapper to show the real
request. The wrapper is single-sourced in `preload.ts` (built by the WS layer,
stripped by the chat list) so the two can't drift. Claude Code's `autoName` is
still preferred once available; scratch chats (never preloaded) are untouched.
