import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { AttentionChat } from "../../lib/types";

/**
 * How long to wait after the running set moves before refetching the feed
 * (#599). A single turn boundary fires two transitions in quick succession
 * (this chat stopped, that one started), and a burst of scheduled wake-ups can
 * fire a dozen — coalescing them into one request keeps Home from stampeding
 * the server every time the fleet twitches.
 */
const REFETCH_DEBOUNCE_MS = 250;

/**
 * Home's attention feed (#599): the chats in this workspace's SUBTREE that are
 * running right now, and the ones holding an unread reply.
 *
 * The server owns both derivations (see `GET <base>/chats/attention`), which is
 * the point: the ROOT's list is fleet-wide and a project's is scoped to itself,
 * but this hook cannot tell the difference — it asks its own workspace and
 * renders the answer. Root Home and project Home are therefore the same code
 * path, the same way the workspace ROUTES are one plugin mounted twice.
 *
 * `runningSessions` is passed in rather than watched here because ProjectView
 * already owns that WS-fed set (it must stay one fleet-wide set, not fragment
 * into a copy per consumer). It is used only as a CHANGE SIGNAL: any turn
 * starting or stopping anywhere means the feed is stale, so refetch. The
 * rendered `running` rows come from the server, which reads the authoritative
 * hub — not from intersecting this set with a chat list, which would silently
 * drop any running chat the client hasn't listed.
 */
export function useAttentionChats(
  slug: string,
  runningSessions: ReadonlySet<string>,
): {
  running: AttentionChat[];
  unread: AttentionChat[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [running, setRunning] = useState<AttentionChat[]>([]);
  const [unread, setUnread] = useState<AttentionChat[]>([]);
  // Only the FIRST load is a loading state. A refetch triggered by a turn
  // boundary keeps the current rows on screen: flashing skeletons every time
  // any chat in the fleet starts or stops a turn would make a busy instance's
  // Home unreadable.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guards an out-of-order response: two refetches in flight, the older one
  // landing last, would overwrite fresh rows with stale ones.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const res = await api.attentionChats(slug);
      if (seq !== seqRef.current) return;
      setRunning(res.running);
      setUnread(res.unread);
      setError(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : "Failed to load chats");
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [slug]);

  // The debounce effect below reaches `load` through a ref rather than taking
  // it as a dependency. `load` is keyed on `slug`, so depending on it directly
  // would re-arm the debounce on every workspace switch and fire a second,
  // redundant fetch 250ms behind the mount fetch — the effect must react to the
  // RUNNING SET moving, and to nothing else.
  const loadRef = useRef(load);
  loadRef.current = load;

  // Switching workspace is a different feed entirely — clear the rows rather
  // than leaving another workspace's chats on screen while the fetch lands.
  const seenFirstRunning = useRef(false);
  useEffect(() => {
    // A new workspace's first running-set observation is not a change worth
    // refetching for either: this effect is already fetching it.
    seenFirstRunning.current = false;
    setRunning([]);
    setUnread([]);
    setLoading(true);
    void load();
  }, [slug, load]);

  // Refetch (debounced) whenever the fleet's running set moves. Skips the very
  // first observation: the effect above already fetched, and the WS set arrives
  // moments later, which would otherwise make every mount fetch twice.
  useEffect(() => {
    if (!seenFirstRunning.current) {
      seenFirstRunning.current = true;
      return;
    }
    const t = setTimeout(() => void loadRef.current(), REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [runningSessions]);

  return { running, unread, loading, error, refresh: () => void load() };
}
