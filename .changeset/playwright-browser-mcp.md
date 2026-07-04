---
"@paddock/server": minor
---

Add an optional Playwright browser MCP to the keeper + scratch agents

Keeper and scratch Claude Code agents can now drive a headless Chromium via the `@playwright/mcp` server (navigate / click / fill / snapshot / screenshot). The server is attached only when `PADDOCK_BROWSER_MCP=1` is set in the instance env — so a box without the browser stack simply omits it (no failed spawns) and enabling it is a per-box env flip. The `mcp__playwright__*` tool pattern is added to the default agent allowlist unconditionally (a no-op when the server is absent); the tool-less sweeper never receives the server. Chromium runs headless with `--no-sandbox` (`--isolated` profile) for unprivileged-LXC deployments.
