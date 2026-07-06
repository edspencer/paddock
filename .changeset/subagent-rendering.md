---
"@paddock/server": minor
"@paddock/web": minor
---

Render sub-agent (Task/Agent tool) activity in the chat UI (#37)

Sub-agent launches now render as a labelled, expandable block showing the
sub-agent type and description. Expanding lazy-loads the sub-agent's own
step-by-step transcript inline, recursively (a sub-agent that spawns its own
sub-agents is expandable to any depth). Implemented entirely paddock-side by
reading the on-disk `subagents/*.meta.json` sidecars and reusing
`@herdctl/core`'s `parseSessionMessages`; no upstream change. Handles both the
`Task` (Claude Code) and `Agent` (Agent SDK) tool names.
