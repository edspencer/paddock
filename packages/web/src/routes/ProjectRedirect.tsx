import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { readLastTab, validateSubPath } from "../lib/lastTab";

/**
 * Bare `/projects/:slug` -> redirect to the STICKY last in-project tab for this
 * project (from localStorage), defaulting to `/chat` when nothing is stored.
 *
 * A stored `files/<name>` tab is validated against the project's current pinned
 * + files lists (a file that was unpinned/removed falls back to `/files`); a
 * stored chat passes through (the chat route surfaces a missing session inline).
 * This is what the sidebar/grid links target so the restore always kicks in.
 */
export function ProjectRedirect() {
  const { slug = "" } = useParams();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const stored = readLastTab(slug);

    // Nothing stored -> default straight to chat (no fetch needed).
    if (!stored) {
      setTarget("chat");
      return;
    }
    // A chat sub-path needs no validation here.
    if (stored.startsWith("chat")) {
      setTarget(stored);
      return;
    }

    // A files sub-path: validate the file still exists before restoring it.
    void Promise.all([
      api.getProjectDetail(slug).then((d) => d.project.pinned).catch(() => [] as string[]),
      api.listProjectFiles(slug).catch(() => [] as string[]),
    ]).then(([pinned, files]) => {
      if (cancelled) return;
      setTarget(validateSubPath(stored, { pinned, files }));
    });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (target === null) {
    return <div className="p-8 text-sm text-paddock-500">Opening project…</div>;
  }
  return <Navigate to={`/projects/${slug}/${target}`} replace />;
}
