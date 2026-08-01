---
"@paddock/server": patch
"@paddock/web": patch
---

Stop a foreground sub-agent leaking its steps into the parent transcript, and
show what running sub-agents are doing.

**The leak.** Launching a sub-agent with `run_in_background: false` duplicated
every one of its steps: once inside the sub-agent card (correct) and once as
top-level rows of the *parent* transcript. A three-step sub-agent therefore
printed three phantom `Read`/`Bash` rows next to the card that already contained
them.

The filter that prevents this (`isSidechainMessage` — a nested step carries
`parent_tool_use_id`) existed, but only ONE of the five live turn paths called
it: the background sink. That gap was deliberate, and wrong. A comment on the
sink recorded the premise that only a *backgrounded* `Task` streams its nested
steps inline, a foreground one being routed by herdctl to "a SEPARATE sidechain
session, never the main turn stream". Under SDK streaming mode that is false — a
foreground `Task` streams its steps inline on whichever turn stream launched it,
so every unfiltered path duplicated them. The filter now runs on all five
(`chat:send`, slash-command, scheduled wake, `startAgentTurn`, background sink),
with the false premise corrected in place so it cannot be re-derived.

The bug was live-only, which is why it survived: history has always filtered
sidechain steps, so a reload "healed" the transcript and the duplication read as
a streaming glitch. The regression test therefore asserts over WS **frames**, not
the persisted transcript — the persisted view was never broken. A new
`[[SUBAGENT]]` directive in the test `claude` emits a real foreground Task with
inline sidechain steps to drive it.

Skipping these messages also keeps a sub-agent's context out of the parent's live
context meter, which `foldTurnUsage` would otherwise latch onto as its max — the
same shape as the #398 inflation, corrected only on refresh.

**Seeing what a sub-agent is doing.** A sub-agent could work for minutes behind a
collapsed card showing only a cost, with no indication of progress — and the card
is often scrolled well out of view. A live bar above the composer now lists each
RUNNING sub-agent with its latest step and step count, updating as it works.
Tapping a row scrolls that sub-agent's card into view, expands it, and flashes it
so the eye lands on it (`prefers-reduced-motion` drops the flash).

Polling is hoisted out of the card into the chat, so it stays at one request per
sub-agent per tick and a card reads the shared result instead of opening a second
poll — expanding a card now costs no extra fetching. The bar and the card decide
"is it running" through one shared `isSubagentRunning` predicate, so they cannot
disagree the way the five stream handlers did.
