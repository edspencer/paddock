---
"@paddock/server": minor
"@paddock/web": minor
---

Tell the agent it is in a browser: a small, overridable environment system prompt

Paddock injected no system prompt of its own. On a default instance the keeper ran
on Claude Code's stock preset, which is written for a terminal — nothing anywhere
told it that its replies render as GitHub-Flavored Markdown in a browser, that a
bare `#123` is dead text, or that `mcp__paddock__send_file` puts an image on screen.

An audit of the 100 most recent chats on the dogfood instance (3,944 assistant
messages, 2.1 MB of prose) measured the cost: **4,440 bare `#123` refs against 155
markdown links**, and **194 image reads / 138 screenshots with zero images ever sent
to a user**. In one chat that gap cost a full re-work round — the agent read 17 QC
frames, showed none, misread one, and shipped a regression the user then had to
screenshot themselves.

Paddock now appends a two-rule environment prompt to every keeper turn — *show,
don't describe* and *make clickable things clickable*. Both rules come from that
audit; several plausible-sounding extras ("no ANSI colour", "don't paste long
content", "use markdown structure") were measured, refuted, and cut.

Configure it with `PADDOCK_ENVIRONMENT_PROMPT` / `environmentPrompt:`, or from
**Settings → Capabilities → Environment prompt**, which gains a multi-line editor.
Unlike every other setting, blank is meaningful: omit the key for the built-in text,
set a string to replace it, set an empty string to append nothing.

One caveat, documented rather than papered over: on `driveMode: batch` the append is
withheld while the native system prompt is on. herdctl's CLI runtime has no
`--append-system-prompt`, so sending it there would swap Claude Code's entire coding
preset for two rules. The default `session` drive mode — what every chat actually
uses — appends properly.
