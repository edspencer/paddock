/**
 * `paddock update` — the CLI contract's §5 sequence and §6 table
 * (edspencer/cli-contract SPEC 0.1, rollout task C2).
 *
 * ## What is proven here, and what is not
 *
 * Everything in `src/cli/update/` is written as pure logic over injected hooks,
 * so the whole of §5 can be driven here without a registry, a package manager
 * or a service: each test supplies the four hooks and asserts the exit code and
 * what was printed. §6's ten rows are asserted against fabricated paths, which
 * is the only way one machine can see all ten.
 *
 * What these CANNOT prove is that the real sequence works end to end — that a
 * real `npm install -g` really replaces the files, that the new CLI really
 * refreshes a real unit, and that a health check against a real server really
 * sees the new version. That is `test/integration/update-registry.test.ts`
 * (a local registry serving two real packed builds) and
 * `scripts/service-real.mjs` on GitHub's launchd and systemd runners.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "../../src/cli/exit-codes.js";
import { createOutput } from "../../src/cli/output.js";
import { parseArgs, parseCommand, UsageError, UPDATE_USAGE } from "../../src/cli/args.js";
import {
  detectInstall,
  describeInstall,
  findPackageRoot,
  isEphemeralCachePath,
  underNodeModules,
  updateCommand,
  type InstallInfo,
} from "../../src/cli/update/install-method.js";
import {
  compareVersions,
  isNewer,
  isPrerelease,
  maxVersion,
  parseVersion,
  satisfies,
  satisfiesEngines,
} from "../../src/cli/update/semver.js";
import {
  acquireLock,
  LockHeldError,
  lockPath,
  readLock,
  releaseLock,
} from "../../src/cli/update/lock.js";
import {
  readUpdateCheck,
  updateCheckPath,
  updateNotice,
  updateSummary,
  writeUpdateCheck,
  type UpdateCheck,
} from "../../src/cli/update/update-check.js";
import {
  registryUrl,
  resolveRegistry,
  resolveTarget,
  RegistryError,
} from "../../src/cli/update/registry.js";
import { installArgs, npmBeside } from "../../src/cli/update/package-manager.js";
import { runService } from "../../src/cli/service/index.js";
import type { Runner } from "../../src/cli/service/backend.js";
import {
  runUpdate,
  type HealthVerdict,
  type ServiceSnapshot,
  type UpdateProduct,
} from "../../src/cli/update/update.js";

// ---------------------------------------------------------------------------
// A throwaway home for every test that writes one
// ---------------------------------------------------------------------------

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-update-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Capture everything a command writes, per STREAM — the `--json` discipline is about streams. */
function streams(): {
  stdout: { write(c: string): void; isTTY?: boolean };
  stderr: { write(c: string): void; isTTY?: boolean };
  out(): string;
  err(): string;
} {
  const o: string[] = [];
  const e: string[] = [];
  return {
    stdout: { write: (c: string) => void o.push(c) },
    stderr: { write: (c: string) => void e.push(c) },
    out: () => o.join(""),
    err: () => e.join(""),
  };
}

// ---------------------------------------------------------------------------
// SPEC §6: how it was installed — the whole table, against fake layouts
// ---------------------------------------------------------------------------

