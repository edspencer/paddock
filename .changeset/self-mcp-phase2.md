---
"@paddock/server": minor
"@paddock/web": minor
---

Add the Paddock self-management MCP **write tools** (issue #214, Phase 2). Behind the new `PADDOCK_SELF_MCP_WRITE` flag (on top of `PADDOCK_SELF_MCP`), keeper turns additionally get `create_chat`, `fork_chat`, `send_message`, and `fork_chat_batch` (fan-out) on the `paddock_manage` MCP server.

Each starts a real keeper turn routed through the shared SessionHub, so a spawned chat appears in the sidebar, flips the running indicator, streams live, and is re-attachable — full parity with a human-started turn. `fork_chat_batch` (cap 20) is the fan-out primitive: fork the current chat N times, one kickoff directive per line, run concurrently. Keeper-only; off by default; gated separately from the read tools because these start real work.

Containment: spawned turns get `send_file` only, not the self-MCP, so an automated fan-out cannot recurse into a fork bomb (a spawned chat regains the tools only when a human later drives it). No explicit recursion guard is built this phase (per #214); the injection path stays guard-ready.

Fork kickoffs are framed so a forked child treats the inherited (possibly mid-turn) transcript as context and runs its directive instead of inheriting the parent's identity. `fork_chat_batch` takes its list as newline/JSON text (the CLI-runtime MCP transport drops array-typed args). `fork_chat`/`send_message` validate the target session and return a clean "chat not found" instead of a raw ENOENT / false success.
