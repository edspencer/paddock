import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdoptableSession } from "@herdctl/core";
import {
  defaultTempRoots,
  discoverCandidates,
  discoverSessions,
  DiscoverPathError,
  isTempPath,
  type DiscoverContext,
  type DiscoverExclusion,
} from "../../src/discover.js";
import type { TranscriptFolder } from "../../src/adoptable.js";
import { MIN_TRANSCRIPT_BYTES } from "../../src/adoptable.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * The Discovery heuristic (#745).
 *
 * Driven against a REAL fixture tree rather than mocked `fs`, because half the
 * rules are questions only the filesystem can answer: does the directory still
 * exist, is it a git checkout, and where does a symlink actually go. The
 * transcript folders themselves ARE fabricated — `discoverCandidates` takes them
 * as input, so `AdoptableIndex`'s scan is somebody else's test — which is what
 * lets one table cover twelve cases in a few milliseconds each.
 *
 * The whole fixture lives under a temp dir, and `home` lives under it too. That
 * is deliberate: on Linux `os.tmpdir()` is `/tmp`, so the fixture home is itself
 * inside a temp root, and every one of these cases would be excluded if the
 * "$HOME wins a temp-root conflict" rule regressed.
 */
describe("discover heuristic (#745)", () => {
  let tmp: string;
  /** The user's home, and the default containment boundary. */
  let home: string;
  /** Paddock's own directories — a project may never be linked inside them. */
  let dataDir: string;
  let projectsRoot: string;
  let claudeHome: string;
  /**
   * The fixture's ephemeral root. Synthetic, and inside the fixture, because the
   * whole tree lives under the REAL `os.tmpdir()` — using the machine's temp
   * roots here would make every case "temp-root" and prove nothing. The real
   * list is exercised directly against {@link isTempPath} below.
   */
  let scratchRoot: string;

  beforeEach(async () => {
    tmp = await makeTmpDir("paddock-discover-");
    home = path.join(tmp, "home");
    dataDir = path.join(tmp, "data");
    projectsRoot = path.join(dataDir, "projects");
    claudeHome = path.join(dataDir, "claude-home");
    scratchRoot = path.join(tmp, "scratch");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(scratchRoot, { recursive: true });
    await fs.mkdir(projectsRoot, { recursive: true });
    await fs.mkdir(claudeHome, { recursive: true });
  });
  afterEach(async () => {
    await rmTmpDir(tmp);
  });

  /** Create `dir`, optionally making it look like a git checkout. */
  async function dirAt(dir: string, opts: { git?: boolean | string } = {}): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    if (opts.git !== undefined && opts.git !== false) {
      await fs.mkdir(path.join(dir, ".git"), { recursive: true });
      const url = typeof opts.git === "string" ? opts.git : null;
      if (url !== null) {
        await fs.writeFile(
          path.join(dir, ".git", "config"),
          `[remote "origin"]\n\turl = ${url}\n`,
          "utf8",
        );
      }
    }
    return dir;
  }

  /**
   * A transcript folder recording `cwd`. `engineCwd` differs only for the
   * legacy-mirror case (#620), where the folder is reachable ONLY under a
   * synthetic path.
   */
  let folderSeq = 0;
  function folder(cwd: string | null, engineCwd?: string): TranscriptFolder {
    const name = `folder-${folderSeq++}`;
    return {
      name,
      realPath: path.join(claudeHome, "projects", name),
      key: "0:0",
      cwd,
      engineCwd: cwd === null ? null : (engineCwd ?? cwd),
    };
  }

  /** A session the engine would offer, big enough to clear the noise filter. */
  function session(id: string, over: Partial<AdoptableSession> = {}): AdoptableSession {
    return {
      sessionId: id,
      sourceCwd: "/unused",
      mtime: "2026-01-01T00:00:00.000Z",
      sizeBytes: MIN_TRANSCRIPT_BYTES * 4,
      preview: "please refactor the parser",
      ...over,
    } as AdoptableSession;
  }

  /**
   * Build a context. `sessions` maps an ENGINE cwd to what the engine reports
   * there; anything unmapped reports one ordinary session, so a case that is
   * about paths never has to think about session content.
   */
  function context(
    folders: TranscriptFolder[],
    over: Partial<DiscoverContext> = {},
    sessions: Record<string, AdoptableSession[]> = {},
  ): DiscoverContext {
    return {
      folders,
      claudeHome,
      homeDir: home,
      reservedRoots: [projectsRoot, dataDir, claudeHome],
      tempRoots: [scratchRoot],
      managedDirs: [],
      takenSlugs: [],
      listSessions: async (engineCwd) => sessions[engineCwd] ?? [session(`s-${engineCwd}`)],
      ...over,
    };
  }

  // --- the exclusion table ------------------------------------------------

  interface Case {
    name: string;
    /** Build the directory to be discovered; returns the cwd transcripts record. */
    setup(): Promise<string>;
    /** The rule expected to eat it, or `null` when it should be offered. */
    expect: DiscoverExclusion | null;
    /** Extra context overrides (e.g. an existing project). */
    ctx?: () => Partial<DiscoverContext>;
  }

  const cases: Case[] = [
    {
      name: "an ordinary git checkout under $HOME is offered",
      setup: () => dirAt(path.join(home, "Code", "acme-api"), { git: true }),
      expect: null,
    },
    {
      name: "a directory that no longer exists",
      setup: async () => path.join(home, "Code", "deleted-last-week"),
      expect: "missing",
    },
    {
      name: "a path that is a FILE, not a directory",
      setup: async () => {
        const file = path.join(home, "notes.txt");
        await fs.writeFile(file, "hi", "utf8");
        return file;
      },
      expect: "missing",
    },
    {
      name: "the filesystem root",
      setup: async () => "/",
      expect: "system-path",
    },
    {
      name: "a system directory from the #720 denylist",
      setup: async () => "/etc",
      expect: "system-path",
    },
    {
      name: "a /proc path, which canonicalises to something innocent",
      setup: async () => "/proc/self/cwd",
      expect: "system-path",
    },
    {
      name: "an ephemeral temp-dir session — the ~150 this rule exists for",
      setup: () => dirAt(path.join(scratchRoot, "T", "some-repo"), { git: true }),
      expect: "temp-root",
    },
    {
      name: "inside Paddock's own projects root",
      setup: () => dirAt(path.join(projectsRoot, "some-project"), { git: true }),
      expect: "paddock-internal",
    },
    {
      name: "inside Paddock's own Claude home",
      setup: () => dirAt(path.join(claudeHome, "projects", "whatever")),
      expect: "paddock-internal",
    },
    {
      name: "$HOME itself",
      setup: async () => home,
      expect: "home-root",
    },
    {
      name: "outside $HOME (soft: default off)",
      setup: () => dirAt(path.join(tmp, "mnt", "repo"), { git: true }),
      expect: "outside-home",
    },
    {
      name: "a directory that already IS a project",
      setup: () => dirAt(path.join(home, "Code", "already"), { git: true }),
      expect: "already-managed",
      ctx: () => ({ managedDirs: [path.join(home, "Code", "already")] }),
    },
    {
      name: "a PARENT of an existing project's working dir (overlap, either direction)",
      setup: () => dirAt(path.join(home, "Code"), { git: true }),
      expect: "already-managed",
      ctx: () => ({ managedDirs: [path.join(home, "Code", "nested")] }),
    },
    {
      name: "a non-repo directory like ~/Downloads (soft: default off)",
      setup: () => dirAt(path.join(home, "Downloads")),
      expect: "no-git",
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const cwd = await c.setup();
      const result = await discoverCandidates(context([folder(cwd)], c.ctx?.() ?? {}));
      if (c.expect === null) {
        expect(result.candidates.map((x) => x.path)).toEqual([await fs.realpath(cwd)]);
        expect(result.excluded).toEqual({});
      } else {
        expect(result.candidates).toEqual([]);
        expect(result.excluded).toEqual({ [c.expect]: 1 });
      }
    });
  }

  it("excludes a folder whose transcripts record no cwd — never inverting the folder name", async () => {
    const result = await discoverCandidates(context([folder(null)]));
    expect(result.candidates).toEqual([]);
    expect(result.excluded).toEqual({ "no-recorded-cwd": 1 });
  });

  it("excludes a directory whose sessions are all noise", async () => {
    const dir = await dirAt(path.join(home, "Code", "quiet"), { git: true });
    const result = await discoverCandidates(
      context([folder(dir)], {}, { [dir]: [session("tiny", { sizeBytes: 10 })] }),
    );
    expect(result.candidates).toEqual([]);
    expect(result.excluded).toEqual({ "no-sessions": 1 });
  });

  // --- the soft rules -----------------------------------------------------

  it("includeNonGit offers a directory with no .git", async () => {
    const dir = await dirAt(path.join(home, "notebook"));
    const off = await discoverCandidates(context([folder(dir)]));
    expect(off.candidates).toEqual([]);
    expect(off.excluded).toEqual({ "no-git": 1 });

    const on = await discoverCandidates(context([folder(dir)]), { includeNonGit: true });
    expect(on.candidates.map((c) => c.path)).toEqual([dir]);
    expect(on.candidates[0].hasGit).toBe(false);
  });

  it("includeOutsideHome offers a directory outside $HOME — but never a temp root", async () => {
    const outside = await dirAt(path.join(tmp, "mnt", "repo"), { git: true });
    const scratch = await dirAt(path.join(scratchRoot, "hard"), { git: true });
    const result = await discoverCandidates(context([folder(outside), folder(scratch)]), {
      includeOutsideHome: true,
    });
    expect(result.candidates.map((c) => c.path)).toEqual([outside]);
    // The temp root is a HARD rule: relaxing the home preference does not reach it.
    expect(result.excluded).toEqual({ "temp-root": 1 });
    expect(result.candidates[0].insideHome).toBe(false);
  });

  it("the real ephemeral roots catch /tmp — and $HOME wins a conflict with them", () => {
    const roots = defaultTempRoots();
    expect(roots).toContain(os.tmpdir());
    expect(isTempPath("/tmp/some-scratch/repo", home, roots)).toBe(true);
    expect(isTempPath("/private/var/folders/xy/T/repo", home, roots)).toBe(true);
    expect(isTempPath(path.join(home, "Code", "app"), home, roots)).toBe(false);
    // A home that itself sits under a temp root (a container, or this very
    // fixture) must not have every one of its directories eaten by the rule.
    const sandboxHome = path.join(os.tmpdir(), "sandbox-home");
    expect(isTempPath(path.join(sandboxHome, "Code", "app"), sandboxHome, roots)).toBe(false);
  });

  // --- ordering, grouping, ranking ---------------------------------------

  it("applies the cheap string rules before touching a transcript", async () => {
    const scratch = await dirAt(path.join(scratchRoot, "cost"), { git: true });
    const real = await dirAt(path.join(home, "Code", "real"), { git: true });
    const asked: string[] = [];
    const ctx = context([folder(scratch), folder(real)], {
      listSessions: async (engineCwd) => {
        asked.push(engineCwd);
        return [session(`s-${engineCwd}`)];
      },
    });
    await discoverCandidates(ctx);
    // The temp dir never cost a session read; only the survivor did.
    expect(asked).toEqual([real]);
  });

  it("groups two transcript folders that resolve to one directory, de-duping sessions", async () => {
    const dir = await dirAt(path.join(home, "Code", "shared"), { git: true });
    // The #620 shape: the user's own folder reached through a synthetic mirror
    // path, plus paddock's own folder for the same cwd. Both describe ONE row.
    const mirror = path.join(home, ".claude", "projects", "-home-Code-shared");
    const ctx = context([folder(dir), folder(dir, mirror)], {}, {
      [dir]: [session("a"), session("b")],
      // `a` is the same session reached the other way: offered once, not twice.
      [mirror]: [session("a"), session("c")],
    });
    const result = await discoverCandidates(ctx);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].sessionCount).toBe(3);
    expect(result.scanned).toBe(2);
  });

  it("resolves a symlinked cwd and reports the recorded spelling", async () => {
    const real = await dirAt(path.join(home, "real", "app"), { git: true });
    const link = path.join(home, "link-to-app");
    await fs.symlink(real, link);
    const result = await discoverCandidates(context([folder(link)]));
    expect(result.candidates[0].path).toBe(real);
    expect(result.candidates[0].recordedPath).toBe(link);
  });

  it("ranks by non-noise session count, then recency", async () => {
    const busy = await dirAt(path.join(home, "Code", "busy"), { git: true });
    const quiet = await dirAt(path.join(home, "Code", "quiet"), { git: true });
    const stale = await dirAt(path.join(home, "Code", "stale"), { git: true });
    const result = await discoverCandidates(
      context([folder(quiet), folder(stale), folder(busy)], {}, {
        [busy]: [session("b1"), session("b2"), session("b3")],
        [quiet]: [session("q1", { mtime: "2026-06-01T00:00:00.000Z" })],
        [stale]: [session("s1", { mtime: "2020-01-01T00:00:00.000Z" })],
      }),
    );
    expect(result.candidates.map((c) => c.name)).toEqual(["busy", "quiet", "stale"]);
    expect(result.candidates[0].sessionCount).toBe(3);
    expect(result.candidates[1].lastSessionAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("counts noise per candidate rather than hiding it", async () => {
    const dir = await dirAt(path.join(home, "Code", "mixed"), { git: true });
    const result = await discoverCandidates(
      context([folder(dir)], {}, {
        [dir]: [
          session("keep"),
          session("stub", { sizeBytes: 4 }),
          session("cmd", { sizeBytes: 500, preview: "/mcp" }),
        ],
      }),
    );
    expect(result.candidates[0].sessionCount).toBe(1);
    expect(result.candidates[0].filteredCount).toBe(2);
  });

  it("reports the git remote, which is how two same-named checkouts are told apart", async () => {
    const a = await dirAt(path.join(home, "a", "paddock"), {
      git: "git@github.com:edspencer/paddock.git",
    });
    const b = await dirAt(path.join(home, "b", "paddock"), {
      git: "https://github.com/someone/paddock",
    });
    const result = await discoverCandidates(context([folder(a), folder(b)]));
    expect(result.candidates.map((c) => c.gitRemote).sort()).toEqual([
      "github.com/edspencer/paddock",
      "github.com/someone/paddock",
    ]);
  });

  it("qualifies a colliding slug by parent dir, and never reuses a taken one", async () => {
    const a = await dirAt(path.join(home, "work", "api"), { git: true });
    const b = await dirAt(path.join(home, "play", "api"), { git: true });
    const result = await discoverCandidates(
      context([folder(a), folder(b)], { takenSlugs: ["api"] }, {
        [a]: [session("a1"), session("a2")],
        [b]: [session("b1")],
      }),
    );
    // `api` is taken by an existing project, so neither candidate may claim it.
    expect(result.candidates.map((c) => c.suggestedSlug)).toEqual(["work-api", "play-api"]);
  });

  it("reports the scanned total and the home so a container can explain itself", async () => {
    const result = await discoverCandidates(context([]));
    expect(result).toMatchObject({ scanned: 0, candidates: [], claudeHome, homeDir: home });
  });

  // --- the ?dir= containment boundary ------------------------------------

  describe("discoverSessions containment", () => {
    it("lists a discovered directory's sessions with the noise reason per skip", async () => {
      const dir = await dirAt(path.join(home, "Code", "acme"), { git: true });
      const ctx = context([folder(dir)], {}, {
        [dir]: [session("keep"), session("cmd", { sizeBytes: 500, preview: "/status" })],
      });
      const out = await discoverSessions(ctx, dir);
      expect(out.path).toBe(dir);
      expect(out.sessions.map((s) => s.sessionId)).toEqual(["keep"]);
      expect(out.filtered).toEqual([{ sessionId: "cmd", reason: "slash-command-only" }]);
    });

    it("refuses a path with no transcript folder — it is not a filesystem probe", async () => {
      const known = await dirAt(path.join(home, "Code", "known"), { git: true });
      const secret = await dirAt(path.join(home, "Secrets"), { git: true });
      const ctx = context([folder(known)]);
      await expect(discoverSessions(ctx, secret)).rejects.toBeInstanceOf(DiscoverPathError);
      await expect(discoverSessions(ctx, "/etc")).rejects.toBeInstanceOf(DiscoverPathError);
    });

    it("refuses a hard-excluded directory even though a transcript folder records it", async () => {
      const scratch = await dirAt(path.join(scratchRoot, "dir"), { git: true });
      const inside = await dirAt(path.join(projectsRoot, "p"), { git: true });
      const ctx = context([folder(scratch), folder(inside)]);
      await expect(discoverSessions(ctx, scratch)).rejects.toBeInstanceOf(DiscoverPathError);
      await expect(discoverSessions(ctx, inside)).rejects.toBeInstanceOf(DiscoverPathError);
    });

    it("still expands a row the SOFT rules would have hidden", async () => {
      // A client can only have learnt this path from a listing that opted in, so
      // the preference rules must not make the row un-expandable.
      const notebook = await dirAt(path.join(home, "notebook"));
      const outside = await dirAt(path.join(tmp, "mnt", "repo"), { git: true });
      const ctx = context([folder(notebook), folder(outside)]);
      await expect(discoverSessions(ctx, notebook)).resolves.toMatchObject({ path: notebook });
      await expect(discoverSessions(ctx, outside)).resolves.toMatchObject({ path: outside });
    });

    it("accepts either spelling of a symlinked candidate", async () => {
      const real = await dirAt(path.join(home, "real", "app"), { git: true });
      const link = path.join(home, "link-to-app");
      await fs.symlink(real, link);
      const ctx = context([folder(link)]);
      await expect(discoverSessions(ctx, link)).resolves.toMatchObject({ path: real });
      await expect(discoverSessions(ctx, real)).resolves.toMatchObject({ path: real });
    });
  });
});
