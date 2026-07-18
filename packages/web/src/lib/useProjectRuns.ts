// Run-history data hook (#268 / E3): fetches a project's recent runs + the
// viewer's since-last-visit state, exposes a refresh, and advances the "runs
// seen" watermark. Owned by ProjectView so the History tab badge (new unattended
// runs) can render without opening the tab; the HistoryPane consumes the same
// state. Follows the app's hand-rolled fetch idiom (no react-query).
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { ProjectRuns } from "./types";

export interface ProjectRunsState {
  data: ProjectRuns | null;
  loading: boolean;
  error: string | null;
  /**
   * Count of new unattended runs to badge — the payload's `newUnattended`, forced
   * to 0 once the viewer has opened the tab this session (see {@link markSeen}), so
   * the badge clears even if the open raced the initial fetch.
   */
  newUnattended: number;
  /** Re-fetch (recomputes `isNew`/`newUnattended` against the stored watermark). */
  refresh: () => Promise<void>;
  /**
   * Advance the server "runs seen" watermark to now and clear the badge count —
   * WITHOUT re-fetching, so the current view keeps its "new since last visit"
   * highlights until the user navigates away and back.
   */
  markSeen: () => Promise<void>;
}

export function useProjectRuns(slug: string): ProjectRunsState {
  const [data, setData] = useState<ProjectRuns | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Sticky "opened this session" flag: once the tab is viewed we suppress the
  // badge regardless of when the fetch lands (the open can race the fetch, so an
  // optimistic edit to `data` alone would be lost). Reset on a manual refresh.
  const [seen, setSeen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setSeen(false);
    try {
      const d = await api.projectRuns(slug);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load run history");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const markSeen = useCallback(async () => {
    setSeen(true);
    await api.markRunsSeen(slug).catch(() => undefined);
  }, [slug]);

  const newUnattended = seen ? 0 : (data?.newUnattended ?? 0);
  return { data, loading, error, newUnattended, refresh, markSeen };
}
