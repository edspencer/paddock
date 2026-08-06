---
"@paddock/server": patch
---

Say where a declared MCP server's credential actually ends up (follow-up to
#691 step 6).

`mcpServers:` keeps a resolved secret out of every surface Paddock owns — the
boot log, error messages, the Settings API. It does that completely, and it was
still not the whole story: on the **CLI runtime** (`driveMode: batch`) the engine
serialises the entire server definition, `env` values included, into a single
`--mcp-config` **command-line argument**. A process argument is world-readable on
Linux, so the token is legible to any local user through `/proc/<pid>/cmdline`
and `ps` for as long as the turn runs.

The default `driveMode: session` does not have this problem: the same record goes
to the SDK in-process, and the stdio server it spawns receives the value in its
environment, where `/proc/<pid>/environ` is owner-only — which is where Claude
Code itself puts it.

Paddock cannot close this from its side (the fix is upstream: the Claude CLI's
`--mcp-config` also accepts a *file path*), so it refuses to be silent instead.
An instance on `batch` with a credential-carrying declared server now gets a
**warning** at startup naming the server; one on `session` gets the same as an
informational note, because a single project pinning `driveMode: batch` brings
the exposure back. Documented alongside the block.

Verified rather than inferred: a new integration test drives a real turn and
reads the token back out of the spawned process's argv. It is a characterisation
test — if it ever starts failing, the engine has stopped doing this and both the
test and the warning should be deleted.
