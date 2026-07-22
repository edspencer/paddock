---
"@paddock/server": patch
"@paddock/web": patch
---

Fix live context meter inflating after tool-heavy turns (#398)

The live composer context meter (and chat-list ring) could jump far above the
true context — e.g. **828k/1M (83%)** live when the real window was ~292k
(~28%) — right after a long, multi-step turn. A refresh fixed it (the disk path
was already correct).

Root cause: the `ws.ts` turn loop ran `extractUsage` on every SDK message and
kept the block with the MAX `contextTokens` (`pickTurnUsage`, #165). It also read
top-level usage, so it ingested the terminal `type:"result"` message — whose
`usage` (`SDKResultSuccess.usage`) is the **cumulative** total aggregated across
every internal API call in the turn (`num_turns`), not a single context-window
snapshot. On a many-round turn that cumulative block dwarfs any single assistant
block, so it won the max and inflated `chat:complete.meta.usage.contextTokens`.
The result message is control-plane and never persisted to `.jsonl`, so the disk
endpoints only ever saw assistant blocks and stayed correct — hence a refresh
fixed it. (`pickTurnUsage`'s #165 comment assumed the result block carried zeroed
cache fields; the current SDK populates them cumulatively.)

Fix: `extractUsage` now flags the `type:"result"` message (`fromResult`), and the
turn loop (`foldTurnUsage`) routes its cumulative usage to a **separate** field
that never touches the context snapshot. The context meter derives from the
assistant snapshot only — the last assistant block's `input + cache_read +
cache_creation`, which grows monotonically through the turn ("last" == "max") and
matches the disk path exactly, so there is no overshoot and no refresh needed. The
#165 behaviour is preserved (a cache-less/zeroed block never lowers the snapshot,
and a result-only turn still falls back to the result). The result's cumulative
`outputTokens` is still surfaced (for the cost readout), just never as
`contextTokens`.
