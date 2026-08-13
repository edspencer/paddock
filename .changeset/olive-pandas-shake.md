---
"@paddock/web": patch
---

Running-work bar: show a background shell's COMMAND, not just its description.

A shell row used to show only the task's description — what the agent *intended*
to run. The case this comes from was fifteen hour-old shells reading `wait for
scan completion`, `block until scan done`, `final wait for scan`: every line a
plausible thing to be waiting on, so the bar read as a lot of work in progress.
All fifteen were in fact running the same loop, polling a log file that did not
exist, with `2>/dev/null` swallowing the error. Shown once, the command makes
that obvious; no amount of reading the descriptions can, because they were true
statements of intent.

The command is never on the background-task wire and cannot be put there from
here — that signal comes from the `claude` binary verbatim. But both halves of
the join are already on the client: the registry folds the launching
`tool_use_id` onto each task, and a Bash tool call's `inputSummary` *is* its
command. The bar now joins the two against the turns it is already rendering,
and shows the description beside the command rather than instead of it, so the
gap between stated intent and actual command is readable at a glance.

Degrades silently in every case it can't resolve — no tool id, no matching call,
or a launch scrolled out of loaded history — leaving the row exactly as it was.
No new exposure: a secret-bearing command was already rendered on its own tool
card in the transcript, from the same string.
