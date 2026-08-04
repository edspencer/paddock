#!/usr/bin/env node
/**
 * Printed as a `preinstall` script of the PUBLISHED package, before npm starts
 * fetching the dependency tree.
 *
 * Why this exists: Paddock depends on the Claude Agent SDK, whose per-platform
 * binary is ~250 MB. That download dominates a first `npx @edspencer/paddock`
 * and is long enough that, unannounced, it reads as a hang. It also cannot be
 * trimmed — the binary arrives via a platform optionalDependency, and
 * installing with `--omit=optional` produces a Paddock whose chats all fail.
 *
 * NOT wired into packages/server/package.json in the repo: a `preinstall` there
 * would fire on every workspace `npm install` a contributor runs. It belongs to
 * the synthesized publish manifest — see the npm packaging issue.
 *
 * npm may suppress this under `--silent` / non-TTY / some CI log levels, so it
 * is a courtesy, not a guarantee. The same warning belongs in the README, where
 * people actually look before running an unfamiliar command.
 */
if (!process.env.PADDOCK_QUIET_INSTALL) {
  process.stdout.write(
    [
      "",
      "  Paddock bundles the Claude Code runtime — about 250 MB on first install.",
      "  Later runs reuse the cache and start immediately.",
      "",
    ].join("\n") + "\n",
  );
}
