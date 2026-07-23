/**
 * URL helpers for the ProjectView route — pure string functions shared by the
 * route shell and its child panes (extracted from ProjectView.tsx, issue #403).
 */

/** The active main-area tab. Derived purely from the URL (see `deriveView`). */
export type ProjectViewTab =
  | "home"
  | "chat"
  | "files"
  | "changes"
  | "settings"
  | "history"
  | "triggers";

/**
 * Which sub-route are we on? Derived from the URL pathname so it updates on
 * client-side navigation (the `/home`, `/files`, `/changes`, … segments
 * distinguish those tabs; anything else is the chat tab). The Hooks tab was
 * renamed to Triggers (Epic T / T4); both the new `/triggers` route and the
 * legacy `/hooks` route resolve to it (the latter kept as a redirect so old
 * links / bookmarks don't 404).
 */
export function deriveView(pathname: string, slug: string): ProjectViewTab {
  const base = `/projects/${slug}`;
  if (pathname.startsWith(`${base}/files`)) return "files";
  if (pathname.startsWith(`${base}/changes`)) return "changes";
  if (pathname.startsWith(`${base}/history`)) return "history";
  if (pathname.startsWith(`${base}/settings`)) return "settings";
  if (pathname.startsWith(`${base}/triggers`) || pathname.startsWith(`${base}/hooks`))
    return "triggers";
  if (pathname.startsWith(`${base}/home`)) return "home";
  return "chat";
}

/**
 * Extract the Files-tab subpath from the pathname (issue #259): whatever follows
 * `/projects/:slug/files/`, decoded one segment at a time so real "/" separators
 * survive intact (a raw `decodeURIComponent` of the whole thing is fine here too,
 * but per-segment mirrors exactly how goToFilesPath encodes it). "" = the root.
 */
export function decodeFilesSubpath(pathname: string, slug: string): string {
  const prefix = `/projects/${slug}/files`;
  if (!pathname.startsWith(prefix)) return "";
  const rest = pathname.slice(prefix.length).replace(/^\//, "");
  if (!rest) return "";
  return rest
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
}

/**
 * Best-effort browsable URL for a repo-backed project's repo (issue #187): strip
 * a trailing `.git`, and rewrite an `scp`-style `git@host:owner/repo` into
 * `https://host/owner/repo` so the "Repo" badge links somewhere useful. A plain
 * https/http URL passes through; anything unrecognized (a local path) falls back
 * to `#` so the badge is inert rather than broken.
 */
export function repoHref(repo?: string): string {
  if (!repo) return "#";
  const trimmed = repo.trim().replace(/\.git$/i, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const scp = /^git@([^:]+):(.+)$/.exec(trimmed);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/git@([^/]+)\/(.+)$/i.exec(trimmed);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return "#";
}
