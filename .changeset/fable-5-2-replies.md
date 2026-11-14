---
"@paddock/server": patch
---

Claude Fable 5.2 now replies (it appeared in the picker in 0.83.2, but every turn on it got no answer). The API refuses a model whose minimum Claude Code version is newer than the client: Fable 5.2 needs 2.1.290, and on the default session drive mode Paddock runs the Claude Agent SDK's **bundled** Claude Code rather than the `claude` on `PATH`, which was 2.1.283 (SDK 0.3.283). Bump `@herdctl/core` to 5.34.2, which raises the SDK floor to `^0.3.325` and so bundles Claude Code 2.1.325. Behaviour change inherited from that Claude Code: read-only `git` commands go through the permission flow instead of being auto-approved, unless `Bash` is allowed — which Paddock's fleet allowlist already does, so keepers are unaffected.
