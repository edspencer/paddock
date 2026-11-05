/**
 * The PATH a generated unit gives the service (SPEC §7).
 *
 * From edspencer/cli-contract — Local Review's `server/service/spec.ts`
 * (`PER_SHELL_PATTERNS`, `SYSTEM_DIRS`, `servicePath`, `which`) @ spec 0.1;
 * local changes: Paddock's own doc comments, `node:path`'s platform-aware
 * `delimiter`/`join` instead of hard-coded `:` and `path.posix`, and a
 * `missingFromPath` helper the CLI uses for its unit warnings. Wave C4 moves
 * this to `reference/service/` and re-syncs.
 *
 * ## Why a unit cannot just inherit the installing shell's PATH
 *
 * Paddock used to record `process.env.PATH` verbatim. That is the PATH of one
 * terminal at one moment, and several of its entries are *per-session*:
 *
 * - **fnm** puts a symlink per terminal under `fnm_multishells/<pid>_<ts>/bin`.
 *   The directory is deleted when that shell exits — and fnm never cleans up
 *   the stale ones, so a unit installed from an fnm shell names a `node`
 *   directory that stops existing the moment the tab closes.
 * - **npx** adds its own per-invocation cache; `npm run` adds `node-gyp-bin`
 *   and the package's `node_modules/.bin`. A long-lived background job has no
 *   business looking in any of them for `git`.
 *
 * So the job's PATH is rebuilt: Node's own bin directory first (so the `node`
 * the unit runs can resolve its neighbours), then whatever of the installing
 * shell's PATH is worth keeping, then the system directories. Entries that are
 * relative, per-shell, or simply not there are dropped — a PATH naming
 * directories that do not exist is how `git` goes missing at some later login,
 * silently, with the symptom appearing in an agent's turn rather than at
 * install time.
 */
import fs from "node:fs";
import path from "node:path";

/** PATH entries that belong to one shell session or one npm invocation. */
export const PER_SHELL_PATTERNS: readonly RegExp[] = [
  /[/\\]fnm_multishells[/\\]/, // fnm: a symlink per terminal, never cleaned up
  /[/\\]_npx[/\\]/, // npx's per-invocation package cache
  /[/\\]node-gyp-bin$/, // added by `npm run` for the script it is running
  /[/\\]node_modules[/\\]\.bin$/, // likewise (and by npx): a package's tools, not the user's
];

/** Where the usual tools live, after the inherited PATH. Only existing ones are kept. */
export const SYSTEM_DIRS: readonly string[] = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Kept on the job's PATH: non-empty, absolute, not per-shell, and an existing directory. */
function keep(dir: string, exists: (p: string) => boolean): boolean {
  if (dir === "" || !path.isAbsolute(dir)) return false;
  if (PER_SHELL_PATTERNS.some((re) => re.test(dir) || re.test(`${dir}${path.sep}`))) return false;
  return exists(dir);
}

export interface ServicePathOptions {
  /** Injected for tests: "is this an existing directory?". */
  exists?: (p: string) => boolean;
  /** Injected for tests: the system directories to append. */
  systemDirs?: readonly string[];
}

/**
 * The job's PATH: Node's bin directory, then the usable part of `inherited`,
 * then the system directories. De-duplicated, order preserved.
 */
export function servicePath(
  nodeBin: string,
  inherited: string | undefined,
  opts: ServicePathOptions = {},
): string {
  const exists = opts.exists ?? isDir;
  const system = opts.systemDirs ?? SYSTEM_DIRS;
  const out: string[] = [];
  const add = (d: string): void => {
    // Trailing separators would make `/usr/bin/` and `/usr/bin` two entries.
    const clean = d.length > 1 ? d.replace(/[/\\]+$/, "") : d;
    if (!out.includes(clean) && keep(clean, exists)) out.push(clean);
  };
  add(nodeBin);
  for (const d of (inherited ?? "").split(path.delimiter)) add(d);
  for (const d of system) add(d);
  return out.join(path.delimiter);
}

/** `which`: the first executable called `name` on `pathVar`, or undefined. */
export function which(
  name: string,
  pathVar: string,
  isExec: (p: string) => boolean = isExecutableFile,
): string | undefined {
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir === "") continue;
    const p = path.join(dir, name);
    if (isExec(p)) return p;
  }
  return undefined;
}

/**
 * Of `paths`, those that are no longer on disk.
 *
 * This is the check behind `status`'s and (from wave G) `doctor`'s "the Node it
 * runs has gone" warning. It happens under nvm, fnm and volta the moment a Node
 * version is uninstalled: the unit still names an absolute interpreter path,
 * the supervisor still dutifully tries to exec it, and the failure arrives as
 * Paddock being absent with nothing in its own logs — because it never ran.
 */
export function missingPaths(
  paths: readonly (string | undefined)[],
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string[] {
  return paths.filter((p): p is string => p !== undefined && p !== "" && !exists(p));
}
