---
"@paddock/server": patch
"@paddock/web": patch
---

Stop describing a trigger with no tools as an enforced tool-less agent (#647)

Paddock expresses "no tools" as `allowed_tools: []`, and both herdctl runtimes emit
the allow-list **only when it is non-empty** — the CLI runtime guards
`if (allowed_tools?.length)` before pushing `--allowedTools`, and `toSDKOptions`
does the same before setting `allowedTools`. An empty list is therefore
indistinguishable from an unset one: the agent runs with Claude Code's default
tools, not a deny-all.

The source comments and the Triggers UI claimed the opposite. Nothing about the
runtime changes here — only what Paddock says about it:

- The trigger capability banner no longer promises a `tools: []` event trigger
  "can only read its prompt and respond (no file, shell, or MCP access)". It now
  says no tools were declared, that an empty list is not a restriction, and that
  the prompt and max turns are the real bounds.
- The Triggers list shows "No tools" instead of "Tool-less", and the tool picker's
  help text spells out that leaving everything unchecked is not a deny-all.
- The comments on `triggerToAgentToolConfig`, `hookToAgentToolConfig` and the
  sweeper config describe what actually happens. The sweeper's tool-less-ness is
  restated in terms of the properties that do hold: no injected MCP servers,
  `max_turns: 4`, a system prompt that forbids tool use, and a non-interactive
  `claude -p` run that cannot answer a permission prompt.

Making a tool grant enforceable at all is tracked separately in #319; this change
deliberately implements no enforcement.
