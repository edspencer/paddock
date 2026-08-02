---
"@paddock/server": minor
"@paddock/web": minor
---

Remove `scratch` entirely, including the legacy `scratchDir` config field (#549)

Scratch was retired as a feature in #516 Phase 6 and the root became a
first-class workspace in #533. The code was already gone; what survived was one
deliberately-kept config field and 232 stale references across 67 files.

**Removed config:** `PADDOCK_SCRATCH_DIR` / `scratchDir:` no longer exists. It
was kept so an existing env or config file wouldn't fail validation — back-compat
for an install base that doesn't exist.

**Stale settings are IGNORED, not fatal.** An instance that still sets
`PADDOCK_SCRATCH_DIR`, or whose `paddock.config.yaml` still carries `scratchDir:`,
boots normally and the value has no effect. This isn't a shim: config resolution
is pull-based on both layers — env vars are read by name, and the YAML file is
parsed into a loose record that is only ever read, never enumerated or validated
against a schema — so a deleted key is simply never looked at. The trade-off is
that a typo'd key is equally silent; that is deliberate, because an operator
should not be locked out of a running instance by a stale line in an old env file.

**Also removed:** the dead `isProjectChat` prop on the web `ChatPane` (its
`false` branch only ever described a scratch chat and no caller passed it), and a
dead flow in the manual `scripts/e2e.mjs` smoke script that waited on a "One-off
chat" heading the app no longer renders.

**Your data is untouched.** On an existing instance, old one-off transcripts
still sit at `<dataDir>/scratch/.chats`. They have been unreferenced and unlisted
since #516 and nothing in this change deletes them — if you don't want them, that
directory is safe to remove by hand.
