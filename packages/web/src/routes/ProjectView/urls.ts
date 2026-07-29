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
  | "triggers"
  // The root workspace's children — the projects grid. Only the root has
  // children today, so only the root renders this tab; when nesting lands every
  // workspace gets it for free.
  | "projects";

/**
 * A **workspace key** — a workspace's path relative to the projects root, and
 * `""` for the ROOT workspace. Mirrors the server's `WorkspaceKey`/`ROOT_KEY`.
 *
 * There is no sentinel: the root's key is the empty string, which is also what
 * makes {@link viewBase} a plain conditional on emptiness rather than a
 * comparison against a magic value.
 */
export type WorkspaceKey = string;

/** The ROOT workspace's key. */
export const ROOT_KEY: WorkspaceKey = "";

/** Whether a key addresses the root workspace. */
export function isRootKey(key: WorkspaceKey): boolean {
  return key === ROOT_KEY;
}

/**
 * The API prefix a workspace's endpoints hang off.
 *
 * The server mounts the workspace-scoped routes twice — `/api/root` for the root
 * workspace and `/api/projects/:slug` for a project — because an empty key
 * cannot ride in a URL path segment. Same handlers on both mounts; this is the
 * client half of that seam.
 */
export function apiBase(key: WorkspaceKey): string {
  return isRootKey(key) ? "/api/root" : `/api/projects/${encodeURIComponent(key)}`;
}

/**
 * The URL prefix every one of a workspace's sub-routes hangs off. The seam that
 * lets one `ProjectView` serve both:
 *
 *   project → `/projects/:slug`  → `/projects/:slug/home`, `/projects/:slug/chat`, …
 *   root    → `""`               → `/`,                    `/chat`, …
 *
 * Everything downstream just does `${base}/chat` and stops caring which it is.
 */
export function viewBase(key: WorkspaceKey): string {
  return isRootKey(key) ? "" : `/projects/${key}`;
}

/**
 * The Home URL for a workspace — the one nav target that isn't a plain
 * `${base}/<tab>`. A project's Home is `/projects/:slug/home`; the root's is the
 * bare `/`, because at the root `/` IS Home (no `/home`, no redirect).
 */
export function homeUrl(base: string): string {
  return base === "" ? "/" : `${base}/home`;
}

/**
 * Where the projects grid lives: `/projects`, always.
 *
 * The grid is the root workspace's **children** tab, not a top-level page — the
 * root workspace always exists, so `/` is always root Home and the grid always
 * has its own URL. (This used to take a `hasRootProject` flag, because the root
 * was optional and `/` belonged to whichever existed. Nothing is optional now.)
 */
export function gridUrl(): string {
  return "/projects";
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
 * Home (no redirect, no sticky last tab), whereas a bare `/projects/:slug` still
 * falls through to the chat tab exactly as before.
 */
export function deriveView(pathname: string, base: string): ProjectViewTab {
  const tail = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  // The root workspace's children tab. Matched EXACTLY, not by prefix: at the
  // root `base` is "", so a prefix test would also swallow `/projects/foo/files`
  // — a project's own URL — and render the grid instead of that project.
  if (tail === "/projects" || tail === "/projects/") return "projects";
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
