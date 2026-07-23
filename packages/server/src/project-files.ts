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
import { ProjectError } from "./project-paths.js";
import { fileKind, contentTypeFor } from "./project-mime.js";
import type { FileEntry, FileKind } from "./project-types.js";

/** The per-slug project directory under the projects root. */
function dirFor(root: string, slug: string): string {
  return path.join(root, slug);
}

/**
 * Resolve a freeform file name to an absolute path inside the project dir,
 * rejecting path traversal. The single guard shared by every file read (and by
 * the directory listing, issue #259). The project root itself (`name === ""`)
 * resolves to the project dir and is allowed, so a root listing passes through.
 */
export function resolveInProject(root: string, slug: string, name: string): string {
  const dir = dirFor(root, slug);
  const resolved = path.resolve(dir, name);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new ProjectError("Invalid file path", "invalid");
  }
  return resolved;
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
