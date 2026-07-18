// Sticky "last tab per project" persistence.
//
// We remember the last in-project sub-path the user was on for each project so
// that navigating to a project via the main nav/sidebar (the bare
// `/projects/:slug`) restores where they left off. Stored in localStorage under
// a per-slug key. The stored value is the sub-path WITHOUT a leading slash, one
// of: "home" | "chat" | "chat/<sessionId>" | "files" | "files/<encodedName>" |
// "changes" | "changes/<encodedFile>" | "settings".
//
// Scenario this satisfies: on project A viewing a pinned html file -> go to
// project B -> click back to A in the nav -> land back on that html file tab.

const PREFIX = "paddock:lastTab:";

/** A parsed in-project sub-path. */
export type SubPath =
  | { view: "home" }
  | { view: "chat"; sessionId?: string }
  // `path` is the project-relative files subpath (a directory or a file),
  // undefined at the root. Nested, e.g. "design/foo.md" (issue #259).
  | { view: "files"; path?: string }
  | { view: "changes"; file?: string }
  | { view: "history" }
  | { view: "settings" }
  | { view: "hooks" };

/** Encode a "/"-separated files subpath one segment at a time (keeps the "/"). */
function encodeFilesPath(subpath: string): string {
  return subpath.split("/").map(encodeURIComponent).join("/");
}

/** Read the stored sub-path for a project, or null if none/invalid. */
export function readLastTab(slug: string): string | null {
  try {
    const v = localStorage.getItem(PREFIX + slug);
    return v && isValidShape(v) ? v : null;
  } catch {
    return null;
  }
}

/** Persist the last sub-path (e.g. "files/my-page.html") for a project. */
export function writeLastTab(slug: string, subPath: string): void {
  try {
    if (isValidShape(subPath)) localStorage.setItem(PREFIX + slug, subPath);
  } catch {
    /* ignore (private mode / quota) */
  }
}

/** Forget a project's sticky tab (e.g. on project delete). */
export function clearLastTab(slug: string): void {
  try {
    localStorage.removeItem(PREFIX + slug);
  } catch {
    /* ignore */
  }
}

/** Cheap shape check so a corrupt/foreign value never drives navigation. */
function isValidShape(v: string): boolean {
  return (
    v === "home" ||
    v === "settings" ||
    v === "history" ||
    v === "hooks" ||
    /^chat(\/[^/].*)?$/.test(v) ||
    /^files(\/[^/].*)?$/.test(v) ||
    /^changes(\/[^/].*)?$/.test(v)
  );
}

/**
 * Derive the canonical in-project sub-path from the current view + params. The
 * file name is URL-encoded so any filename (spaces, dots) round-trips through
 * the URL and localStorage safely.
 */
export function toSubPath(sub: SubPath): string {
  if (sub.view === "home") return "home";
  if (sub.view === "settings") return "settings";
  if (sub.view === "history") return "history";
  if (sub.view === "hooks") return "hooks";
  if (sub.view === "chat") {
    return sub.sessionId ? `chat/${encodeURIComponent(sub.sessionId)}` : "chat";
  }
  if (sub.view === "changes") {
    return sub.file ? `changes/${encodeURIComponent(sub.file)}` : "changes";
  }
  // Files nest, so encode per-segment and keep the "/" separators — the stored
  // value mirrors the real nested URL (e.g. "files/design/foo.md"), issue #259.
  return sub.path ? `files/${encodeFilesPath(sub.path)}` : "files";
}

/**
 * Validate a stored sub-path against the project's current state, returning a
 * safe sub-path to redirect to. A `files/<name>` whose file (e.g. a pinned tab)
 * no longer exists falls back to "files"; everything else passes through. We do
 * NOT try to validate a specific chat sessionId here (the chat route hydrates
 * from history and shows an inline error if it's gone) — only the file tab,
 * whose existence we can cheaply check from the pinned/files list.
 */
export function validateSubPath(
  stored: string,
  opts: { pinned: string[]; files: string[] },
): string {
  if (stored.startsWith("files/")) {
    const sub = stored
      .slice("files/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    // A nested subpath (a folder, or a file inside one) can't be cheaply checked
    // against the top-level list — pass it through; the Files browser renders an
    // inline error if it's gone (issue #259). Only a bare top-level file name is
    // validated against the pinned/files lists.
    if (sub.includes("/")) return stored;
    const known = opts.pinned.includes(sub) || opts.files.includes(sub);
    return known ? stored : "files";
  }
  return stored;
}
