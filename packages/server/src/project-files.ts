/**
 * project-files — the read-only freeform-file surface for a project directory.
 *
 * Extracted from projects.ts (issue #403): the path-traversal guard plus the
 * directory listing + file readers (text / raw bytes / kind-hinted). Pure free
 * functions taking `(root, slug, …)` — no `ProjectStore` state beyond the
 * projects root — so `ProjectStore` keeps thin delegate methods over these and
 * the public API is unchanged. `ProjectError` codes are preserved exactly.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ProjectError, isRootSlug } from "./project-paths.js";
import { fileKind, contentTypeFor } from "./project-mime.js";
import type { FileEntry, FileKind } from "./project-types.js";

/**
 * The per-slug project directory under the projects root — a second copy of
 * `ProjectStore.dirFor`'s resolution, and so the second place the ROOT project
 * (issue #516) has to be honoured: its directory IS the projects root.
 *
 * Without this branch every file route for `__root` resolves to
 * `<projectsRoot>/__root` and 404s (found in live QA — Home fetches the file
 * list on load). The traversal guard below is unaffected: it compares against
 * whatever this returns, so at the root "inside the project dir" means "inside
 * the projects root", which is exactly the scope of a keeper whose cwd is that
 * directory.
 */
function dirFor(root: string, slug: string): string {
  if (isRootSlug(slug)) return root;
  return path.join(root, slug);
}

/**
 * Resolve a freeform file name to an absolute path inside the project dir,
 * rejecting path traversal AND traversal *through* a hidden (dot-prefixed)
 * directory. The single guard shared by every file read and by the directory
 * listing (issue #259). The project root itself (`name === ""`) resolves to the
 * project dir and is allowed, so a root listing passes through.
 *
 * **Why hidden directories are refused, not merely omitted.** {@link listFiles}
 * drops dot-prefixed entries from what it *returns*, which is presentation, not
 * access control: naming the path explicitly still resolved it. And the read
 * route's `:name` param decodes `%2F`, so a nominally single-segment route
 * accepts a whole nested path. Together those let a caller read
 * `…/files/.chats%2F<id>.jsonl` (a full chat transcript) or
 * `…/files/.git%2Fconfig` (which carries credentials when a remote embeds a
 * token). The root project (#516) widened the blast radius from one project's
 * subtree to the instance's own backing repo and every project at once.
 *
 * **Why the LEAF may still be a dotfile.** Refusing every dot segment was the
 * first cut, and it broke Changes: an UNTRACKED file has no diff, so the pane
 * renders its content through this very surface — and `.gitignore` is untracked
 * in a freshly-created repo-backed project, because `ensureSidecarGitignore`
 * writes it. So a legitimate, visible-in-the-UI file became unopenable. The harm
 * is *descending into* `.git/` and `.chats/`, not reading a dotfile git is
 * already showing you, so the guard is scoped to directory segments.
 * {@link listFiles} additionally refuses a hidden LEAF, because listing one is
 * how `?path=.chats` enumerated every transcript.
 *
 * Honest severity: **defense-in-depth, not a privilege boundary.** Paddock has
 * no per-user role model, and any caller who can reach these routes can already
 * start a keeper chat and run Bash — strictly more capability than reading a
 * file. The `/mcp` read-only token surface exposes no file verb, so it is not
 * reachable there either. This is worth closing because "hidden in the listing"
 * should not be the only thing standing between an API and a transcript, not
 * because it grants anything new.
 */
export function resolveInProject(root: string, slug: string, name: string): string {
  const dir = dirFor(root, slug);
  const resolved = path.resolve(dir, name);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new ProjectError("Invalid file path", "invalid");
  }
  // Check the RESOLVED path's segments relative to the project dir, not the
  // caller's raw string: `a/./.git/config` and `a/../.git/config` both normalise
  // to a hidden directory segment the raw string doesn't literally contain. The
  // project dir itself may legitimately sit under a dot-prefixed ancestor (a
  // data dir like `/srv/.paddock/projects`), which is why only the relative part
  // is examined. `slice(0, -1)` leaves the leaf to the caller (see doc-comment).
  const segments = relSegments(dir, resolved);
  if (segments.slice(0, -1).some(isHidden)) {
    throw new ProjectError("Invalid file path", "invalid");
  }
  return resolved;
}

