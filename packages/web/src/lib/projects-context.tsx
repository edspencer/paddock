import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import { isRootKey } from "../routes/ProjectView/urls";
import type { Project } from "./types";

interface ProjectsContextValue {
  /** The root workspace's CHILDREN. Never contains the root itself. */
  projects: Project[];
  /**
   * The ROOT workspace — the instance's own directory.
   *
   * Always exists, so there is no loading-vs-absent distinction to route on.
   * Deliberately NOT folded into `projects`: that list is the root's children
   * (`GET /api/projects` enumerates subdirectories), and the root belongs in
   * neither the grid nor the sidebar project list. It rides on the SAME
   * response though, carrying the same `chatTurns` field as its siblings — so
   * the sidebar's Home badge and a project row's badge are one computation over
   * one payload, not two implementations over two endpoints (#553).
   *
   * `null` here means only "the first fetch hasn't landed yet".
   */
  rootWorkspace: Project | null;
  /**
   * True only until the FIRST successful fetch lands (#572). Subsequent
   * refreshes revalidate quietly — the sidebar keeps rendering the list it has
   * rather than flashing placeholders over it. See {@link refresh}.
   */
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Insert/replace a workspace locally (after create) without a round-trip. */
  upsert: (p: Project) => void;
  /** Drop a project locally (after delete) without a round-trip. */
  remove: (slug: string) => void;
}

const Ctx = createContext<ProjectsContextValue | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [rootWorkspace, setRootWorkspace] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Whether a fetch has ever succeeded. Stale-while-revalidate hinges on this
   * (#572): `loading` used to mean both "we have never loaded the list" and
   * "we are re-checking a list we are already showing", and only the first
   * deserves a placeholder. `ProjectView` refreshes from three turn-lifecycle
   * callbacks, so the conflation blanked the whole sidebar twice per turn.
   *
   * A ref, not state: it must be readable synchronously inside `refresh` (two
   * refreshes can overlap) and it never needs to trigger a render of its own.
   * Keyed on a SUCCESSFUL fetch rather than on `projects.length`, so a first
   * load that legitimately returns zero projects still stops the placeholder —
   * while a first load that FAILED gets one again on retry, having nothing to
   * show in the meantime.
   */
  const loadedOnce = useRef(false);

  const refresh = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    setError(null);
    try {
      // One call for both: the children list and the root workspace, the root
      // enriched with the same `chatTurns` the sidebar badge folds. This used to
      // be two requests, the second a full `GET /api/root` detail fetch whose
      // `changelog` and `chats` were thrown away on arrival.
      const { projects, root } = await api.listProjects();
      loadedOnce.current = true;
      setProjects(projects);
      // Keep the last-known root on a null (unreadable record) rather than
      // blanking the sidebar; `null` still means "nothing has landed yet".
      if (root) setRootWorkspace(root);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  const upsert = useCallback((p: Project) => {
    // The root workspace is never a member of `projects` — that list is its
    // children, and the root belongs in neither the sidebar nor the grid.
    if (isRootKey(p.slug)) {
      setRootWorkspace(p);
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
    () => ({ projects, rootWorkspace, loading, error, refresh, upsert, remove }),
    [projects, rootWorkspace, loading, error, refresh, upsert, remove],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProjects(): ProjectsContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProjects must be used within ProjectsProvider");
  return v;
}
