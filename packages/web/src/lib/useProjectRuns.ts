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
  /** Re-fetch (recomputes `isNew`/`newUnattended` against the stored watermark). */
  refresh: () => Promise<void>;
  /**
   * Advance the server "runs seen" watermark to now and optimistically clear the
   * badge count locally — WITHOUT re-fetching, so the current view keeps its
   * "new since last visit" highlights until the user navigates away and back.
   */
  markSeen: () => Promise<void>;
}

export function useProjectRuns(slug: string): ProjectRunsState {
  const [data, setData] = useState<ProjectRuns | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
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
    // Optimistic: clear the badge locally but keep per-run `isNew` intact so the
    // open tab still shows what arrived while away.
    setData((d) => (d ? { ...d, newUnattended: 0 } : d));
    await api.markRunsSeen(slug).catch(() => undefined);
  }, [slug]);

  return { data, loading, error, refresh, markSeen };
}
