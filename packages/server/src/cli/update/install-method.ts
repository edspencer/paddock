/**
 * How was this copy installed? (CLI contract SPEC §6.)
 *
 * `update` cannot sensibly run `npm install -g` on a checkout, inside a
 * container, or out of npx's cache — so before it touches anything it works out
 * which of the ten layouts it is living in, and either picks the matching
 * package manager or prints the one command that WOULD work and exits 5.
 *
 * ## Generic on purpose
 *
 * Nothing in this file knows about Paddock. The product arrives as data — the
 * package name, the environment prefix, the entry script — and every call that
 * touches the world (spawning `npm root -g`, reading a manifest, resolving a
 * symlink) is injected. That is what lets the §6 table be tested against
 * fabricated directory layouts for all ten rows on one machine, and it is what
 * wave C4 lifts into `reference/install-method.ts` unchanged.
 *
 * Node built-ins only.
 */
import fsDefault from "node:fs";
import path from "node:path";

/** The ten rows of SPEC §6's table, in its order. Matches `schemas/update-check.schema.json`. */
export type InstallMethod =
  | "docker"
  | "managed"
  | "npx"
  | "checkout"
  | "npm-global"
  | "pnpm-global"
  | "bun-global"
  | "volta"
  | "yarn-global"
  | "dependency";

/** The package managers that can replace an install in place. */
export type PackageManager = "npm" | "pnpm" | "bun" | "volta";

export interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: "utf8"): string;
  realpathSync(p: string): string;
}

export interface DetectInput {
  /** The published package's name, e.g. `@edspencer/paddock`. */
  packageName: string;
  /** The environment prefix: `PADDOCK` gives `PADDOCK_IN_DOCKER` and `PADDOCK_UPDATE_HINT`. */
  envPrefix: string;
  /**
   * The script to walk up from — `process.argv[1]`, or this module's own file.
   *
   * SPEC §6 says `realpath(process.argv[1])`. Realpathing is done HERE rather
   * than asked of the caller, because npm installs a `bin` as a symlink and the
   * whole table is about where the package really sits (args.ts has the long
   * version of why that distinction has bitten this CLI before).
   */
  entry: string;
  env: NodeJS.ProcessEnv;
  /**
   * `npm root -g`, asked of the `npm` next to `process.execPath` (SPEC §6).
   *
   * Injected because it spawns a process: a unit test of the table must not
   * depend on what the machine running it happens to have installed globally.
   * Returning undefined (no npm, or it failed) is a normal answer — the row
   * simply does not match.
   */
  npmGlobalRoot?: () => string | undefined;
  fs?: FsLike;
}

export interface InstallInfo {
  method: InstallMethod;
  /**
   * The folder whose `package.json` names {@link DetectInput.packageName}, or —
   * when no ancestor does — the nearest folder with a `package.json` at all.
   *
   * The fallback is what makes a checkout detectable. Paddock's repo publishes
   * a SYNTHESIZED package (`scripts/make-npm-package.mjs`), so in the checkout
   * no manifest is called `@edspencer/paddock`: the root one is `paddock` and
   * the workspace one is `@paddock/server`. A strict search would find nothing
   * and have nothing to say; the nearest root finds `packages/server` and the
   * "not under node_modules" test then correctly reports a checkout.
   */
  packageRoot: string | undefined;
  /** True when the name was actually found, rather than fallen back to. */
  named: boolean;
  /** Can `update` install a new version itself, or must it print a command and exit 5? */
  canUpdate: boolean;
  /** The package manager to install with, when it can. */
  manager?: PackageManager;
  /** `<TOOL>_UPDATE_HINT`, when the environment set one. */
  hint?: string;
}

/** `PADDOCK` → `PADDOCK_IN_DOCKER`. */
export const inDockerVar = (prefix: string): string => `${prefix}_IN_DOCKER`;
/** `PADDOCK` → `PADDOCK_UPDATE_HINT`. */
export const updateHintVar = (prefix: string): string => `${prefix}_UPDATE_HINT`;

/**
 * Walk up from `entry` looking for the package root.
 *
 * Returns the first ancestor whose `package.json` has our name, and the nearest
 * ancestor with any `package.json` as a fallback — see
 * {@link InstallInfo.packageRoot}.
 */
export function findPackageRoot(
  entry: string,
  packageName: string,
  fs: FsLike,
): { root: string | undefined; named: boolean } {
  let dir = path.dirname(realpathOr(entry, fs));
  let nearest: string | undefined;
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      nearest ??= dir;
      try {
        const raw = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown };
        if (raw.name === packageName) return { root: dir, named: true };
      } catch {
        // An unreadable or malformed manifest is not our package. Keep walking:
        // a broken `package.json` in some intermediate directory must not stop
        // the search before it reaches the real root.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { root: nearest, named: false };
    dir = parent;
  }
}

