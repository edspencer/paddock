/**
 * Running the package manager (CLI contract SPEC §5 steps 8 and 10, §6, §7).
 *
 * Three jobs, all of them small and all of them easy to get subtly wrong:
 *
 * - **Find npm.** SPEC §6 and §10 both say the `npm` next to
 *   `process.execPath`, not whatever is on PATH. Under nvm, fnm or volta those
 *   are routinely different npms belonging to different Nodes, and asking the
 *   wrong one `npm root -g` gets a global folder this install is not in — which
 *   would report a perfectly ordinary global install as a `dependency` and
 *   refuse to update it.
 * - **No shell.** `spawnSync(npm, args)` with the default `shell: false`, so a
 *   package name or a path with a space in it cannot become two arguments.
 *   Windows is the exception and has to be: `npm` there is `npm.cmd`, which
 *   Node refuses to spawn without a shell since its fix for CVE-2024-27980
 *   (SPEC §7). That path quotes its arguments itself.
 * - **Can we write there?** SPEC §5 step 5. Asked before anything is stopped,
 *   and answered by actually creating a file rather than by `access()` alone —
 *   see {@link isWritable}.
 *
 * Generic: wave C4 lifts this into `reference/`. Node built-ins only.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PackageManager } from "./install-method.js";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command; never throws for a non-zero exit. Injected everywhere, for tests. */
export type Spawn = (
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; shell?: boolean; timeoutMs?: number },
) => RunResult;

export const spawnSyncRunner: Spawn = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.shell === true ? { shell: true } : {}),
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * The npm that belongs to the Node running us.
 *
 * `<dirname(execPath)>/npm` on POSIX; on Windows the sibling is `npm.cmd`.
 * Falls back to the bare name — if the sibling is not there (a distro that
 * splits node and npm into separate packages), PATH is the only answer left and
 * is better than failing.
 */
export function npmBeside(execPath: string = process.execPath, platform = process.platform): string {
  const dir = path.dirname(execPath);
  const candidate = path.join(dir, platform === "win32" ? "npm.cmd" : "npm");
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* fall through */
  }
  return platform === "win32" ? "npm.cmd" : "npm";
}

export interface NpmContext {
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
}

/** Run npm with no shell (except on Windows, where `npm.cmd` needs one). */
export function runNpm(args: string[], ctx: NpmContext = {}): RunResult {
  const platform = ctx.platform ?? process.platform;
  const cmd = npmBeside(ctx.execPath ?? process.execPath, platform);
  const run = ctx.spawn ?? spawnSyncRunner;
  return run(cmd, args, {
    ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    // The ONE place a shell is used, and only where Node leaves no choice. The
    // arguments passed through here are package specs and npm flags we build
    // ourselves, never user text.
    ...(platform === "win32" ? { shell: true } : {}),
    timeoutMs: 15 * 60 * 1000,
  });
}

/** `npm root -g`, or undefined when npm could not answer. */
export function npmGlobalRoot(ctx: NpmContext = {}): string | undefined {
  const r = runNpm(["root", "-g"], ctx);
  if (r.status !== 0) return undefined;
  const out = r.stdout.trim().split("\n").at(-1)?.trim();
  return out !== undefined && out !== "" ? out : undefined;
}

/** `npm config get <key>`, or undefined. Used to resolve the registry (SPEC §5 step 3). */
export function npmConfigGet(key: string, ctx: NpmContext = {}): string | undefined {
  const r = runNpm(["config", "get", key], ctx);
  if (r.status !== 0) return undefined;
  const out = r.stdout.trim().split("\n").at(-1)?.trim();
  return out !== undefined && out !== "" && out !== "undefined" && out !== "null" ? out : undefined;
}

/**
 * Really writable? (SPEC §5 step 5.)
 *
 * `access(W_OK)` alone is not enough and the difference is the whole point of
 * this check. It consults the mode bits, which say yes for root and say
 * nothing about a read-only mount, an immutable flag, or an ACL — the usual
 * shapes of "npm install -g needs sudo". So the directory is probed by
 * CREATING something in it and removing it again, which is the same syscall
 * npm is about to make.
 *
 * A missing directory walks up to its nearest existing parent: npm would create
 * it, and whether it can is the parent's question.
 */
