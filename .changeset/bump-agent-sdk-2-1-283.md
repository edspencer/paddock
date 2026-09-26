---
"@paddock/server": patch
---

Bump `@anthropic-ai/claude-agent-sdk` from 0.3.216 to 0.3.283, which raises the bundled `claude` binary from 2.1.216 to 2.1.283.

Chats resolve the CLI from the SDK's pinned platform optional-dependency, not from `PATH`. The bundled 2.1.216 is too old to run Claude Opus 5.5, so since #929 made `claude-opus-5-5` the instance default, every message on a project that had not pinned a model failed with:

```
API Error: 400 Claude Code 2.1.216 does not support this model;
version 2.1.280 or newer is required.
```

2.1.283 clears the 2.1.280 floor. Projects that pin an older model were never affected.