function realpathOr(p: string, fs: FsLike): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Is `p` inside a `node_modules` directory?
 *
 * Split on the separator rather than matched as a substring, so a project
 * genuinely called `my-node_modules` is not mistaken for one (and so Windows
 * paths work, since `path.sep` is what split them). SPEC §6's "checkout or npm
 * link" row is exactly the negation of this.
 */
export function underNodeModules(p: string): boolean {
  return p.split(/[/\\]/).includes("node_modules");
}

/**
 * The npx / pnpm dlx / bunx / yarn dlx caches (SPEC §6).
 *
 * `_npx` and `bunx-` are matched between separators for the reason above.
 * `dlx` has to be looser — pnpm's is `~/.local/share/pnpm/store/.../dlx/<hash>`
 * and yarn's is `$TMPDIR/xfs-<hash>/dlx-<n>` — so a path SEGMENT that is `dlx`
 * or starts `dlx-` counts.
 */
export function isEphemeralCachePath(p: string): boolean {
  const parts = p.split(/[/\\]/);
  return parts.some(
    (seg) => seg === "_npx" || seg === "dlx" || seg.startsWith("dlx-") || seg.startsWith("bunx-"),
  );
}

/** A path segment-aware "does this path contain this run of segments". */
function hasSegments(p: string, segments: readonly string[]): boolean {
  const parts = p.split(/[/\\]/);
  for (let i = 0; i + segments.length <= parts.length; i++) {
    if (segments.every((s, j) => parts[i + j] === s)) return true;
  }
  return false;
}

/**
 * Which of SPEC §6's rows this install is, checked in the table's own order.
 *
 * The order is the contract, and two pairs of rows genuinely overlap:
 *
 * - **Docker beats managed.** A container that an Ansible role also labelled
 *   has both variables set, and the honest answer is "this is an image" — but
 *   the hint is still carried on {@link InstallInfo.hint} and
 *   {@link updateCommand} prefers it, because a hint is a sentence an operator
 *   deliberately wrote and our guess at a `docker compose` line is not.
 * - **Checkout beats every global.** They cannot both be true (every global
 *   layout is under a `node_modules`), so the order between them never decides
 *   anything; it is kept as the table has it so the two can be read side by
 *   side.
 */
export function detectInstall(input: DetectInput): InstallInfo {
  const fs = input.fs ?? fsDefault;
  const env = input.env;
  const { root, named } = findPackageRoot(input.entry, input.packageName, fs);
  const hint = env[updateHintVar(input.envPrefix)];
  const base = {
    packageRoot: root,
    named,
    ...(hint !== undefined && hint !== "" ? { hint } : {}),
  };

  // 1. Docker. The tool's own Dockerfile sets this; `/.dockerenv` is NOT used,
  //    because dev containers have it too and a global npm install inside one
  //    is a legitimate thing to update (SPEC §6).
  if (env[inDockerVar(input.envPrefix)] === "1") {
    return { ...base, method: "docker", canUpdate: false };
  }

  // 2. Managed: something outside owns this install and said so.
  if (base.hint !== undefined) return { ...base, method: "managed", canUpdate: false };

  // The rows below are all about WHERE the package sits, so with no package
  // root there is nothing to say. Treat it as a checkout: it is the row whose
  // advice ("you are running from source") is least wrong when we cannot tell,
  // and it refuses to install rather than guessing a package manager.
  if (root === undefined) return { ...base, method: "checkout", canUpdate: false };

  // 3. npx and friends: a hash-keyed cache that gets pruned.
  if (isEphemeralCachePath(root)) return { ...base, method: "npx", canUpdate: false };

  // 4. A checkout or an `npm link`: not under a node_modules at all.
  if (!underNodeModules(root)) return { ...base, method: "checkout", canUpdate: false };

  // 5. Global npm: the package root IS `<npm root -g>/<name>`.
  const globalRoot = (input.npmGlobalRoot ?? (() => undefined))();
  if (globalRoot !== undefined && samePath(root, path.join(globalRoot, input.packageName), fs)) {
    return { ...base, method: "npm-global", canUpdate: true, manager: "npm" };
  }

  // 6–9. The other global layouts, each identified by a marker in its path.
  if (hasSegments(root, ["pnpm", "global"])) {
    return { ...base, method: "pnpm-global", canUpdate: true, manager: "pnpm" };
  }
  if (hasSegments(root, [".bun", "install", "global"])) {
    return { ...base, method: "bun-global", canUpdate: true, manager: "bun" };
  }
  if (hasSegments(root, [".volta", "tools", "image", "packages"])) {
    return { ...base, method: "volta", canUpdate: true, manager: "volta" };
  }
  // Yarn classic's global folder. `canUpdate: false`: `yarn global add` works,
  // but classic is unmaintained and berry has no equivalent, so SPEC §6 prints
  // the command rather than running it.
  if (hasSegments(root, ["yarn", "global", "node_modules"])) {
    return { ...base, method: "yarn-global", canUpdate: false };
  }

  // 10. Under somebody else's node_modules: a dependency of a project.
  return { ...base, method: "dependency", canUpdate: false };
}