/** Path segments of `resolved` relative to `dir` ([] when they're the same). */
function relSegments(dir: string, resolved: string): string[] {
  const rel = path.relative(dir, resolved);
  return rel ? rel.split(path.sep) : [];
}

function isHidden(segment: string): boolean {
  return segment.startsWith(".");
}

/**
 * List one level of a project directory (issue #259). `subpath` is a
 * project-relative directory ("" = the project root); the returned entries
 * carry a `kind` so the UI can distinguish (and descend into) subdirectories.
 * Dotfiles are hidden as before; entries sort directories-first, then by name.
 *
 * Traversal is guarded by the shared `resolveInProject`, so `subpath` can't
 * escape the project dir. Throws `ProjectError("not_found")` when the directory
 * doesn't exist and `ProjectError("not_directory")` when `subpath` is a file —
 * the latter lets the caller fall back to rendering that file.
 */
export async function listFiles(
  root: string,
  slug: string,
  subpath = "",
): Promise<FileEntry[]> {
  const target = resolveInProject(root, slug, subpath);
  // A LISTING target is a directory, so unlike a read the leaf gets no pass:
  // `?path=.chats` is exactly how every transcript filename was enumerable.
  const leaf = relSegments(dirFor(root, slug), target).at(-1);
  if (leaf && isHidden(leaf)) {
    throw new ProjectError("Invalid file path", "invalid");
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ProjectError(`Directory not found: ${subpath}`, "not_found");
    if (code === "ENOTDIR") throw new ProjectError(`Not a directory: ${subpath}`, "not_directory");
    throw err;
  }
  return entries
    .filter((e) => !e.name.startsWith("."))
    .map((e): FileEntry => ({ name: e.name, kind: e.isDirectory() ? "dir" : "file" }))
    .sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
    );
}

/** Read a freeform file's contents as UTF-8 text (path-traversal guarded). */
export async function readProjectFile(
  root: string,
  slug: string,
  name: string,
): Promise<string> {
  return fs.readFile(resolveInProject(root, slug, name), "utf8");
}

/**
 * Read a file's raw bytes + its MIME type (issue #61), for the binary/image
 * endpoint. Path-traversal guarded; throws ProjectError("not_found") if the
 * file is missing so the route can 404 cleanly. NOT decoded as text, so binary
 * (image) bytes survive intact.
 */
export async function readFileBytes(
  root: string,
  slug: string,
  name: string,
): Promise<{ bytes: Buffer; mime: string }> {
  const resolved = resolveInProject(root, slug, name);
  try {
    const bytes = await fs.readFile(resolved);
    return { bytes, mime: contentTypeFor(name) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectError(`File not found: ${name}`, "not_found");
    }
    throw err;
  }
}

/**
 * Read a file plus a render-kind hint derived from its extension, for the
 * UI's markdown/Mermaid + sandboxed-iframe renderers (issue #3) and the image
 * viewer (issue #61).
 *
 * For an IMAGE the raw bytes are NOT returned here (decoding binary as UTF-8
 * would mangle it): `content` is empty and the client fetches the bytes from
 * the raw endpoint. We still stat the file so a missing image 404s. Path-
 * traversal guarded; throws ProjectError("not_found") when missing.
 */
export async function readFileWithKind(
  root: string,
  slug: string,
  name: string,
): Promise<{ name: string; kind: FileKind; content: string }> {
  const kind = fileKind(name);
  if (kind === "image") {
    // Existence check only — the bytes go over the raw endpoint.
    try {
      await fs.stat(resolveInProject(root, slug, name));
    } catch (err) {
      if (err instanceof ProjectError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProjectError(`File not found: ${name}`, "not_found");
      }
      throw err;
    }
    return { name, kind, content: "" };
  }

  let content: string;
  try {
    content = await readProjectFile(root, slug, name);
  } catch (err) {
    if (err instanceof ProjectError) throw err; // traversal -> "invalid"
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectError(`File not found: ${name}`, "not_found");
    }
    throw err;
  }
  return { name, kind, content };
}
