---
"@paddock/web": patch
---

Finished sub-agents now leave the running-work bar while their parent turn is still streaming (#911).

An agent that fans out, waits, and fans out again used to accumulate stale rows: five completed deep-reads sat in the bar beside three live edits under a header reading "8 sub-agents running", and every finished card kept its RUNNING chip, until the whole turn ended. Both of the client's exits from "running" were unreachable mid-turn — the server's final duration only arrives on a history join, and the silence-settle is deliberately gated on the parent's streaming state.

The bar now also treats the server's live background-task registry as a finished-signal: a task it showed us and then evicted is done. That verdict applies the moment the frame lands, outranks an in-flight poll, and stops further polling for that sub-agent.