function samePath(a: string, b: string, fs: FsLike): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  // A global root is routinely reached through a symlink (`/usr/local/lib` →
  // `/opt/homebrew/lib`, nvm's per-version dirs), so compare realpaths too.
  return realpathOr(a, fs) === realpathOr(b, fs);
}

export interface CommandInput {
  packageName: string;
  /** The version to install, when one has been resolved. */
  target?: string;
  /** The container image to pull, for the Docker row: `ghcr.io/edspencer/paddock`. */
  image?: string;
  /** Prefix the npm command with `sudo` — SPEC §5 step 5's not-writable case. */
  sudo?: boolean;
  /** The command that brings a checkout up to date. */
  checkoutCommand?: string;
}

/**
 * The one command to print (SPEC §3, §6): what the reader should run instead.
 *
 * Returns the command and, where it helps, the parenthetical the spec's example
 * carries (`(the global folder isn't writable)`). An install that CAN update
 * itself gets `<tool> update`, which is the line the update notice prints.
 */
export function updateCommand(
  info: InstallInfo,
  input: CommandInput,
): { command: string; note?: string } {
  const spec = input.target !== undefined ? `${input.packageName}@${input.target}` : input.packageName;
  switch (info.method) {
    case "docker": {
      // A hint beats our guess: see detectInstall's note.
      if (info.hint !== undefined) return { command: info.hint };
      const tag = input.target !== undefined ? `:${input.target}` : "";
      return {
        command: "docker compose pull && docker compose up -d",
        ...(input.image !== undefined ? { note: `image ${input.image}${tag}` } : {}),
      };
    }
    case "managed":
      return { command: info.hint ?? "ask whoever manages this install" };
    case "npx":
      return {
        command: `npx ${input.packageName}@latest`,
        note: "npx already runs the latest version each time",
      };
    case "checkout":
      return {
        command: input.checkoutCommand ?? "git pull && npm install && npm run build",
        note: "this is a checkout",
      };
    case "npm-global":
      return {
        command: `${input.sudo === true ? "sudo " : ""}npm install -g ${spec}`,
        ...(input.sudo === true ? { note: "the global folder isn't writable" } : {}),
      };
    case "pnpm-global":
      return { command: `pnpm add -g ${spec}` };
    case "bun-global":
      return { command: `bun add -g ${spec}` };
    case "volta":
      return { command: `volta install ${spec}` };
    case "yarn-global":
      return { command: `yarn global add ${spec}` };
    case "dependency":
      return {
        command: `npm install ${spec}`,
        note: `run it in the project that depends on ${input.packageName}${
          info.packageRoot !== undefined ? ` (${projectOf(info.packageRoot)})` : ""
        }`,
      };
  }
}

/** The project a dependency install belongs to: the directory above its `node_modules`. */
function projectOf(packageRoot: string): string {
  const parts = packageRoot.split(path.sep);
  const i = parts.lastIndexOf("node_modules");
  return i <= 0 ? packageRoot : parts.slice(0, i).join(path.sep);
}

/** One line a person can act on, for every row of the table. */
export function describeInstall(info: InstallInfo, packageName: string): string {
  switch (info.method) {
    case "docker":
      return "running from a container image";
    case "managed":
      return "managed by something outside this machine's package manager";
    case "npx":
      return "running from an npx / dlx cache";
    case "checkout":
      return info.packageRoot !== undefined
        ? `running from a checkout at ${info.packageRoot}`
        : "running from a checkout";
    case "npm-global":
      return "installed globally with npm";
    case "pnpm-global":
      return "installed globally with pnpm";
    case "bun-global":
      return "installed globally with bun";
    case "volta":
      return "installed with volta";
    case "yarn-global":
      return "installed globally with yarn (classic)";
    case "dependency":
      return `installed as a dependency of another project (${packageName})`;
  }
}
