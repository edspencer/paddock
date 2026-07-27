// One-time migration of pre-#488 localStorage read-state up to the server.
//
// Before #488 the client kept a PERSISTENT localStorage `lastSeen` mirror and
// took `max(server, local)`. Removing that mirror makes the server authoritative
// (so devices stop diverging) — but it would also resurface as UNREAD every chat
// whose "read" was only ever recorded locally. On a long-lived instance that's
// dozens of chats the user genuinely read.
//
// So: push those legacy values up ONCE, then delete them. Safe because the server
// store is monotonic — an older value is a no-op there, and a newer server value
// always wins.
//
// The migration is driven from the projects payload rather than from localStorage
// alone, because the legacy keys are `paddock:lastSeen:<sessionId>` with NO
// project: `chatTurns` is what supplies the slug each `/seen` route needs. A chat
// that no longer exists is simply never matched, and its stale key is dropped at
// the end of the sweep.

import { api } from "./api";
import { clearLegacyLastSeen, legacyLastSeenEntries, setServerLastSeen } from "./lastSeen";
import type { Project } from "./types";

/** Cap concurrent backfill POSTs so a large legacy set can't stampede the server. */
const CONCURRENCY = 4;

/** Module-level guard: the sweep runs at most once per page load. */
let started = false;

/** Reset the once-per-load guard (tests only). */
export function resetBackfillForTests(): void {
  started = false;
}

/**
 * Backfill legacy localStorage read-state to the server, once per page load.
 *
 * For every legacy entry whose session id appears in `projects`' `chatTurns` and
 * whose value is NEWER than what the server reported, POST it to that project's
 * `/seen` route and fold it into the in-memory cache (so the UI doesn't flash the
 * chat unread mid-migration). Every matched key is then removed, along with any
 * legacy key that matched no known chat (a deleted chat — nothing to migrate).
 *
 * Best-effort and non-blocking: a failed POST leaves that key in place so the next
 * load retries it. Resolves when the sweep finishes (awaited by tests).
 */
export async function backfillLegacyLastSeen(projects: Project[]): Promise<void> {
  if (started) return;
  const legacy = legacyLastSeenEntries();
  if (legacy.size === 0) return;
  // Only claim the guard once there's real work — an early call with an empty
  // projects payload must not consume the single per-load attempt.
  const known = new Map<string, { slug: string; serverLastSeen: number }>();
  for (const p of projects) {
    for (const t of p.chatTurns ?? []) {
      if (legacy.has(t.sessionId)) {
        known.set(t.sessionId, { slug: p.slug, serverLastSeen: t.lastSeen ?? 0 });
      }
    }
  }
  if (known.size === 0) return;
  started = true;

  // Only push entries the server is actually behind on; the rest are already
  // covered and just need their stale key dropped.
  const pending = [...known]
    .filter(([sid, { serverLastSeen }]) => legacy.get(sid)! > serverLastSeen)
    .map(([sid, { slug }]) => ({ sid, slug, when: legacy.get(sid)! }));

  const migrated: string[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      try {
        await api.markChatSeen(item.slug, item.sid, item.when);
        // Reflect it locally so the cue doesn't flicker before the next refetch.
        setServerLastSeen(item.sid, item.when);
        migrated.push(item.sid);
      } catch {
        /* leave the key for the next load to retry */
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()),
  );

  // Drop what we migrated, plus everything the server already covers. Keys we
  // could NOT match against a known chat are deliberately left alone: the payload
  // may be partial (a project still loading, or one that failed to fetch), and a
  // key kept is harmless — a chat with no completed turn can never read as unread
  // — whereas a key wrongly deleted loses real read-state. They drain on a later
  // load once their project is present.
  const pendingIds = new Set(pending.map((p) => p.sid));
  const alreadyCovered = [...known.keys()].filter((sid) => !pendingIds.has(sid));
  clearLegacyLastSeen([...migrated, ...alreadyCovered]);
}