export function isWritable(dir: string): boolean {
  let probe = dir;
  for (;;) {
    if (fs.existsSync(probe)) break;
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  try {
    fs.accessSync(probe, fs.constants.W_OK);
  } catch {
    return false;
  }
  try {
    const tmp = fs.mkdtempSync(path.join(probe, ".update-probe-"));
    fs.rmSync(tmp, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a package manager would put the package, so {@link isWritable} has a
 * directory to ask about.
 *
 * Only npm can be asked properly (`npm root -g`). For the others the install
 * command's own target is a good enough proxy — and if it is wrong, the install
 * fails with that manager's own message and the rollback runs, which is a worse
 * experience than the sudo hint but not a worse outcome.
 */
export function globalRootFor(
  manager: PackageManager,
  ctx: NpmContext = {},
): string | undefined {
  if (manager === "npm") return npmGlobalRoot(ctx);
  return undefined;
}

export interface InstallInput {
  manager: PackageManager;
  packageName: string;
  version: string;
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
}

/** The argv for a global install, per SPEC §6's last column. */
export function installArgs(manager: PackageManager, spec: string): { cmd: string; args: string[] } {
  switch (manager) {
    case "npm":
      // `--no-audit --no-fund` keeps the output to the point; `--global` is
      // spelled out rather than `-g` so a log of what ran reads plainly.
      return { cmd: "npm", args: ["install", "--global", "--no-audit", "--no-fund", spec] };
    case "pnpm":
      return { cmd: "pnpm", args: ["add", "-g", spec] };
    case "bun":
      return { cmd: "bun", args: ["add", "-g", spec] };
    case "volta":
      return { cmd: "volta", args: ["install", spec] };
  }
}

/**
 * Install `<name>@<version>` with the manager this install came from.
 *
 * npm goes through {@link runNpm}, so it is the npm beside this Node. The other
 * three are looked up on PATH, which is the only place they are: pnpm, bun and
 * volta are not installed beside node.
 */
export function installPackage(o: InstallInput): RunResult {
  const spec = `${o.packageName}@${o.version}`;
  const { cmd, args } = installArgs(o.manager, spec);
  if (o.manager === "npm") {
    return runNpm(args, {
      ...(o.spawn !== undefined ? { spawn: o.spawn } : {}),
      ...(o.env !== undefined ? { env: o.env } : {}),
      ...(o.execPath !== undefined ? { execPath: o.execPath } : {}),
      ...(o.platform !== undefined ? { platform: o.platform } : {}),
    });
  }
  const run = o.spawn ?? spawnSyncRunner;
  return run(cmd, args, {
    ...(o.env !== undefined ? { env: o.env } : {}),
    ...((o.platform ?? process.platform) === "win32" ? { shell: true } : {}),
    timeoutMs: 15 * 60 * 1000,
  });
}

/**
 * `npm cache add <name>@<version>` — fetch before stopping anything
 * (SPEC §5 step 8).
 *
 * Both the target and the CURRENT version are cached, and caching the current
 * one is the half that is easy to leave out and expensive to miss: it is what
 * gives the rollback a package to reinstall when the reason the update failed
 * was the network. Done while the old version is still serving, so a failure
 * here costs nothing but a message.
 *
 * `npm cache add` is used whatever the manager is, because every one of these
 * layouts has an npm available (it ships with Node) and the point is only to
 * have the tarball on the machine. A failure is reported and not fatal — the
 * install below may still succeed from the network.
 */
export function cacheAdd(
  packageName: string,
  version: string,
  ctx: NpmContext = {},
): RunResult {
  return runNpm(["cache", "add", `${packageName}@${version}`], ctx);
}

/**
 * Ask a CLI what version it is, by running it (`node <cli> --version`).
 *
 * This is how `update` proves that the install actually replaced the files
 * before it hands over to the new CLI. The alternative — reading the
 * `package.json` next to it — answers a different question: npm writes the
 * manifest and the files in one operation, but a partially-updated global
 * folder, a stale symlink, or a pnpm layout whose versioned realpath moved all
 * show up here and not there.
 */
export function cliVersion(
  cliPath: string,
  ctx: NpmContext = {},
): string | undefined {
  const run = ctx.spawn ?? spawnSyncRunner;
  const r = run(ctx.execPath ?? process.execPath, [cliPath, "--version"], {
    ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    timeoutMs: 60_000,
  });
  if (r.status !== 0) return undefined;
  const line = r.stdout.trim().split("\n")[0]?.trim();
  return line !== undefined && /^\d+\.\d+\.\d+/.test(line) ? line : undefined;
}

/** A throwaway directory, for callers that need one (the writability probe's sibling). */
export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