describe("SPEC §6: the install-method table", () => {
  const NAME = "@edspencer/paddock";
  const SUB = path.join("packages", "server", "dist", "cli", "paddock.js");

  /**
   * A fake filesystem holding one `package.json` at `root` naming `NAME`.
   *
   * The whole §6 table is about paths, so the only thing that has to be real is
   * the shape of the tree — and fabricating it means all ten rows, including
   * the four this box could never have installed, are asserted on one machine.
   */
  function fakeFs(root: string, name = NAME) {
    const manifest = path.join(root, "package.json");
    return {
      existsSync: (p: string) => p === manifest,
      readFileSync: () => JSON.stringify({ name }),
      realpathSync: (p: string) => p,
    };
  }

  function detect(root: string, extra: Record<string, string | undefined> = {}, globalRoot?: string) {
    return detectInstall({
      packageName: NAME,
      envPrefix: "PADDOCK",
      entry: path.join(root, SUB),
      env: extra as NodeJS.ProcessEnv,
      ...(globalRoot !== undefined ? { npmGlobalRoot: () => globalRoot } : {}),
      fs: fakeFs(root),
    });
  }

  it("row 1 — Docker, from the tool's own variable and never /.dockerenv", () => {
    const info = detect("/app", { PADDOCK_IN_DOCKER: "1" });
    expect(info.method).toBe("docker");
    expect(info.canUpdate).toBe(false);
    // The image-pull command, with the target as the tag (SPEC §3).
    expect(
      updateCommand(info, { packageName: NAME, target: "0.82.0", image: "ghcr.io/edspencer/paddock" }),
    ).toEqual({
      command: "docker compose pull && docker compose up -d",
      note: "image ghcr.io/edspencer/paddock:0.82.0",
    });
  });

  it("row 2 — managed, from <TOOL>_UPDATE_HINT, printed verbatim", () => {
    const info = detect("/opt/paddock/node_modules/@edspencer/paddock", {
      PADDOCK_UPDATE_HINT: "ansible-playbook paddock.yml",
    });
    expect(info.method).toBe("managed");
    expect(info.canUpdate).toBe(false);
    expect(updateCommand(info, { packageName: NAME, target: "0.82.0" }).command).toBe(
      "ansible-playbook paddock.yml",
    );
  });

  /**
   * Docker is row 1, so it wins — but the hint still decides the COMMAND.
   *
   * A container an Ansible role also manages has both variables, and the honest
   * method is "this is an image". The hint is a sentence somebody deliberately
   * wrote, though, and our `docker compose` line is a guess about a file we
   * have never seen, so printing the guess over the instruction would be the
   * one combination that helps nobody.
   */
  it("Docker beats managed, and the hint still supplies the command", () => {
    const info = detect("/app", {
      PADDOCK_IN_DOCKER: "1",
      PADDOCK_UPDATE_HINT: "kubectl set image deploy/paddock paddock=ghcr.io/edspencer/paddock:0.82.0",
    });
    expect(info.method).toBe("docker");
    expect(updateCommand(info, { packageName: NAME, target: "0.82.0" }).command).toMatch(
      /^kubectl set image/,
    );
  });

  it("row 3 — the npx, pnpm dlx, bunx and yarn dlx caches", () => {
    for (const root of [
      "/home/ed/.npm/_npx/9f1b/node_modules/@edspencer/paddock",
      "/home/ed/.local/share/pnpm/store/v3/dlx/4ab2/node_modules/@edspencer/paddock",
      "/tmp/bunx-501-paddock/node_modules/@edspencer/paddock",
      "/tmp/xfs-1a2b/dlx-7/node_modules/@edspencer/paddock",
    ]) {
      const info = detect(root);
      expect(info.method, root).toBe("npx");
      expect(info.canUpdate).toBe(false);
    }
    expect(updateCommand(detect("/home/ed/.npm/_npx/9f/node_modules/x"), { packageName: NAME }).command).toBe(
      `npx ${NAME}@latest`,
    );
  });

  /** A project genuinely called `_npx-tools` is not an npx cache. */
  it("matches cache markers between separators, not as substrings", () => {
    expect(isEphemeralCachePath("/srv/_npx-tools/node_modules/x")).toBe(false);
    expect(isEphemeralCachePath("/srv/_npx/x")).toBe(true);
    expect(underNodeModules("/srv/my-node_modules/x")).toBe(false);
    expect(underNodeModules("/srv/node_modules/x")).toBe(true);
  });

  it("row 4 — a checkout or an npm link: not under a node_modules at all", () => {
    const info = detect("/data/projects/paddock");
    expect(info.method).toBe("checkout");
    expect(info.canUpdate).toBe(false);
    expect(updateCommand(info, { packageName: NAME }).command).toBe(
      "git pull && npm install && npm run build",
    );
  });

  it("row 5 — a global npm install, asked of npm rather than guessed", () => {
    const root = "/usr/local/lib/node_modules/@edspencer/paddock";
    const info = detect(root, {}, "/usr/local/lib/node_modules");
    expect(info.method).toBe("npm-global");
    expect(info.canUpdate).toBe(true);
    expect(info.manager).toBe("npm");
    expect(updateCommand(info, { packageName: NAME, target: "0.82.0" }).command).toBe(
      `npm install -g ${NAME}@0.82.0`,
    );
  });

  /** SPEC §5 step 5: the same command with `sudo`, printed and never run. */
  it("the not-writable case prints the sudo command and says why", () => {
    const info = detect("/usr/local/lib/node_modules/@edspencer/paddock", {}, "/usr/local/lib/node_modules");
    expect(updateCommand(info, { packageName: NAME, target: "0.82.0", sudo: true })).toEqual({
      command: `sudo npm install -g ${NAME}@0.82.0`,
      note: "the global folder isn't writable",
    });
  });

  it("rows 6 to 9 — pnpm, bun, volta and yarn classic", () => {
    const cases: [string, InstallInfo["method"], boolean, string][] = [
      [
        "/home/ed/Library/pnpm/global/5/node_modules/@edspencer/paddock",
        "pnpm-global",
        true,
        `pnpm add -g ${NAME}@0.82.0`,
      ],
      [
        "/home/ed/.bun/install/global/node_modules/@edspencer/paddock",
        "bun-global",
        true,
        `bun add -g ${NAME}@0.82.0`,
      ],
      [
        "/home/ed/.volta/tools/image/packages/@edspencer/paddock/lib/node_modules/@edspencer/paddock",
        "volta",
        true,
        `volta install ${NAME}@0.82.0`,
      ],
      [
        "/usr/local/share/.config/yarn/global/node_modules/@edspencer/paddock",
        "yarn-global",
        false,
        `yarn global add ${NAME}@0.82.0`,
      ],
    ];
    for (const [root, method, canUpdate, command] of cases) {
      const info = detect(root);
      expect(info.method, root).toBe(method);
      expect(info.canUpdate, root).toBe(canUpdate);
      expect(updateCommand(info, { packageName: NAME, target: "0.82.0" }).command).toBe(command);
    }
  });

  it("row 10 — a dependency of somebody else's project, which names the project", () => {
    const info = detect("/srv/app/node_modules/@edspencer/paddock", {}, "/usr/local/lib/node_modules");
    expect(info.method).toBe("dependency");
    expect(info.canUpdate).toBe(false);
    expect(updateCommand(info, { packageName: NAME, target: "0.82.0" }).note).toContain("/srv/app");
  });

  /**
   * Paddock's own repo is the awkward case, and it has to come out as a
   * checkout.
   *
   * The published package is SYNTHESIZED (`scripts/make-npm-package.mjs`), so
   * in the checkout the root manifest is `paddock` and the workspace one is
   * `@paddock/server` — nothing is called `@edspencer/paddock`. A strict search
   * for the name finds nothing, and the fallback to the nearest package root is
   * what lets the "not under node_modules" test fire.
   */
  it("finds no NAMED root in the repo, and reports a checkout anyway", () => {
    const repo = "/data/projects/paddock";
    const found = findPackageRoot(path.join(repo, SUB), NAME, {
      existsSync: (p: string) =>
        p === path.join(repo, "package.json") ||
        p === path.join(repo, "packages", "server", "package.json"),
      readFileSync: (p: string) =>
        JSON.stringify({ name: p.includes("packages") ? "@paddock/server" : "paddock" }),
      realpathSync: (p: string) => p,
    });
    expect(found.named).toBe(false);
    expect(found.root).toBe(path.join(repo, "packages", "server"));
  });

  /** A malformed intermediate manifest must not stop the walk before the real root. */
  it("walks past an unreadable package.json", () => {
    const root = "/usr/local/lib/node_modules/@edspencer/paddock";
    const broken = path.join(root, "packages", "server", "package.json");
    const good = path.join(root, "package.json");
    const found = findPackageRoot(path.join(root, SUB), NAME, {
      existsSync: (p: string) => p === broken || p === good,
      readFileSync: (p: string) => (p === broken ? "{not json" : JSON.stringify({ name: NAME })),
      realpathSync: (p: string) => p,
    });
    expect(found).toEqual({ root, named: true });
  });

  it("every row has a line a person can read", () => {
    for (const method of [
      "docker",
      "managed",
      "npx",
      "checkout",
      "npm-global",
      "pnpm-global",
      "bun-global",
      "volta",
      "yarn-global",
      "dependency",
    ] as const) {
      const line = describeInstall(
        { method, packageRoot: "/x", named: true, canUpdate: false },
        NAME,
      );
      expect(line.length, method).toBeGreaterThan(5);
    }
  });
});

// ---------------------------------------------------------------------------
// The small semver (SPEC §5 step 4)
// ---------------------------------------------------------------------------

