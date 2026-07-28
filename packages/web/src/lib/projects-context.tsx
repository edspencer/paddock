import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import { ROOT_SLUG } from "../routes/ProjectView/urls";
import type { Project } from "./types";

interface ProjectsContextValue {
  projects: Project[];
  /**
   * The ROOT project (issue #516) — the project whose directory IS the projects
   * root — or `null` when this instance has none. Deliberately NOT folded into
   * `projects`: it is invisible to `GET /api/projects` (which enumerates
   * subdirectories) and never belongs in the grid or the sidebar project list.
   *
   * `undefined` while the first fetch is in flight, and that distinction is
   * load-bearing: `/` renders root Home when this is a project and the projects
   * grid when it is null, so routing must WAIT rather than flash the wrong one.
   */
  rootProject: Project | null | undefined;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Insert/replace a project locally (after create) without a round-trip. */
  upsert: (p: Project) => void;
  /** Drop a project locally (after delete) without a round-trip. */
  remove: (slug: string) => void;
  /** Record a freshly-created root project locally (after POST /api/root-project). */
  setRootProject: (p: Project) => void;
}

const Ctx = createContext<ProjectsContextValue | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [rootProject, setRootProject] = useState<Project | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
    // The root project rides along but is kept separate, and its failure is
    // non-fatal: an instance without one (the default) is simply the pre-#516
    // app, so resolving to `null` is the correct fallback for an older server
    // that 404s this endpoint too.
    setRootProject(await api.getRootProject().catch(() => null));
  }, []);

  const upsert = useCallback((p: Project) => {
    // The root project is never a member of `projects` (#516) — it would show up
    // in the sidebar and the grid, neither of which is where it belongs. Route it
    // to its own slot instead. No caller reaches this today (the root's Files and
    // Settings tabs, which upsert, land in later phases), but the invariant
    // should hold before those arrive rather than after.
    if (p.slug === ROOT_SLUG) {
      setRootProject(p);
      return;
    }
    setProjects((prev) => [p, ...prev.filter((x) => x.slug !== p.slug)]);
  }, []);

  const remove = useCallback((slug: string) => {
    setProjects((prev) => prev.filter((x) => x.slug !== slug));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ projects, rootProject, loading, error, refresh, upsert, remove, setRootProject }),
    [projects, rootProject, loading, error, refresh, upsert, remove],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProjects(): ProjectsContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProjects must be used within ProjectsProvider");
  return v;
}
