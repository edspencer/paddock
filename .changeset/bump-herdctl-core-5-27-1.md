---
"@paddock/server": patch
---

Bump `@herdctl/core` to **5.27.1**, which carries two data-integrity fixes to the
session layer Paddock reads on every listing.

**herdctl#419 — a failed metadata *read* no longer destroys the file.**
`SessionMetadataStore.loadMetadata()` collapsed three outcomes into one `null`:
the file was absent (legitimate — storage is sparse), it could not be read
(EACCES/EIO/truncated), or it failed schema validation. All seven setters then
treated `null` as "start fresh" and `atomicWriteJson`'d an empty file over the
top, silently wiping every `customName`, `preview`, `autoName`, `isSidechain`
and `usage` entry for that agent. Nothing surfaced an error — the write
succeeded, so it looked clean.

This was reachable in normal operation, not just under exotic disk faults: a
routine listing warms the enrichment cache, which is exactly the read-then-write
that triggers it. On this instance the blast radius was ~1,500 sessions of
user-authored chat names per agent file. 5.27.1 distinguishes *absent* from
*unreadable* — absent still creates an empty file, unreadable now throws
`SessionMetadataUnreadableError` **without writing**, leaving the bytes on disk
and recoverable.

**herdctl#424 — one unreadable transcript entry no longer blanks a listing.**
An entry that `stat()`s as a valid `.jsonl` but is actually a directory (Linux
`open(2)` succeeds, `read(2)` throws `EISDIR`) threw out of per-session
enrichment and took down the whole result: `getAgentSessions` lost the agent's
entire list and `getAllSessions` lost *every* agent's. Enrichment is now
isolated per entry — the bad one is skipped and warned, the rest still list.

The two fixes were verified to **compose**, not merely to co-exist: an
integration test upstream drives both failure modes simultaneously (a real
poison directory *and* a real corrupt metadata file) and asserts the good
sessions still list, `sessionCount` stays in sync, and the corrupt file survives
byte-for-byte. Each fix was also shown to be load-bearing by reverting it and
confirming the *right* assertion fails.

No Paddock code changes — `^5.27.0` already admitted this range; this pins the
floor so the lockfile resolves to a build containing the fixes.
