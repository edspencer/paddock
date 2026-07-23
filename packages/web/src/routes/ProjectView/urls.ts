/**
 * URL helpers for the ProjectView route — pure string functions shared by the
 * route shell and its child panes (extracted from ProjectView.tsx, issue #403).
 */

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
