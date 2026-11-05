// From edspencer/cli-contract reference/service/path-env.ts @ 0.2; local changes: `.ts` import specifiers → `.js`.
// The PATH a unit gives the service (SPEC §7): Node's own bin folder first, then the installing shell's PATH without
// its per-shell entries, then the system folders. Only folders that exist are kept. Node built-ins only.
//
// A unit can't just record the shell's PATH: fnm puts a folder per terminal (`fnm_multishells/<pid>_<ts>/bin`) on it
// that goes when the terminal closes, and npx and `npm run` add their own. A unit naming those loses `node` or `git`
// at some later login, with the symptom showing up far from the cause.

import fs from 'node:fs';
import path from 'node:path';

/** Entries that belong to one shell or one npm run. */
export const PER_SHELL_PATTERNS: readonly RegExp[] = [
  /[/\\]fnm_multishells[/\\]/, // fnm: a folder per terminal, never cleaned up
  /[/\\]_npx[/\\]/, // npx's cache
  /[/\\]node-gyp-bin$/, // added by `npm run`
  /[/\\]node_modules[/\\]\.bin$/, // a package's own tools, added by `npm run` and npx
];

/** Where the usual tools live, after the inherited PATH. Only the ones that exist are kept. */
export const SYSTEM_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

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

export interface ServicePathOptions {
  /** Injected for tests: is this an existing folder? */
  exists?: (p: string) => boolean;
  /** Injected for tests: the system folders to add. */
  systemDirs?: readonly string[];
}

/** Node's bin folder, then what's worth keeping of `inherited`, then the system folders; no duplicates. */
export function servicePath(nodeBin: string, inherited: string | undefined, opts: ServicePathOptions = {}): string {
  const exists = opts.exists ?? isDir;
  const out: string[] = [];
  const add = (d: string): void => {
    const clean = d.length > 1 ? d.replace(/[/\\]+$/, '') : d;
    if (clean === '' || !path.isAbsolute(clean) || out.includes(clean)) return;
    if (PER_SHELL_PATTERNS.some((re) => re.test(clean) || re.test(`${clean}${path.sep}`))) return;
    if (exists(clean)) out.push(clean);
  };
  add(nodeBin);
  for (const d of (inherited ?? '').split(path.delimiter)) add(d);
  for (const d of opts.systemDirs ?? SYSTEM_DIRS) add(d);
  return out.join(path.delimiter);
}

/** The first executable called `name` on `pathVar`. */
export function which(name: string, pathVar: string, isExec: (p: string) => boolean = isExecutableFile): string | undefined {
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir !== '' && isExec(path.join(dir, name))) return path.join(dir, name);
  }
  return undefined;
}

/** Those of `paths` that aren't on disk any more: `status` and `doctor` warn about a unit's Node that has gone. */
export function missingPaths(paths: readonly (string | undefined)[], exists: (p: string) => boolean = (p) => fs.existsSync(p)): string[] {
  return paths.filter((p): p is string => p !== undefined && p !== '' && !exists(p));
}
