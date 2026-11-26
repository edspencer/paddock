import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import {
  readLastTab,
  readRecentChats,
  restoreChatSubPath,
  validateSubPath,
} from "../lib/lastTab";

/**
 * Bare `/projects/:slug` -> redirect to the STICKY last in-project tab for this
 * project (from localStorage), defaulting to `/home` (the project overview) when
 * nothing is stored.
 *
 * A stored `files/<name>` tab is validated against the project's current pinned
 * + files lists (a file that was unpinned/removed falls back to `/files`); a
 * stored home or new-chat tab passes through. A stored specific chat is checked
 * against the chat list: an archived (or gone) one is never restored — the last
 * opened active chat is, else a new chat. This is what the sidebar/grid links
 * target so the restore kicks in.
 */
export function ProjectRedirect() {
  const { slug = "" } = useParams();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const stored = readLastTab(slug);

    // Nothing stored -> default straight to the project home (no fetch needed).
    if (!stored) {
      setTarget("home");
      return;
    }
    // A home or new-chat sub-path needs no validation here.
    if (stored === "home" || stored === "chat") {
      setTarget(stored);
      return;
    }
    // A specific chat: never restore an archived one. Fall back to the last
    // opened chat that is still active, else a new chat. If the list can't be
    // read, restore the stored chat as before rather than guess.
    if (stored.startsWith("chat/")) {
      void api
        .listProjectChats(slug)
        .then((chats) => restoreChatSubPath(stored, readRecentChats(slug), chats))
        .catch(() => stored)
        .then((sub) => {
          if (!cancelled) setTarget(sub);
        });
      return () => {
        cancelled = true;
      };
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
    return <div className="p-8 text-sm text-fg-muted">Opening project…</div>;
  }
  return <Navigate to={`/projects/${slug}/${target}`} replace />;
}
