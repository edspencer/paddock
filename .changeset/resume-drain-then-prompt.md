---
"@paddock/server": patch
---

Fix the resume self-interrupt that lost the human turn (#427). A resume consumer broke its message loop on the FIRST `result`; when a resumed session had a pending async-input backlog (e.g. leftover killed-task notifications), the CLI replayed that backlog as its own turn whose `result` closed the CLI (~2s grace) and killed a slow human turn. All resume consumers now drain the backlog before breaking (residue-gated drain-then-prompt via `consumeResumedTurn`), so the human turn is the last one and survives.
