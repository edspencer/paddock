/**
 * Merge-aware `.gitignore` maintenance for the instance data repo.
 *
 * Paddock keeps agent working state OUT of the repo it manages, and does it by
 * appending ignore rules rather than owning the file: an existing `.gitignore`
 * keeps every line it has and only the missing entries are appended. Nothing is
 * ever rewritten or removed, so a hand-maintained file is safe.
 *
 * Two call sites:
 *  - {@link ensureGitignoreEntries} — the primitive, used by `ProjectStore` for a
 *    project's sidecar rules (the nested repo-backed checkout + `/.chats/`,
 *    issue #187).
 *  - {@link ensureRootGitignore} — the instance-root rules (issue #512). The
 *    root/scratch agent's cwd is now `projectsRoot` itself, i.e. the backing
 *    repo's working tree, so whatever a root chat's tooling drops in its cwd
 *    lands at the repo root.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const GITIGNORE_FILE = ".gitignore";

/**
 * Ensure `<dir>/.gitignore` contains each of `entries`.
 *
 * Idempotent and append-only: a file that already covers everything is left
 * byte-identical; an existing file keeps its content and gains only the missing
 * lines; an absent file is created with `header` above the entries.
 */
export async function ensureGitignoreEntries(
  dir: string,
  entries: string[],
  header: string,
): Promise<void> {
  const file = path.join(dir, GITIGNORE_FILE);
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    /* no .gitignore yet — write a fresh one below */
  }
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = entries.filter((l) => !have.has(l));
  if (existing && missing.length === 0) return; // already covers everything
  if (!existing) {
    await fs.writeFile(file, [header, ...entries, ""].join("\n"), "utf8");
    return;
  }
  // Append only the missing lines to the existing file (preserve user content).
  const body = existing.endsWith("\n") ? existing : `${existing}\n`;
  await fs.writeFile(file, `${body}${missing.join("\n")}\n`, "utf8");
}

/**
 * Ignore rules that belong at the ROOT of the instance data repo (issue #512).
 *
 * `/.chats/` is defensive: the root agent's transcripts normally live in
 * `<scratchDir>/.chats/`, outside the repo entirely, but an instance that points
 * `PADDOCK_SCRATCH_DIR` at `projectsRoot` would put them here.
 * `/.playwright-mcp/` is the browser MCP's artifact dir, which it writes into
 * the agent's cwd — the repo root, for a root chat.
 *
 * Both are anchored (`/`-prefixed) so they only match at the repo root and do
 * not shadow a project's own sidecar rules one level down.
 */
const ROOT_ENTRIES = ["/.chats/", "/.playwright-mcp/"];

const ROOT_HEADER =
  "# Paddock: root-chat working state (issue #512) — the instance root agent's\n" +
  "# cwd IS this repo, so its transcript/tooling dirs land here. Not tracked.";

/**
 * Ensure the backing repo at `projectsRoot` ignores the root agent's working
 * state. No-ops when `projectsRoot` is not a git repo, so a non-git instance
 * never gets a stray `.gitignore`. Never throws — the repo belongs to the
 * operator and a missing ignore rule must not block boot.
 */
export async function ensureRootGitignore(projectsRoot: string): Promise<void> {
  try {
    // `.git` is a dir for a normal clone and a FILE for a worktree/submodule —
    // lstat, and accept either.
    const isRepo = await fs
      .lstat(path.join(projectsRoot, ".git"))
      .then(() => true)
      .catch(() => false);
    if (!isRepo) return;
    await ensureGitignoreEntries(projectsRoot, ROOT_ENTRIES, ROOT_HEADER);
  } catch {
    /* non-fatal */
  }
}