describe("the small semver", () => {
  it("parses and compares releases", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion("1.2")).toBeUndefined();
    expect(compareVersions("0.81.0", "0.80.0")).toBe(1);
    expect(compareVersions("0.80.0", "0.81.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(maxVersion(["0.1.0", "nonsense", "0.2.0"])).toBe("0.2.0");
  });

  /** The half that is easy to get wrong, and the half `--to next` depends on. */
  it("orders prereleases below their release, and numerically within", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.1.1")).toBe(-1);
    // A numeric identifier sorts below an alphanumeric one.
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(isPrerelease("0.82.0-rc.1")).toBe(true);
    expect(isPrerelease("0.82.0")).toBe(false);
  });

  it("reads the engines ranges that actually appear", () => {
    const yes: [string, string][] = [
      ["22.11.0", ">=22"],
      ["22.11.0", ">=22.0.0"],
      ["24.0.0", ">=22"],
      ["22.1.0", "^22.1.0"],
      ["22.1.9", "~22.1"],
      ["22.0.0", "22"],
      ["22.5.1", "22.x"],
      ["22.0.0", ">=20 <23"],
      ["20.1.0", "20 || 22"],
      ["22.0.0", "*"],
    ];
    for (const [v, r] of yes) expect(satisfies(v, r), `${v} in ${r}`).toBe(true);
    const no: [string, string][] = [
      ["20.11.0", ">=22"],
      ["23.0.0", ">=20 <23"],
      ["22.2.0", "~22.1"],
      ["21.0.0", "20 || 22"],
      ["23.0.0", "^22.1.0"],
    ];
    for (const [v, r] of no) expect(satisfies(v, r), `${v} in ${r}`).toBe(false);
  });

  /**
   * A range this file cannot read must NOT block an update.
   *
   * The cost of the two mistakes is wildly asymmetric: refusing wrongly leaves
   * a tool that cannot update itself and says something nobody can act on,
   * while allowing wrongly produces the failure `engines` would have produced
   * anyway — with step 13's rollback behind it.
   */
  it("says `cannot tell` rather than `fails` for a range it does not understand", () => {
    expect(satisfies("22.0.0", "1.2 - 2.3")).toBeUndefined();
    expect(satisfiesEngines("22.0.0", { node: "1.2 - 2.3" })).toEqual({
      ok: undefined,
      range: "1.2 - 2.3",
    });
    // No engines at all is a pass, not an unknown.
    expect(satisfiesEngines("22.0.0", undefined)).toEqual({ ok: true, range: undefined });
    expect(satisfiesEngines("20.0.0", { node: ">=22" })).toEqual({ ok: false, range: ">=22" });
  });
});

// ---------------------------------------------------------------------------
// The lock (SPEC §5 step 1)
// ---------------------------------------------------------------------------

