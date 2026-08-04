---
"@paddock/server": patch
---

Correct `paddock --help`: `--here` does not link `~/.claude`. #665 fixed the two
runtime `console.log` strings but missed the `USAGE` block, which still claimed the
flag "links `~/.claude/projects/<encoded-dir>` at this workspace". Since #620/#634 the
Claude home defaults to `<dataDir>/claude-home` and `transcripts.ts` bails before
planting a symlink in a home Paddock does not own — sessions are *offered* for import
and nothing is moved, copied or linked until you confirm (#663).
