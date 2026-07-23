---
"@paddock/server": patch
---

Refactor: split the oversized `self-mcp.ts` (~1160 lines) into focused per-tier modules (`self-mcp-{types,util,descriptions,read,write,triggers}.ts`), leaving `self-mcp.ts` as a thin assembly root that re-exports the public surface. Pure mechanical extraction — no behavior change; the `paddock_manage` MCP tool set and every import path are unchanged. Part of #403.
