import { useCallback, useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";
import { homeUrl, viewBase } from "./urls";

/**
 * Every in-workspace navigation the route performs. The active tab, chat and file
 * are all derived from the URL (see `deriveView`), so each of these just changes
 * the route. Lifted out of `ProjectView` verbatim (#919).
 *
 * `base` is `""` at the root and `/projects/:slug` otherwise (#516).
 */
export function useWorkspaceNav(base: string, navigate: NavigateFunction, pathname: string) {
  // The effect below reads the pathname through `location`, as it did in place.
  const location = { pathname };
  // --- URL-driven navigation (all tab/chat/file clicks change the route) -----
  // Root Home is the bare `/` — there is no `/home` at the root (#516), so the
  // Home target is the only nav site that isn't a plain `${base}/…`.
  const goHome = useCallback(() => navigate(homeUrl(base)), [navigate, base]);
  const goChat = useCallback(() => navigate(`${base}/chat`), [navigate, base]);
  const goFiles = useCallback(() => navigate(`${base}/files`), [navigate, base]);
  const goChanges = useCallback(() => navigate(`${base}/changes`), [navigate, base]);
  const goHistory = useCallback(() => navigate(`${base}/history`), [navigate, base]);
  const goSettings = useCallback(() => navigate(`${base}/settings`), [navigate, base]);
  const goTriggers = useCallback(() => navigate(`${base}/triggers`), [navigate, base]);
  // Select a specific changed file in the Changes tab, reflecting it in the URL
  // so a specific diff/file is deep-linkable (issue #107). null clears to the
  // bare /changes route.
  const openChangeFile = useCallback(
    (file: string | null) =>
      navigate(
        file
          ? `${base}/changes/${encodeURIComponent(file)}`
          : `${base}/changes`,
      ),
    [navigate, base],
  );
  // The Hooks tab was renamed + folded into Triggers (Epic T / T4). Redirect any old
  // `/hooks` link/bookmark to the canonical `/triggers` route (replace so Back skips it).
  useEffect(() => {
    if (location.pathname.startsWith(`${base}/hooks`)) {
      navigate(`${base}/triggers`, { replace: true });
    }
  }, [location.pathname, navigate, base]);

  const openChat = useCallback(
    (sessionId: string) =>
      navigate(`${base}/chat/${encodeURIComponent(sessionId)}`),
    [navigate, base],
  );
  /**
   * Open a chat that may live in ANOTHER workspace (#599). Home's running and
   * unread feeds are subtree-wide, so on the root's Home most rows belong to a
   * project and have to navigate into that project's own base, not this one's.
   *
   * `viewBase` is what resolves the key, so the root (`""`) lands on the bare
   * top-level routes and a project on `/projects/:slug` — no branch here.
   */
  const openChatIn = useCallback(
    (sessionId: string, projectSlug: string) =>
      navigate(`${viewBase(projectSlug)}/chat/${encodeURIComponent(sessionId)}`),
    [navigate],
  );
  // Navigate the Files tab to a subpath — a folder, a file, or "" for the root
  // (issue #259). Each segment is encoded individually so the real "/" separators
  // stay in the URL (deep-linkable nested path) while odd filename characters are
  // still escaped.
  const goToFilesPath = useCallback(
    (subpath: string) =>
      navigate(
        subpath
          ? `${base}/files/${subpath.split("/").map(encodeURIComponent).join("/")}`
          : `${base}/files`,
      ),
    [navigate, base],
  );

  return {
    goHome,
    goChat,
    goFiles,
    goChanges,
    goHistory,
    goSettings,
    goTriggers,
    openChangeFile,
    openChat,
    openChatIn,
    goToFilesPath,
  };
}
