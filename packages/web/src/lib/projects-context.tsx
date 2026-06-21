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
import type { Project } from "./types";

interface ProjectsContextValue {
  projects: Project[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Insert/replace a project locally (after create) without a round-trip. */
  upsert: (p: Project) => void;
}

const Ctx = createContext<ProjectsContextValue | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
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
  }, []);

  const upsert = useCallback((p: Project) => {
    setProjects((prev) => [p, ...prev.filter((x) => x.slug !== p.slug)]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ projects, loading, error, refresh, upsert }),
    [projects, loading, error, refresh, upsert],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProjects(): ProjectsContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProjects must be used within ProjectsProvider");
  return v;
}
