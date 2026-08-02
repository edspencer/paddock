---
"@paddock/server": patch
---

Keep the running sub-agents bar alive when you navigate away from a chat and back (#622).

Re-opening a chat rehydrates it from history, and the history join left a
still-running `Task`/`Agent` launch unenriched — no `toolUseId`, no
`hasSubagent` — because it has no `tool_result` yet. The bar's candidates need
both, so it emptied for the rest of the sub-agent's run and its cards stopped
being expandable, self-healing only once the sub-agent finished. In-flight
launches are now joined off their own cursor, so they enrich like the live
`chat:tool_start` path does while completed sub-agents keep their exact
positional alignment.
