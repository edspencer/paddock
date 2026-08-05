---
"@paddock/server": patch
---

A credential-less first run no longer greets you with a stack-trace wall (#684).

`npx @edspencer/paddock --here` with no token printed a multi-screen dump containing
the entire sweeper system prompt four times — in the `ExecaError`, in the
`[fleet-manager]` line, in the serialised `err.message` and again in `err.stack`. The
one useful string, `Not logged in · Please run /login`, was on line 40. The server was
fine and still serving; nothing in the output said so.

- The sweeper recognises "not logged in", "out of credit" and "no `claude` on PATH"
  and logs one actionable warn line with no error object to serialise. An
  unrecognised failure keeps its full detail.
- The `claude` argv is cut out of `@herdctl/core`'s agent-failure lines, taking the
  2 KB system prompt with it. `HERDCTL_LOG_LEVEL=debug` restores it.
- The CLI's quiet mode now actually covers failures. `LOG_LEVEL=warn` never could:
  these are logged at `error`, above every threshold either variable can set.

Measured on the repo's own test-suite log: eight copies of the curator system prompt
before, zero after.
