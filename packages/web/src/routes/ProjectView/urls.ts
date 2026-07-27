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
 * The reserved slug of the ROOT project (issue #516) — mirrors the server's
 * `ROOT_SLUG`. The root is an ordinary project whose directory is the projects
 * root itself, so it addresses the same `/api/projects/:slug/…` endpoints; only
 * its BROWSER urls differ (they're flat and top-level).
 */
export const ROOT_SLUG = "__root";

/**
 * The URL prefix every one of a context's sub-routes hangs off (issue #516).
 * This is the seam that lets one `ProjectView` serve both:
 *
 *   project → `/projects/:slug`  → `/projects/:slug/home`, `/projects/:slug/chat`, …
 *   root    → `""`               → `/`,                    `/chat`, …
 *
 * Everything downstream just does `${base}/chat` and stops caring which it is.
 */
export function viewBase(slug: string): string {
  return slug === ROOT_SLUG ? "" : `/projects/${slug}`;
}

/**
 * The Home URL for a context — the one nav target that isn't a plain
 * `${base}/<tab>`. A project's Home is `/projects/:slug/home`; the root's is the
 * bare `/`, because at the root `/` IS Home (no `/home`, no redirect — #516).
 */
export function homeUrl(base: string): string {
  return base === "" ? "/" : `${base}/home`;
}

/**
 * Which sub-route are we on? Derived from the URL pathname so it updates on
 * client-side navigation (the `/home`, `/files`, `/changes`, … segments
 * distinguish those tabs). The Hooks tab was renamed to Triggers (Epic T / T4);
 * both the new `/triggers` route and the legacy `/hooks` route resolve to it
 * (the latter kept as a redirect so old links / bookmarks don't 404).
 *
 * `base` is {@link viewBase} — `""` at the root. The bare path means different
 * things in the two contexts, which is the ONLY asymmetry here: `/` **is** root
 * Home (no redirect, no sticky last tab — #516), whereas a bare
 * `/projects/:slug` still falls through to the chat tab exactly as before.
 */
export function deriveView(pathname: string, base: string): ProjectViewTab {
  const tail = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  if (tail.startsWith("/files")) return "files";
  if (tail.startsWith("/changes")) return "changes";
  if (tail.startsWith("/history")) return "history";
  if (tail.startsWith("/settings")) return "settings";
  if (tail.startsWith("/triggers") || tail.startsWith("/hooks")) return "triggers";
  if (tail.startsWith("/home")) return "home";
  if (tail.startsWith("/chat")) return "chat";
  return base === "" ? "home" : "chat";
}

/**
 * Extract the Files-tab subpath from the pathname (issue #259): whatever follows
 * `<base>/files/`, decoded one segment at a time so real "/" separators survive
 * intact (a raw `decodeURIComponent` of the whole thing is fine here too, but
 * per-segment mirrors exactly how goToFilesPath encodes it). "" = the root.
 */
export function decodeFilesSubpath(pathname: string, base: string): string {
  const prefix = `${base}/files`;
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
