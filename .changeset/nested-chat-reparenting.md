---
"@paddock/server": patch
"@paddock/web": patch
---

Fix a nested chat list (#485) defect where a keeper reporting back could
re-parent the chat it reported to. The chat-list parent edge fell through to its
inference tier for any chat with no recorded parent — including chats whose
provenance already marks them as roots — so on the documented report-back
workflow (human starts a manager, manager spawns a child, child `send_message`s
home) the manager adopted its own child as its parent. Both edges then pointed at
each other and the tree builder's cycle guard picked a winner per render, so the
manager flipped between top-level and nested under its own child. Inference is
now skipped for a recorded root, and the "only the first injection marker counts"
rule is applied positionally as its documentation already claimed.

Also fixes two sidebar counts that read `.length` off a roots-only array while
their denominators stayed flat chat counts: the search badge (which read `1/40`
for a search matching five chats under one parent) and the Archived badge (which
undercounted nested archived chats).
