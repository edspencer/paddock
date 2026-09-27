---
"@paddock/server": patch
---

Bump `@herdctl/core` to 5.33.2, a security fix for projects on `driveMode: batch` (herdctl#467).

On batch, the tools Paddock injects into a turn (`send_file`, and `paddock_manage` where self-management is enabled) were served over an HTTP bridge that listened on every network interface with no authentication, so anything that could reach the host could call them while a turn was running. The bridge now binds to `127.0.0.1` and requires a per-bridge bearer token.

Batch turns also no longer put the MCP server config on `claude`'s command line: it is written to an owner-only temp file and passed by path, so a declared `mcpServers:` credential (`env` or `headers`) is no longer readable from `ps` / `/proc/<pid>/cmdline`. The one exception is a project with `docker: true` on batch, where herdctl's Docker runner still passes the config inline on the `docker exec` command line; the startup warning now names that case specifically.

The default `driveMode: session` never used the bridge and is unaffected. No configuration changes are needed.