describe("SPEC §5 step 1: the update lock", () => {
  it("creates it with O_EXCL holding the pid, and releases it", () => {
    const lock = acquireLock({ home, pid: 4242, command: "paddock update" });
    expect(lock.path).toBe(lockPath(home));
    expect(readLock(lock.path)).toMatchObject({ pid: 4242, command: "paddock update" });
    // 0600: a lock is not interesting, but the home it sits in holds things
    // that are, and one mode for the directory's files is easier to hold.
    expect(fs.statSync(lock.path).mode & 0o777).toBe(0o600);
    lock.release();
    expect(fs.existsSync(lock.path)).toBe(false);
  });

  it("refuses when a LIVE process holds it", () => {
    acquireLock({ home, pid: 111, isAlive: () => true });
    let thrown: unknown;
    try {
      acquireLock({ home, pid: 222, isAlive: () => true });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockHeldError);
    expect((thrown as LockHeldError).holder.pid).toBe(111);
    expect((thrown as Error).message).toContain("pid 111");
    // And it says how to get past it, because the one thing a person in this
    // position needs is permission to delete a file they have never seen.
    expect((thrown as Error).message).toContain(lockPath(home));
  });

  it("removes a STALE lock and takes it", () => {
    acquireLock({ home, pid: 111, isAlive: () => false });
    const second = acquireLock({ home, pid: 222, isAlive: () => false });
    expect(readLock(second.path)?.pid).toBe(222);
  });

  /** A half-written or foreign lock file counts as stale: nobody can prove it is held. */
  it("treats an unreadable lock as stale", () => {
    fs.writeFileSync(lockPath(home), "{half");
    const lock = acquireLock({ home, pid: 9, isAlive: () => true });
    expect(readLock(lock.path)?.pid).toBe(9);
  });

  it("release never removes somebody else's lock", () => {
    acquireLock({ home, pid: 111, isAlive: () => false });
    releaseLock(lockPath(home), 222);
    expect(fs.existsSync(lockPath(home))).toBe(true);
    releaseLock(lockPath(home), 111);
    expect(fs.existsSync(lockPath(home))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The cache and the notice (SPEC §3)
// ---------------------------------------------------------------------------

const CHECK: UpdateCheck = {
  name: "@edspencer/paddock",
  current: "0.81.0",
  target: "0.82.0",
  tag: "latest",
  updateAvailable: true,
  installMethod: "npm-global",
  canUpdate: true,
  command: "paddock update",
  engines: ">=22",
  nodeOk: true,
  changelog: "https://github.com/edspencer/paddock/releases/tag/v0.82.0",
  checkedAt: new Date().toISOString(),
};

describe("SPEC §3: the update-check cache and the notice", () => {
  it("round-trips, and is the document `service status` reads", () => {
    writeUpdateCheck(home, CHECK);
    expect(readUpdateCheck(home)).toEqual(CHECK);
    expect(updateSummary(home)).toEqual({
      latest: "0.82.0",
      updateAvailable: true,
      checkedAt: CHECK.checkedAt,
    });
    expect(fs.statSync(updateCheckPath(home)).mode & 0o777).toBe(0o600);
  });

  /**
   * A months-old file must not have `status` advertising a version that has
   * since been superseded twice. `status` has deliberately not asked the
   * registry, so the only thing it can do about an old answer is stop
   * repeating it.
   */
  it("stops repeating an answer that is too old", () => {
    writeUpdateCheck(home, { ...CHECK, checkedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    expect(updateSummary(home)).toBeUndefined();
    expect(readUpdateCheck(home)).not.toBeNull();
  });

  it("ignores a cache that is not one", () => {
    fs.writeFileSync(updateCheckPath(home), JSON.stringify({ hello: true }));
    expect(readUpdateCheck(home)).toBeNull();
    expect(updateSummary(home)).toBeUndefined();
    fs.writeFileSync(updateCheckPath(home), "{half");
    expect(readUpdateCheck(home)).toBeNull();
  });

  it("writes the notice in SPEC §3's shape", () => {
    expect(
      updateNotice({
        name: "Paddock",
        current: "0.79.1",
        target: "0.80.0",
        command: "paddock update",
        changelog: "https://github.com/edspencer/paddock/releases/tag/v0.80.0",
      }),
    ).toBe(
      "Paddock 0.80.0 is available (you have 0.79.1).\n" +
        "  Run: paddock update\n" +
        "  Changes: https://github.com/edspencer/paddock/releases/tag/v0.80.0",
    );
    // And the per-install variant, with the parenthetical the spec shows.
    expect(
      updateNotice({
        name: "Paddock",
        current: "0.79.1",
        target: "0.80.0",
        command: "sudo npm install -g @edspencer/paddock@0.80.0",
        note: "the global folder isn't writable",
      }),
    ).toContain("  Run: sudo npm install -g @edspencer/paddock@0.80.0    (the global folder isn't writable)");
  });
});

// ---------------------------------------------------------------------------
// The registry (SPEC §5 step 3)
// ---------------------------------------------------------------------------

describe("SPEC §5 step 3: the registry", () => {
  it("writes a scoped name's slash as %2f", () => {
    expect(registryUrl("https://registry.npmjs.org/", "-", "package", "@edspencer/paddock", "dist-tags")).toBe(
      "https://registry.npmjs.org/-/package/@edspencer%2fpaddock/dist-tags",
    );
    expect(registryUrl("http://127.0.0.1:1/", "@edspencer/paddock", "0.81.0")).toBe(
      "http://127.0.0.1:1/@edspencer%2fpaddock/0.81.0",
    );
  });

  it("prefers npm_config_registry, then npm config, then the public one", () => {
    expect(resolveRegistry({ npm_config_registry: "http://127.0.0.1:9/" })).toBe("http://127.0.0.1:9/");
    expect(resolveRegistry({}, () => "https://nexus.internal/")).toBe("https://nexus.internal/");
    expect(resolveRegistry({}, () => "undefined")).toBe("https://registry.npmjs.org");
    expect(resolveRegistry({})).toBe("https://registry.npmjs.org");
  });

  /** A dist-tag and a version are told apart by SHAPE, never by asking. */
  it("resolves --to as a version or as a tag", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("dist-tags")) {
        return json({ latest: "0.81.0", next: "0.82.0-rc.1" });
      }
      return json({ name: "@x/y", version: String(url).split("/").at(-1), engines: { node: ">=22" } });
    }) as unknown as typeof fetch;
    const base = { packageName: "@x/y", registry: "http://r", fetch: fakeFetch };

    expect(await resolveTarget(base)).toEqual({ version: "0.81.0", tag: "latest", engines: ">=22" });
    expect(await resolveTarget({ ...base, to: "next" })).toEqual({
      version: "0.82.0-rc.1",
      tag: "next",
      engines: ">=22",
    });
    // A version is taken literally, and the dist-tags are not even fetched.
    calls.length = 0;
    expect(await resolveTarget({ ...base, to: "v0.79.1" })).toEqual({
      version: "0.79.1",
      tag: null,
      engines: ">=22",
    });
    expect(calls.some((c) => c.includes("dist-tags"))).toBe(false);
  });

  it("names the tags it does have when --to misses", async () => {
    const fakeFetch = (async () => json({ latest: "1.0.0", beta: "1.1.0-beta.1" })) as unknown as typeof fetch;
    await expect(
      resolveTarget({ packageName: "@x/y", registry: "http://r", to: "nightly", fetch: fakeFetch }),
    ).rejects.toThrow(/no dist-tag `nightly`.*beta, latest/s);
  });

  it("turns a 404, a non-JSON body and a timeout into one reportable error", async () => {
    const cases: [typeof fetch, RegExp][] = [
      [(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch, /no such package/],
      [(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch, /not JSON/],
      [
        (async () => {
          const e = new Error("timed out");
          e.name = "TimeoutError";
          throw e;
        }) as unknown as typeof fetch,
        /no answer within 10 seconds/,
      ],
    ];
    for (const [fetchImpl, pattern] of cases) {
      const err = await resolveTarget({ packageName: "@x/y", registry: "http://r", fetch: fetchImpl }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RegistryError);
      expect((err as Error).message).toMatch(pattern);
    }
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// The package manager (SPEC §5 steps 8, 10; §6; §7)
// ---------------------------------------------------------------------------

describe("the package manager", () => {
  it("installs with the manager this install came from (SPEC §6)", () => {
    expect(installArgs("npm", "@x/y@1.0.0")).toEqual({
      cmd: "npm",
      args: ["install", "--global", "--no-audit", "--no-fund", "@x/y@1.0.0"],
    });
    expect(installArgs("pnpm", "@x/y@1.0.0")).toEqual({ cmd: "pnpm", args: ["add", "-g", "@x/y@1.0.0"] });
    expect(installArgs("bun", "@x/y@1.0.0")).toEqual({ cmd: "bun", args: ["add", "-g", "@x/y@1.0.0"] });
    expect(installArgs("volta", "@x/y@1.0.0")).toEqual({ cmd: "volta", args: ["install", "@x/y@1.0.0"] });
  });

  /**
   * The npm BESIDE this Node, not whatever is on PATH (SPEC §6, §10).
   *
   * Under nvm, fnm or volta those are routinely different npms belonging to
   * different Nodes, and asking the wrong one `npm root -g` gets a global
   * folder this install is not in — which reports an ordinary global install as
   * a `dependency` and refuses to update it.
   */
  it("finds the npm beside this Node, and falls back to PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-npm-"));
    try {
      fs.writeFileSync(path.join(dir, "npm"), "#!/bin/sh\n");
      expect(npmBeside(path.join(dir, "node"), "linux")).toBe(path.join(dir, "npm"));
      expect(npmBeside(path.join(dir, "missing", "node"), "linux")).toBe("npm");
      expect(npmBeside(path.join(dir, "missing", "node.exe"), "win32")).toBe("npm.cmd");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC §1: the command surface
// ---------------------------------------------------------------------------

describe("SPEC §1: `update`'s flags", () => {
  it("parses the verb, and accepts `upgrade` as a hidden alias", () => {
    expect(parseCommand(["update"]).verb).toBe("update");
    expect(parseCommand(["upgrade"]).verb).toBe("update");
    // Hidden: required to work, deliberately absent from the help, so there is
    // one name in the documentation and two that work.
    expect(UPDATE_USAGE).not.toContain("upgrade");
  });

  it("parses --check, --to, --yes, --force and --json", () => {
    const o = parseArgs(["--check", "--to", "0.79.1", "--yes", "--force", "--json"]);
    expect(o).toMatchObject({ checkOnly: true, to: "0.79.1", yes: true, force: true, json: true });
    expect(parseArgs(["-y"]).yes).toBe(true);
  });

  it("rejects a --to with no value, and one that is a flag", () => {
    for (const argv of [["update", "--to"], ["update", "--to", "--yes"]]) {
      expect(() => parseCommand(argv)).toThrow(UsageError);
    }
  });

  /** The scoped-flag table: a flag the command cannot act on is exit 2, not a no-op. */
  it("keeps --check, --to, --yes and --refresh on the commands they mean something on", () => {
    const rejected: [string[], RegExp][] = [
      [["serve", "--check"], /--check applies to `update` only/],
      [["service", "status", "--check"], /--check applies to `update` only/],
      [["update", "--refresh"], /--refresh applies to `service install` only/],
      [["service", "status", "--refresh"], /--refresh applies to `service install` only/],
      [["busy", "--yes"], /--yes applies to `update` only/],
      [["serve", "--to", "0.1.0"], /--to applies to `update` only/],
    ];
    for (const [argv, pattern] of rejected) {
      let thrown: unknown;
      try {
        parseCommand(argv);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, argv.join(" ")).toBeInstanceOf(UsageError);
      expect((thrown as UsageError).exitCode).toBe(EXIT.usage);
      expect((thrown as Error).message).toMatch(pattern);
    }
    // The controls: each flag parses where it belongs, and --help always wins.
    expect(parseCommand(["update", "--check"]).opts.checkOnly).toBe(true);
    expect(parseCommand(["service", "install", "--refresh"]).opts.refresh).toBe(true);
    expect(parseCommand(["serve", "--check", "--help"]).opts.help).toBe(true);
  });

  it("documents every exit code it can return", () => {
    for (const code of ["0", "1", "2", "5", "6", "7", "75"]) {
      expect(UPDATE_USAGE, code).toMatch(new RegExp(`^\\s+${code}\\s`, "m"));
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC §5: the sequence, driven through the injected hooks
// ---------------------------------------------------------------------------

/** A recording of everything the sequence did to the world. */
interface Rig {
  product: UpdateProduct;
  env: Parameters<typeof runUpdate>[2];
  calls: string[];
  out: () => string;
  err: () => string;
  /** Change what the next `installPackage` returns. */
  installFails: boolean;
  refreshFails: boolean;
  /** What the health probe will say, per call. */
  health: HealthVerdict[];
  service: ServiceSnapshot;
}

const NPM_GLOBAL = "/fake/lib/node_modules";

/**
 * A complete `update` rig: a package installed globally with npm, a registry
 * answering 0.82.0, a service installed and running 0.81.0.
 *
 * Every hook records what it was asked, so a test can assert the ORDER as well
 * as the outcome — and the order is the part of §5 that matters most (the busy
 * check before the stop, the fetch before the stop, the stop before the
 * install).
 */
function rig(over: Partial<{ latest: string; current: string; engines: string | null }> = {}): Rig {
  const calls: string[] = [];
  const s = streams();
  const latest = over.latest ?? "0.82.0";
  const current = over.current ?? "0.81.0";
  const engines = over.engines === undefined ? ">=22" : over.engines;

  const state: Rig = {
    calls,
    out: s.out,
    err: s.err,
    installFails: false,
    refreshFails: false,
    health: [{ state: "ok", version: latest }],
    service: { installed: true, running: true, url: "http://127.0.0.1:7233", log: "/fake/service.log" },
  } as Rig;

  const ok = { status: 0, stdout: "", stderr: "" };
  state.product = {
    name: "Paddock",
    tool: "paddock",
    packageName: "@edspencer/paddock",
    envPrefix: "PADDOCK",
    home,
    currentVersion: current,
    entry: path.join(NPM_GLOBAL, "@edspencer/paddock", "packages/server/dist/cli/paddock.js"),
    binSubpath: path.join("packages", "server", "dist", "cli", "paddock.js"),
    image: "ghcr.io/edspencer/paddock",
    changelogUrl: (v) => `https://github.com/edspencer/paddock/releases/tag/v${v}`,
    healthTimeoutMs: 50,
    guardBusy: async ({ force }) => {
      calls.push(`busy(force=${String(force)})`);
      return null;
    },
    service: {
      inspect: () => state.service,
      stop: () => void calls.push("stop"),
      refresh: (cli) => {
        // Labelled by the package the CLI lives in, so the assertion reads as
        // "the NEW install's CLI refreshed the unit" rather than as a path.
        calls.push(`refresh(${path.basename(path.dirname(path.dirname(path.dirname(cli))))})`);
        return state.refreshFails ? { status: 1, stdout: "", stderr: "refresh failed" } : ok;
      },
      tail: () => "boot line 1\nboot line 2",
    },
    waitForVersion: async ({ version }) => {
      calls.push(`health(${version})`);
      return state.health.shift() ?? { state: "no-answer" };
    },
  };

  state.env = {
    out: createOutput({ tool: "paddock", stdout: s.stdout, stderr: s.stderr, env: {}, json: false }),
    env: { npm_config_registry: "http://registry.test" },
    isTTY: false,
    nodeVersion: "22.11.0",
    writable: () => true,
    // Only the package ROOT has a manifest naming us, which is the real
    // layout: a `package.json` beside the CLI would make §6's walk-up stop at
    // `dist/cli` and read the install as a dependency of itself.
    fs: {
      existsSync: (p: string) =>
        p === path.join(NPM_GLOBAL, "@edspencer/paddock", "package.json") ||
        String(p).endsWith("paddock.js"),
      readFileSync: () => JSON.stringify({ name: "@edspencer/paddock" }),
      realpathSync: (p: string) => String(p),
    } as Rig["env"]["fs"],
    fetch: (async (url: string) => {
      const u = String(url);
      if (u.includes("dist-tags")) return json({ latest });
      return json({ name: "@edspencer/paddock", version: u.split("/").at(-1), ...(engines !== null ? { engines: { node: engines } } : {}) });
    }) as unknown as typeof fetch,
    spawn: (cmd: string, args: string[]) => {
      const line = `${path.basename(cmd)} ${args.join(" ")}`;
      if (args[0] === "root") return { status: 0, stdout: `${NPM_GLOBAL}\n`, stderr: "" };
      if (args[0] === "config") return { status: 0, stdout: "http://registry.test\n", stderr: "" };
      if (args[1] === "--version") {
        // The CLI on disk reports whatever was last installed — which is how
        // `findCli` proves the install took.
        return { status: 0, stdout: `${state.installedOnDisk ?? current}\n`, stderr: "" };
      }
      calls.push(line);
      if (args[0] === "install" && args.includes("--global")) {
        if (state.installFails) return { status: 1, stdout: "", stderr: "ENOSPC" };
        state.installedOnDisk = args.at(-1)?.split("@").at(-1);
        return ok;
      }
      return ok;
    },
  } as Rig["env"];
  return state;
}

/** Extra state the rig carries between hooks. */
interface Rig {
  installedOnDisk?: string;
}

describe("SPEC §5: `update`, step by step", () => {
  it("up to date: says so and exits 0, and caches the answer", async () => {
    const r = rig({ latest: "0.81.0" });
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.ok);
    expect(r.out()).toContain("Paddock 0.81.0 is up to date.");
    expect(readUpdateCheck(home)).toMatchObject({ target: "0.81.0", updateAvailable: false });
    // Nothing was stopped or installed.
    expect(r.calls.filter((c) => c === "stop" || c.startsWith("npm install"))).toEqual([]);
    // And the lock is gone (SPEC §5 step 15).
    expect(fs.existsSync(lockPath(home))).toBe(false);
  });

  it("--check reports, changes nothing, and exits 0 whether or not there is an update", async () => {
    const r = rig();
    expect(await runUpdate(r.product, { check: true }, r.env)).toBe(EXIT.ok);
    expect(r.out()).toContain("Paddock 0.82.0 is available (you have 0.81.0).");
    expect(r.out()).toContain("Run: paddock update");
    expect(r.calls).toEqual([]);
    expect(readUpdateCheck(home)).toMatchObject({
      current: "0.81.0",
      target: "0.82.0",
      tag: "latest",
      updateAvailable: true,
      installMethod: "npm-global",
      canUpdate: true,
      nodeOk: true,
    });
  });

  it("--check --json puts exactly one document on stdout and the prose on stderr", async () => {
    const s = streams();
    const r = rig();
    r.env.out = createOutput({ tool: "paddock", stdout: s.stdout, stderr: s.stderr, env: {}, json: true });
    expect(await runUpdate(r.product, { check: true, json: true }, r.env)).toBe(EXIT.ok);
    const doc = JSON.parse(s.out()) as Record<string, unknown>;
    expect(doc).toMatchObject({ updateAvailable: true, target: "0.82.0", outcome: "available" });
    expect(s.err()).toContain("is available");
    expect(s.out().trimEnd().endsWith("}")).toBe(true);
  });

  /**
   * The whole happy path, and the ORDER is the assertion.
   *
   * Busy before the stop, both fetches before the stop, the stop before the
   * install, the refresh by the NEW CLI, and the health check for the TARGET
   * version. Each of those is a step whose being in the wrong place is a real
   * outage rather than an untidy log.
   */
  it("updates: busy, fetch both, stop, install, refresh, health — in that order", async () => {
    const r = rig();
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.ok);
    expect(r.calls).toEqual([
      "busy(force=false)",
      "npm cache add @edspencer/paddock@0.82.0",
      "npm cache add @edspencer/paddock@0.81.0",
      "stop",
      "npm install --global --no-audit --no-fund @edspencer/paddock@0.82.0",
      "refresh(server)",
      "health(0.82.0)",
    ]);
    expect(r.out()).toContain("Updated Paddock 0.81.0 → 0.82.0. Running at http://127.0.0.1:7233");
  });

  it("--force reaches the busy guard as force, and nothing else changes", async () => {
    const r = rig();
    await runUpdate(r.product, { yes: true, force: true }, r.env);
    expect(r.calls[0]).toBe("busy(force=true)");
    expect(r.calls).toContain("health(0.82.0)");
  });

  it("busy: exits 75 before anything is stopped", async () => {
    const r = rig();
    r.product.guardBusy = async () => {
      r.calls.push("busy");
      return EXIT.busy;
    };
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.busy);
    expect(r.calls).toEqual(["busy"]);
  });

  /** SPEC §3: without a TTY a command that would ask exits 2 and says so. */
  it("no TTY and no --yes: exit 2", async () => {
    const r = rig();
    const code = await runUpdate(r.product, {}, r.env);
    expect(code).toBe(EXIT.usage);
    expect(r.err()).toContain("`--yes` is required");
    expect(r.calls).toEqual(["busy(force=false)"]);
  });

  it("on a TTY it asks, and a no changes nothing", async () => {
    const r = rig();
    r.env.isTTY = true;
    const asked: string[] = [];
    r.env.confirm = async (q) => {
      asked.push(q);
      return false;
    };
    expect(await runUpdate(r.product, {}, r.env)).toBe(EXIT.ok);
    expect(asked).toHaveLength(1);
    expect(r.out()).toContain("Update Paddock 0.81.0 → 0.82.0? The service will restart.");
    expect(r.calls).toEqual(["busy(force=false)"]);
  });

  it("cannot self-update: prints the right command and exits 5", async () => {
    const r = rig();
    r.env.env = { ...r.env.env, PADDOCK_IN_DOCKER: "1" };
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.cannotSelfUpdate);
    expect(r.out()).toContain("Run: docker compose pull && docker compose up -d");
    expect(r.out()).toContain("image ghcr.io/edspencer/paddock:0.82.0");
    expect(r.calls).toEqual([]);
    // `--check` in the same install reports rather than refusing (SPEC §9).
    const c = rig();
    c.env.env = { ...c.env.env, PADDOCK_IN_DOCKER: "1" };
    expect(await runUpdate(c.product, { check: true }, c.env)).toBe(EXIT.ok);
    expect(readUpdateCheck(home)).toMatchObject({ installMethod: "docker", canUpdate: false });
  });

  it("not writable: prints the sudo command, never runs it, exits 5", async () => {
    const r = rig();
    r.env.writable = () => false;
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.cannotSelfUpdate);
    expect(r.out()).toContain("Run: sudo npm install -g @edspencer/paddock@0.82.0");
    expect(r.err()).toContain("is not writable by this user");
    // The refusal happens BEFORE the busy check, so nothing was asked and
    // nothing was stopped — and most importantly, no sudo was spawned.
    expect(r.calls.filter((c) => c.includes("sudo"))).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it("the target needs a newer Node: exit 1, naming the Node", async () => {
    const r = rig({ engines: ">=24" });
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.failure);
    expect(r.err()).toContain("0.82.0 needs Node >=24, and this is Node 22.11.0");
    expect(r.calls).toEqual([]);
  });

  it("a lower version needs --to, and --to gets it", async () => {
    const r = rig({ latest: "0.80.0" });
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.ok);
    expect(r.out()).toContain("is newer than the registry's latest (0.80.0). Nothing to do.");
    expect(r.calls).toEqual([]);

    const down = rig({ latest: "0.80.0" });
    expect(await runUpdate(down.product, { yes: true, to: "0.80.0" }, down.env)).toBe(EXIT.ok);
    expect(down.calls).toContain("npm install --global --no-audit --no-fund @edspencer/paddock@0.80.0");
    expect(down.out()).toContain("Updated Paddock 0.81.0 → 0.80.0");
  });

  /** A prerelease on `latest` is a mis-tag, and installing it silently is worse than nothing. */
  it("will not take a prerelease unless --to names it", async () => {
    const r = rig({ latest: "0.82.0-rc.1" });
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.ok);
    expect(r.out()).toContain("`latest` is a prerelease (0.82.0-rc.1)");
    expect(r.calls).toEqual([]);
    const to = rig({ latest: "0.82.0-rc.1" });
    expect(await runUpdate(to.product, { yes: true, to: "0.82.0-rc.1" }, to.env)).toBe(EXIT.ok);
    expect(to.calls).toContain("health(0.82.0-rc.1)");
  });

  /**
   * `process.ppid`, not an invented number: `runUpdate` uses the real liveness
   * check, so a lock naming a dead pid is correctly STALE and would be taken —
   * which would make this test pass for the opposite reason to the one
   * intended.
   */
  it("two updates cannot interleave: the second exits 1", async () => {
    acquireLock({ home, pid: process.ppid });
    const r = rig();
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.failure);
    expect(r.err()).toContain(`another update is already running (pid ${String(process.ppid)}`);
    expect(r.calls).toEqual([]);
  });

  // --- the failure half (SPEC §5 steps 10, 12, 13) -------------------------

  it("a failed install: npm has already restored it, so start again and exit 6", async () => {
    const r = rig();
    r.installFails = true;
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.rolledBack);
    expect(r.err()).toContain("installing 0.82.0 failed");
    expect(r.err()).toContain("0.82.0 didn't start; 0.81.0 is running again.");
    // No second install: npm put the old package back itself.
    expect(r.calls.filter((c) => c.startsWith("npm install"))).toHaveLength(1);
    // The unit was refreshed by the OLD CLI, and the OLD version was checked.
    expect(r.calls).toContain("health(0.81.0)");
  });

  /**
   * The failure the brief singles out: the target installs, and does not come
   * up. SPEC §5 step 13 — print the log, reinstall the old version, refresh the
   * unit with the OLD CLI, and exit 6 once the old version answers.
   */
  it("a target that fails its health check rolls back and exits 6", async () => {
    const r = rig();
    r.health = [{ state: "no-answer" }, { state: "ok", version: "0.81.0" }];
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.rolledBack);
    expect(r.err()).toContain("did not answer within");
    // The last 20 log lines, as the spec asks (SPEC §5 step 13).
    expect(r.err()).toContain("boot line 2");
    expect(r.calls).toEqual([
      "busy(force=false)",
      "npm cache add @edspencer/paddock@0.82.0",
      "npm cache add @edspencer/paddock@0.81.0",
      "stop",
      "npm install --global --no-audit --no-fund @edspencer/paddock@0.82.0",
      "refresh(server)",
      "health(0.82.0)",
      "npm install --global --no-audit --no-fund @edspencer/paddock@0.81.0",
      "refresh(server)",
      "health(0.81.0)",
    ]);
    expect(r.err()).toContain("0.82.0 didn't start; 0.81.0 is running again.");
  });

  /** "Something answers" is not the test — the VERSION is (SPEC §5 step 12). */
  it("a wrong version answering is a failure, not a success", async () => {
    const r = rig();
    r.health = [{ state: "wrong-version", version: "0.81.0" }, { state: "ok", version: "0.81.0" }];
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.rolledBack);
    expect(r.err()).toContain("answers with 0.81.0, not 0.82.0");
  });

  /**
   * 7 rather than 6, and the difference is the whole value of the code: 6 means
   * nobody has to do anything, 7 means the machine is not serving and the
   * output has to be the commands to type.
   */
  it("a rollback that cannot be restored exits 7 with the commands to run", async () => {
    const r = rig();
    r.health = [{ state: "no-answer" }, { state: "no-answer" }];
    const code = await runUpdate(r.product, { yes: true }, r.env);
    expect(code).toBe(EXIT.needsHuman);
    expect(r.err()).toContain("is not answering at http://127.0.0.1:7233 either");
    expect(r.err()).toContain("npm install --global --no-audit --no-fund @edspencer/paddock@0.81.0");
    expect(r.err()).toContain("paddock service install --refresh");
  });

  it("a refresh that fails rolls back too", async () => {
    const r = rig();
    r.refreshFails = true;
    r.health = [{ state: "ok", version: "0.81.0" }];
    // The old CLI's refresh fails too, so this is the 7 case — which is right:
    // the unit is in an unknown state and a person has to look.
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.needsHuman);
    expect(r.err()).toContain("could not refresh the service unit");
  });

  // --- without a service (SPEC §5's last paragraph) -----------------------

  it("with no service it does steps 1–8 and 10, then says to restart", async () => {
    const r = rig();
    r.service = { installed: false, running: true, url: "http://127.0.0.1:7233" };
    r.env.out = createOutput({ tool: "paddock", stdout: r.env.out ? undefined : undefined, env: {} });
    const s = streams();
    r.env.out = createOutput({ tool: "paddock", stdout: s.stdout, stderr: s.stderr, env: {} });
    // Something is serving and there is no service to stop, so it refuses
    // rather than installing under a running server (SPEC §5 step 9).
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.notRunning);
    expect(s.err()).toContain("Stop it (Ctrl-C in its terminal)");

    // With nothing running, it installs and stops there: no stop, no refresh,
    // no health check, because there is no service to have any of those.
    const idle = rig();
    idle.service = { installed: false, running: false };
    idle.product.waitForVersion = async () => ({ state: "no-answer" });
    expect(await runUpdate(idle.product, { yes: true }, idle.env)).toBe(EXIT.ok);
    expect(idle.calls).toEqual([
      "busy(force=false)",
      "npm cache add @edspencer/paddock@0.82.0",
      "npm cache add @edspencer/paddock@0.81.0",
      "npm install --global --no-audit --no-fund @edspencer/paddock@0.82.0",
    ]);
    expect(idle.out()).toContain("Updated Paddock 0.81.0 → 0.82.0.");
  });

  /** The install did not take: no CLI on disk reports the target. Roll back. */
  it("an install that reports success but changed nothing rolls back", async () => {
    const r = rig();
    const realSpawn = r.env.spawn;
    r.env.spawn = (cmd, args, o) => {
      if (args[1] === "--version") return { status: 0, stdout: "0.81.0\n", stderr: "" };
      return realSpawn!(cmd, args, o);
    };
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.rolledBack);
    expect(r.err()).toContain("no CLI on disk reports that version");
  });

  it("a registry it cannot reach is a plain failure, before anything is touched", async () => {
    const r = rig();
    r.env.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.failure);
    expect(r.err()).toContain("could not reach the registry");
    expect(r.calls).toEqual([]);
    expect(fs.existsSync(lockPath(home))).toBe(false);
  });

  /** A fetch failure happens while the old version is still serving (SPEC §5 step 8). */
  it("a failed `npm cache add` of the target stops before the stop", async () => {
    const r = rig();
    const realSpawn = r.env.spawn;
    r.env.spawn = (cmd, args, o) => {
      if (args[0] === "cache" && String(args[2]).endsWith("0.82.0")) {
        r.calls.push("npm cache add @edspencer/paddock@0.82.0");
        return { status: 1, stdout: "", stderr: "404 Not Found" };
      }
      return realSpawn!(cmd, args, o);
    };
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.failure);
    expect(r.err()).toContain("could not fetch @edspencer/paddock@0.82.0");
    expect(r.calls).not.toContain("stop");
  });

  /** A rollback needs the OLD package locally; say so rather than find out later. */
  it("warns when the current version is not in the npm cache", async () => {
    const r = rig();
    const realSpawn = r.env.spawn;
    r.env.spawn = (cmd, args, o) => {
      if (args[0] === "cache" && String(args[2]).endsWith("0.81.0")) {
        r.calls.push("npm cache add @edspencer/paddock@0.81.0");
        return { status: 1, stdout: "", stderr: "no such version" };
      }
      return realSpawn!(cmd, args, o);
    };
    expect(await runUpdate(r.product, { yes: true }, r.env)).toBe(EXIT.ok);
    expect(r.err()).toContain("a rollback would need the network");
  });

  it("releases the lock whatever happens", async () => {
    for (const opts of [{ yes: true }, { check: true }, {}]) {
      const r = rig();
      await runUpdate(r.product, opts, r.env);
      expect(fs.existsSync(lockPath(home)), JSON.stringify(opts)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC §1 and §5 step 11: `service install --refresh`
// ---------------------------------------------------------------------------

describe("SPEC §5 step 11: `service install --refresh`", () => {
  const OPTS = { open: false, verbose: false, help: false, version: false };
  const ready = async (): Promise<"ready"> => "ready";

  /**
   * A runner that answers every launchctl/systemctl call, and records them.
   *
   * `loaded` makes it report the unit as ACTIVE. A fake that answered every
   * call with an empty stdout would have `is-active` read as "not active", so
   * `status` would exit 3 and the test would be asserting on the wrong state —
   * a nearby version of C1's trap, where a fake launchd that said 0 to
   * everything made an install test sit out the whole bootout poll and pass.
   */
  function recorder(loaded = false): { run: Runner; calls: string[][] } {
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "launchctl" && args[0] === "print" && !loaded) {
        return { status: 3, stdout: "", stderr: "Could not find service" };
      }
      if (cmd === "systemctl" && args[1] === "is-active") {
        return { status: loaded ? 0 : 3, stdout: loaded ? "active\n" : "inactive\n", stderr: "" };
      }
      if (cmd === "systemctl" && args[1] === "show") {
        return { status: 0, stdout: loaded ? "4242\n" : "0\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    return { run, calls };
  }

  function ctx(h: string, run: Runner, extra: Record<string, unknown> = {}) {
    return {
      platform: "linux" as NodeJS.Platform,
      nodePath: "/usr/bin/node",
      scriptPath: "/usr/local/lib/node_modules/@edspencer/paddock/packages/server/dist/cli/paddock.js",
      packageRoot: "/usr/local/lib/node_modules/@edspencer/paddock",
      homeDir: h,
      xdgConfigHome: path.join(h, ".config"),
      run,
      checkReady: ready,
      ...extra,
    };
  }

  async function capture(body: () => Promise<number>): Promise<{ out: string; code: number }> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      const code = await body();
      return { out: lines.join("\n"), code };
    } finally {
      console.log = original;
    }
  }

  /**
   * The point of the flag, and the failure it exists to prevent.
   *
   * `update` runs this through the NEW version's CLI, in a shell that never
   * typed `--port 9000` — so if the refresh rebuilt the spec from today's flags
   * and environment, every update would quietly move a non-default service back
   * onto 7233 and `~/.paddock`.
   */
  it("keeps the port, host, data dir and verbosity the existing unit records", async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-refresh-"));
    try {
      const first = recorder();
      await capture(() =>
        runService(
          "install",
          { ...OPTS, port: "9000", host: "0.0.0.0", dataDir: path.join(h, "alt"), verbose: true },
          ctx(h, first.run),
        ),
      );
      const unit = path.join(h, ".config", "systemd", "user", "paddock.service");
      const before = fs.readFileSync(unit, "utf8");
      expect(before).toContain("9000");

      // A refresh from a shell with a DIFFERENT data dir in its environment,
      // which is exactly the shell `update` runs in.
      const second = recorder(true);
      const refreshed = await capture(() =>
        runService("install", { ...OPTS, refresh: true }, ctx(h, second.run, {
          envDataDir: path.join(h, "somewhere-else"),
        })),
      );
      expect(refreshed.code).toBe(EXIT.ok);
      const after = fs.readFileSync(unit, "utf8");
      expect(after).toContain("--port 9000");
      expect(after).toContain("--host 0.0.0.0");
      expect(after).toContain(`--data-dir ${path.join(h, "alt")}`);
      expect(after).toContain("--verbose");
      expect(after).not.toContain("somewhere-else");
      expect(refreshed.out).toContain("Re-writing");
      expect(refreshed.out).toContain("Keeping: paddock serve --port 9000");
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  /** An explicit flag still wins: a refresh is not a freeze. */
  it("lets a flag override what the unit records", async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-refresh2-"));
    try {
      await capture(() => runService("install", { ...OPTS, port: "9000" }, ctx(h, recorder().run)));
      await capture(() =>
        runService("install", { ...OPTS, refresh: true, port: "9100" }, ctx(h, recorder(true).run)),
      );
      const unit = fs.readFileSync(path.join(h, ".config", "systemd", "user", "paddock.service"), "utf8");
      expect(unit).toContain("--port 9100");
      expect(unit).not.toContain("9000");
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  /**
   * Nothing to refresh is exit 4, not a first install.
   *
   * This is the one that would be silent: a `--refresh` on a machine with no
   * unit, run by an `update` nobody is watching, would otherwise install a
   * service with defaults and report success.
   */
  it("exits 4 with nothing installed, and writes nothing", async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-refresh3-"));
    try {
      const rec = recorder();
      const r = await capture(() => runService("install", { ...OPTS, refresh: true }, ctx(h, rec.run)));
      expect(r.code).toBe(EXIT.notInstalled);
      expect(r.out).toContain("not installed as a service");
      expect(fs.existsSync(path.join(h, ".config", "systemd", "user", "paddock.service"))).toBe(false);
      // And it did not start, enable or reload anything.
      expect(rec.calls.filter((c) => c[1] === "enable" || c[1] === "start")).toEqual([]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  /**
   * `service status` repeats the cache and never asks the registry (SPEC §3).
   *
   * The notice goes to stderr, so that stdout stays under one rule — the
   * `--json` document's — rather than two.
   */
  it("`service status` reads update-check.json, and never fetches", async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-status-"));
    try {
      const data = path.join(h, ".paddock");
      await capture(() => runService("install", OPTS, ctx(h, recorder().run)));
      writeUpdateCheck(data, { ...CHECK, checkedAt: new Date().toISOString() });

      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
      let json: Record<string, unknown>;
      try {
        const prose = await capture(() =>
          runService("status", OPTS, ctx(h, recorder(true).run, {
            probeHealth: async () => ({ ok: true, version: "0.81.0" }),
          })),
        );
        expect(prose.code).toBe(EXIT.ok);
        // On stdout: nothing about the update. On stderr: the notice.
        expect(prose.out).not.toContain("0.82.0 is available");
        expect(errors.join("\n")).toContain("0.82.0 is available (you have 0.81.0).");
        errors.length = 0;
        const asJson = await capture(() =>
          runService("status", { ...OPTS, json: true }, ctx(h, recorder(true).run, {
            probeHealth: async () => ({ ok: true, version: "0.81.0" }),
          })),
        );
        json = JSON.parse(asJson.out) as Record<string, unknown>;
      } finally {
        console.error = originalError;
      }
      // The projection `schemas/service-status.schema.json` describes.
      expect(json.update).toEqual({
        latest: "0.82.0",
        updateAvailable: true,
        checkedAt: expect.any(String),
      });
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  it("`service status` says nothing when there is no cache", async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-status2-"));
    try {
      await capture(() => runService("install", OPTS, ctx(h, recorder().run)));
      const r = await capture(() =>
        runService("status", { ...OPTS, json: true }, ctx(h, recorder(true).run, {
          probeHealth: async () => ({ ok: true, version: "0.81.0" }),
        })),
      );
      expect((JSON.parse(r.out) as Record<string, unknown>).update).toBeNull();
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });
});
