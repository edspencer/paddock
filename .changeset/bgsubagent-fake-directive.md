---
"@edspencer/paddock": patch
---

test: add a `[[BGSUBAGENT]]` fake-Claude directive for a sub-agent that outlives its parent turn

The fake could not previously produce a sub-agent that is still running with no
live parent turn holding it open. Every existing directive keeps the parent turn
alive for as long as the sub-agent runs — `[[SUBAGENT]]` pairs the `Task` only
after its nested steps finish, and `[[SLOWTOOL]]` holds the turn open by design.

That gap made a whole bug class structurally untestable. Sub-agent progress is
polled over REST rather than streamed, and a live parent turn is exactly what
keeps the poll alive, so a nav-away/nav-back test written on either directive
**passes while the bug is live** (#725).

`[[BGSUBAGENT]]` pairs the `Task` tool_result immediately, lets the turn run on
to its terminal `result`, and then keeps appending sidechain steps for
`PADDOCK_FAKE_BGSUBAGENT_MS` (default 3000ms) — the detached state the bug needs.

Test-harness only: `test/bin/claude` is not part of the published package, and no
product code changes.
