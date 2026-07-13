---
"@paddock/web": patch
---

Stop rendering internal `<task-notification>` blocks as raw-XML chat bubbles (#181). When a background agent (Task/Agent tool) stops or completes, the Claude Code harness injects a `<task-notification>` block as a synthetic `role:"user"` transcript entry. It isn't flagged `isMeta:true`, so it survives `@herdctl/core`'s parser and used to render as a raw-XML user bubble on reload. Paddock now detects it (like the #106 compaction/slash-command artifacts) and renders a subtle, centered system-status line carrying the human-readable `<summary>` (full text on hover) instead.
</content>
