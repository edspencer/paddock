/**
 * project-files — the read-only freeform-file surface for a project directory.
 *
 * Extracted from projects.ts (issue #403): the path-traversal guard plus the
 * directory listing + file readers (text / raw bytes / kind-hinted). Pure free
 * functions taking `(dir, …)` — no `ProjectStore` state at all — so
 * `ProjectStore` keeps thin delegate methods over these and the public API is
 * unchanged. `ProjectError` codes are preserved exactly.
 *
 * **`dir` is the project's CONTENT dir, not `projectsRoot/<slug>`** (issue #710).
 * These used to take `(root, slug)` and re-derive the directory by joining, which
 * was right only while a project's content lived under the projects root. A
 * MANAGED project with a `path:` (issue #206) keeps its curated trio out at that
 * path, so the join addressed a directory holding nothing but `project.yaml` and
 * the whole Files tab came back empty. Taking the directory the caller already
 * resolved removes the second copy of that resolution rather than teaching it a
 * new case — see {@link import("./project-paths.js").contentDirFor}.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ProjectError } from "./project-paths.js";
import { fileKind, contentTypeFor } from "./project-mime.js";
import type { FileEntry, FileKind } from "./project-types.js";

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
 *
 * **`hiddenSegments: "allow"`** turns the dot-directory half off, leaving only
 * containment (issue #710). It exists for exactly one caller: `/git/file`, which
 * serves a file from the project's WORKING directory and has already checked
 * that `git status` reports that path as untracked. A git-verified allowlist is
 * strictly stronger than this heuristic — git never names `.git` and never names
 * an ignored path — and the heuristic is actively wrong out there, because a new
 * `.github/workflows/ci.yml` is an ordinary Changes-tab row that a dot-directory
 * rule refuses to render. Every other caller keeps the default. Pass it only
 * with an independent allowlist in hand.
 */
export function resolveInProject(
  dir: string,
  name: string,
  hiddenSegments: "refuse" | "allow" = "refuse",
): string {
  const resolved = path.resolve(dir, name);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new ProjectError("Invalid file path", "invalid");
  }
  if (hiddenSegments === "allow") return resolved;
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
export async function listFiles(dir: string, subpath = ""): Promise<FileEntry[]> {
  const target = resolveInProject(dir, subpath);
  // A LISTING target is a directory, so unlike a read the leaf gets no pass:
  // `?path=.chats` is exactly how every transcript filename was enumerable.
  const leaf = relSegments(dir, target).at(-1);
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
  dir: string,
  name: string,
  hiddenSegments: "refuse" | "allow" = "refuse",
): Promise<string> {
  return fs.readFile(resolveInProject(dir, name, hiddenSegments), "utf8");
}

/**
 * Read a file's raw bytes + its MIME type (issue #61), for the binary/image
 * endpoint. Path-traversal guarded; throws ProjectError("not_found") if the
 * file is missing so the route can 404 cleanly. NOT decoded as text, so binary
 * (image) bytes survive intact. See {@link resolveInProject} for `hiddenSegments`.
 */
export async function readFileBytes(
  dir: string,
  name: string,
  hiddenSegments: "refuse" | "allow" = "refuse",
): Promise<{ bytes: Buffer; mime: string }> {
  const resolved = resolveInProject(dir, name, hiddenSegments);
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
 * traversal guarded; throws ProjectError("not_found") when missing. See
 * {@link resolveInProject} for `hiddenSegments`.
 */
export async function readFileWithKind(
  dir: string,
  name: string,
  hiddenSegments: "refuse" | "allow" = "refuse",
): Promise<{ name: string; kind: FileKind; content: string }> {
  const kind = fileKind(name);
  if (kind === "image") {
    // Existence check only — the bytes go over the raw endpoint.
    try {
      await fs.stat(resolveInProject(dir, name, hiddenSegments));
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
    content = await readProjectFile(dir, name, hiddenSegments);
  } catch (err) {
    if (err instanceof ProjectError) throw err; // traversal -> "invalid"
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectError(`File not found: ${name}`, "not_found");
    }
    throw err;
  }
  return { name, kind, content };
}
