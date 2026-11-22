---
"@paddock/server": patch
---

A chat whose turn has ended but whose background work is still live now reads as running after a page reload, in `list_chats`, and in Home's Running list. Before, the connect-time catch-up sent `chat:active` only for running turns, and `list_chats` and `GET <workspace>/chats/attention` asked the session hub alone, so such a chat lost its sidebar dot and was reported as idle.
