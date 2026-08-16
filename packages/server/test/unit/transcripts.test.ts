import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  encodeProjectDir,
  projectChatsDir,
  encodedTranscriptDir,
  ensureProjectChats,
  readFirstUserText,
  type ClaudeHomeTarget,
} from "../../src/transcripts.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("encodeProjectDir", () => {
  it("replaces every non-alphanumeric char with a hyphen (Claude Code's scheme)", () => {
    expect(encodeProjectDir("/Users/ed/Code/myproject")).toBe("-Users-ed-Code-myproject");
    expect(encodeProjectDir("/data/projects/water-heater")).toBe("-data-projects-water-heater");
    expect(encodeProjectDir("/a.b/c")).toBe("-a-b-c");
  });
});

describe("projectChatsDir", () => {
  it("is <projectDir>/.chats", () => {
    expect(projectChatsDir("/data/projects/p")).toBe(path.join("/data/projects/p", ".chats"));
  });
});

describe("readFirstUserText (issue #62)", () => {
  let projectDir: string;
  beforeEach(async () => {
    projectDir = await makeTmpDir("paddock-firsttext-");
  });
  afterEach(async () => {
    await rmTmpDir(projectDir);
  });

  async function writeTranscript(sessionId: string, lines: unknown[]): Promise<void> {
    const dir = projectChatsDir(projectDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${sessionId}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );
  }

  it("returns the FIRST user message untruncated (string content)", async () => {
    const long = "x".repeat(500);
    await writeTranscript("s1", [
      { type: "user", message: { content: long } },
      { type: "assistant", message: { content: "reply" } },
      { type: "user", message: { content: "second" } },
    ]);
    expect(await readFirstUserText(projectDir, "s1")).toBe(long); // not capped at 100
  });

  it("extracts text from array content and skips a tool_result-only message", async () => {
    await writeTranscript("s2", [
      { type: "user", message: { content: [{ type: "tool_result", content: "x" }] } },
      { type: "user", message: { content: [{ type: "text", text: "the real ask" }] } },
    ]);
    expect(await readFirstUserText(projectDir, "s2")).toBe("the real ask");
  });

  it("returns undefined for a missing transcript or an invalid session id", async () => {
    expect(await readFirstUserText(projectDir, "nope")).toBeUndefined();
    expect(await readFirstUserText(projectDir, "../escape")).toBeUndefined();
  });
});

describe("ensureProjectChats", () => {
  let home: string;
  let projectDir: string;

  let userHome: string;

  // The home is passed explicitly, never read from the environment (#620): the
  // parameter is required precisely so no caller can silently take a default.
  const owned = (): ClaudeHomeTarget => ({ path: home, transcripts: "own", userHome });

  beforeEach(async () => {
    home = await makeTmpDir("paddock-claude-home-");
    userHome = await makeTmpDir("paddock-user-claude-");
    projectDir = await makeTmpDir("paddock-proj-");
  });
  afterEach(async () => {
    await rmTmpDir(home);
    await rmTmpDir(userHome);
    await rmTmpDir(projectDir);
  });

  function encodedPath(): string {
    return path.join(home, "projects", encodeProjectDir(projectDir));
  }

  it("creates .chats and a symlink from the encoded path to it (fresh case)", async () => {
    await ensureProjectChats(projectDir, projectDir, owned());
    const chats = projectChatsDir(projectDir);
    expect((await fs.stat(chats)).isDirectory()).toBe(true);

    const enc = encodedPath();
    const st = await fs.lstat(enc);
    expect(st.isSymbolicLink()).toBe(true);
    const target = await fs.readlink(enc);
    expect(path.resolve(path.dirname(enc), target)).toBe(path.resolve(chats));
  });

  it("is idempotent (second call leaves a correct symlink)", async () => {
    await ensureProjectChats(projectDir, projectDir, owned());
    await ensureProjectChats(projectDir, projectDir, owned());
    const enc = encodedPath();
    expect((await fs.lstat(enc)).isSymbolicLink()).toBe(true);
  });

  it("heals a drifted symlink to point back at .chats", async () => {
    const enc = encodedPath();
    await fs.mkdir(path.dirname(enc), { recursive: true });
    const elsewhere = await makeTmpDir("paddock-elsewhere-");
    await fs.symlink(elsewhere, enc);

    await ensureProjectChats(projectDir, projectDir, owned());

    const target = await fs.readlink(enc);
    expect(path.resolve(path.dirname(enc), target)).toBe(
      path.resolve(projectChatsDir(projectDir)),
    );
    await rmTmpDir(elsewhere);
  });

  it("migrates an existing real transcript dir into .chats, then symlinks (heal branch)", async () => {
    // Simulate Claude Code having already written transcripts at the encoded path
    // as a REAL directory (the pre-relocation state).
    const enc = encodedPath();
    await fs.mkdir(enc, { recursive: true });
    await fs.writeFile(path.join(enc, "sess-1.jsonl"), '{"type":"user"}\n', "utf8");
    await fs.writeFile(path.join(enc, "sess-2.jsonl"), '{"type":"user"}\n', "utf8");

    await ensureProjectChats(projectDir, projectDir, owned());

    // The encoded path is now a symlink…
    expect((await fs.lstat(enc)).isSymbolicLink()).toBe(true);
    // …and the transcripts moved into .chats.
    const chats = projectChatsDir(projectDir);
    expect(await fs.readFile(path.join(chats, "sess-1.jsonl"), "utf8")).toContain("user");
    expect(await fs.readFile(path.join(chats, "sess-2.jsonl"), "utf8")).toContain("user");
  });

  it("does not clobber a transcript that already exists in .chats during migration", async () => {
    const chats = projectChatsDir(projectDir);
    await fs.mkdir(chats, { recursive: true });
    await fs.writeFile(path.join(chats, "sess-1.jsonl"), "KEEP", "utf8");

    const enc = encodedPath();
    await fs.mkdir(enc, { recursive: true });
    await fs.writeFile(path.join(enc, "sess-1.jsonl"), "OVERWRITE", "utf8");

    await ensureProjectChats(projectDir, projectDir, owned());

    // The pre-existing .chats copy wins (no clobber).
    expect(await fs.readFile(path.join(chats, "sess-1.jsonl"), "utf8")).toBe("KEEP");
  });

  // #691: `transcripts: host` — the same owned home, with the symlink pointed
  // the OTHER way, at the user's real folder for that working directory. One set
  // of files, both directions: a `claude --resume` append in a terminal is the
  // same bytes paddock renders.
  describe("under transcripts: host", () => {
    const host = (): ClaudeHomeTarget => ({ path: home, transcripts: "host", userHome });
    const hostStore = (): string => encodedTranscriptDir(userHome, projectDir);

    it("points the encoded path at the USER's folder, and creates it", async () => {
      await ensureProjectChats(projectDir, projectDir, host());

      const enc = encodedPath();
      expect((await fs.lstat(enc)).isSymbolicLink()).toBe(true);
      const target = await fs.readlink(enc);
      expect(path.resolve(path.dirname(enc), target)).toBe(path.resolve(hostStore()));
      // The link must not dangle: Claude Code cannot mkdir -p through one.
      expect((await fs.stat(enc)).isDirectory()).toBe(true);
    });

    it("writes through the link into the user's real folder", async () => {
      await ensureProjectChats(projectDir, projectDir, host());
      // Stand in for Claude Code: write to the LITERAL path it would use.
      await fs.writeFile(path.join(encodedPath(), "s.jsonl"), "SHARED", "utf8");
      expect(await fs.readFile(path.join(hostStore(), "s.jsonl"), "utf8")).toBe("SHARED");
    });

    // Not in #691's sketch, and load-bearing: ~a dozen server modules resolve a
    // transcript as `<projectDir>/.chats/<id>.jsonl` rather than through the
    // Claude home (subagents, usage, tooldetails, localcommand, recovery,
    // readFirstUserText). Without this they read an empty directory and the chat
    // renders with no sub-agent panels, no token usage and no tool details.
    it("points .chats/ at the same folder so by-path readers still work", async () => {
      await ensureProjectChats(projectDir, projectDir, host());
      await fs.writeFile(
        path.join(hostStore(), "s3.jsonl"),
        JSON.stringify({ type: "user", message: { content: "from the terminal" } }) + "\n",
        "utf8",
      );
      expect(await readFirstUserText(projectDir, "s3")).toBe("from the terminal");
    });

    it("never deletes a .chats/ that still holds transcripts", async () => {
      const chats = projectChatsDir(projectDir);
      await fs.mkdir(chats, { recursive: true });
      await fs.writeFile(path.join(chats, "old.jsonl"), "KEEP", "utf8");

      await ensureProjectChats(projectDir, projectDir, host());

      expect((await fs.lstat(chats)).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(path.join(chats, "old.jsonl"), "utf8")).toBe("KEEP");
      // …and the redirect is still planted, so chat itself works.
      expect((await fs.lstat(encodedPath())).isSymbolicLink()).toBe(true);
    });

    // Regression, found by booting a real instance rather than by reading the
    // code: `ensureSweeperHome` hands in a `<dataDir>/sweepers/<slug>` that
    // nothing has created yet. Symlinking `.chats` into a missing parent is an
    // ENOENT, and the function's catch-all swallowed it — so every sweeper lost
    // its redirect and wrote transcripts to an unmanaged path, with no error.
    it("works when the chats host dir does not exist yet (the sweeper case)", async () => {
      const fresh = path.join(projectDir, "sweepers", "slug");
      await ensureProjectChats(fresh, fresh, host());

      const enc = encodedTranscriptDir(home, fresh);
      expect((await fs.lstat(enc)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(enc)).toBe(
        await fs.realpath(encodedTranscriptDir(userHome, fresh)),
      );
      expect((await fs.lstat(projectChatsDir(fresh))).isSymbolicLink()).toBe(true);
    });

    it("re-aims an existing own-mode link when the setting flips", async () => {
      await ensureProjectChats(projectDir, projectDir, owned());
      await ensureProjectChats(projectDir, projectDir, host());

      const enc = encodedPath();
      const target = await fs.readlink(enc);
      expect(path.resolve(path.dirname(enc), target)).toBe(path.resolve(hostStore()));
    });
  });

  /**
   * #708 — flipping BACK to `own` after a `host` period.
   *
   * `pointChatsDirAt` was only ever called under `host`, so nothing un-planted
   * the `.chats` symlink it left. The result was a two-hop chain into the user's
   * real Claude home that survived every subsequent `own` boot, because
   * `mkdir(recursive)` over a symlink-to-a-real-dir is a silent no-op:
   *
   *     <projectDir>/.chats           SYMLINK -> <userHome>/projects/<enc>
   *     <claudeHome>/projects/<enc>   SYMLINK -> <projectDir>/.chats
   *
   * Every test below starts from the state a real `host` run leaves, by running
   * `ensureProjectChats` in `host` mode — not by hand-planting a link — so the
   * fixture cannot drift away from what the bug actually produces.
   */
  describe("flipping back from host to own (#708)", () => {
    const host = (): ClaudeHomeTarget => ({ path: home, transcripts: "host", userHome });
    const hostStore = (): string => encodedTranscriptDir(userHome, projectDir);

    /** Run a `host` period that leaves one transcript in the user's own folder. */
    async function hostPeriod(): Promise<string> {
      await ensureProjectChats(projectDir, projectDir, host());
      const written = path.join(hostStore(), "host-era.jsonl");
      await fs.writeFile(written, "the user's history", "utf8");
      // Fixture guard: prove the bug's precondition actually exists before every
      // test asserts something about clearing it.
      expect((await fs.lstat(projectChatsDir(projectDir))).isSymbolicLink()).toBe(true);
      return written;
    }

    it("unplants the stale .chats symlink and puts a real directory back", async () => {
      await hostPeriod();

      await ensureProjectChats(projectDir, projectDir, owned());

      const chats = projectChatsDir(projectDir);
      const st = await fs.lstat(chats);
      expect(st.isSymbolicLink()).toBe(false);
      expect(st.isDirectory()).toBe(true);
    });

    // The bug's own signature: three `own` boots in a row did not heal it.
    it("is not defeated by the mkdir no-op that made it survive repeat boots", async () => {
      await hostPeriod();

      for (let i = 0; i < 3; i++) await ensureProjectChats(projectDir, projectDir, owned());

      expect((await fs.lstat(projectChatsDir(projectDir))).isSymbolicLink()).toBe(false);
    });

    // Non-negotiable #1. Verified in the issue's sandbox as an actual breach: a
    // chat created after the flip landed in the user's real folder, which
    // falsifies the module doc's "under `own` nothing under `~/.claude` is
    // created, read or written at all".
    it("restores isolation: a post-flip chat lands in the project, not the user's home", async () => {
      await hostPeriod();
      await ensureProjectChats(projectDir, projectDir, owned());

      // Stand in for Claude Code: write to the LITERAL encoded path it would use.
      await fs.writeFile(path.join(encodedPath(), "own-era.jsonl"), "ours", "utf8");

      expect(await fs.readFile(path.join(projectChatsDir(projectDir), "own-era.jsonl"), "utf8"))
        .toBe("ours");
      await expect(fs.stat(path.join(hostStore(), "own-era.jsonl"))).rejects.toThrow();
    });

    // Non-negotiable #2, at the path level: `manager.deleteSession` rm's
    // `<claudeHome>/projects/<enc>/<id>.jsonl`, so what that resolves to IS the
    // delete's blast radius. Before the fix it resolved into the user's home.
    it("keeps a delete inside paddock's own store", async () => {
      await hostPeriod();
      await ensureProjectChats(projectDir, projectDir, owned());
      await fs.writeFile(path.join(encodedPath(), "own-era.jsonl"), "ours", "utf8");

      const wouldDelete = await fs.realpath(path.join(encodedPath(), "own-era.jsonl"));
      expect(wouldDelete.startsWith(path.resolve(userHome) + path.sep)).toBe(false);
      expect(wouldDelete).toBe(
        await fs.realpath(path.join(projectChatsDir(projectDir), "own-era.jsonl")),
      );
    });

    // The decision, pinned: unplant only. The host-era transcripts are NOT
    // copied in — see `unplantChatsDir` for the three reasons — and, just as
    // importantly, they are not read or moved either. `own` means paddock does
    // not touch that folder, including while cleaning up after itself.
    it("leaves the host-era transcripts exactly where they are", async () => {
      const written = await hostPeriod();
      const before = await fs.stat(written);

      await ensureProjectChats(projectDir, projectDir, owned());

      expect(await fs.readFile(written, "utf8")).toBe("the user's history");
      expect((await fs.stat(written)).mtimeMs).toBe(before.mtimeMs);
      // …and they are deliberately NOT swept into the project store.
      expect(await fs.readdir(projectChatsDir(projectDir))).toEqual([]);
    });

    it("reports the link it removed, naming both ends, so boot can tell the operator", async () => {
      await hostPeriod();

      const unplanted = await ensureProjectChats(projectDir, projectDir, owned());

      expect(unplanted).not.toBeNull();
      expect(unplanted?.chatsDir).toBe(projectChatsDir(projectDir));
      expect(path.resolve(unplanted?.target ?? "")).toBe(path.resolve(hostStore()));
    });

    // The sibling of `host`'s "never deletes a .chats/ that still holds
    // transcripts". That one pins the property under `host`; this pins it under
    // `own`, where the new code runs. Removing a SYMLINK deletes no transcript —
    // that is why the two can both hold — but a real store must still be
    // untouchable, and nothing here may quietly widen into an `rm -rf`.
    it("never touches a .chats/ that is already a real directory of transcripts", async () => {
      const chats = projectChatsDir(projectDir);
      await fs.mkdir(chats, { recursive: true });
      await fs.writeFile(path.join(chats, "old.jsonl"), "KEEP", "utf8");

      const unplanted = await ensureProjectChats(projectDir, projectDir, owned());

      expect(unplanted).toBeNull();
      expect((await fs.lstat(chats)).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(path.join(chats, "old.jsonl"), "utf8")).toBe("KEEP");
    });

    it("reports nothing on a healthy own instance", async () => {
      expect(await ensureProjectChats(projectDir, projectDir, owned())).toBeNull();
      expect(await ensureProjectChats(projectDir, projectDir, owned())).toBeNull();
    });

    // The sweeper inherited the same stale link, so its transcripts went to the
    // user's home too. It reaches `ensureProjectChats` with a dir that does not
    // exist yet, which is its own historic trip hazard (see the `host` case).
    it("heals a sweeper home the same way", async () => {
      const sweeper = path.join(projectDir, "sweepers", "slug");
      await ensureProjectChats(sweeper, sweeper, host());
      expect((await fs.lstat(projectChatsDir(sweeper))).isSymbolicLink()).toBe(true);

      await ensureProjectChats(sweeper, sweeper, owned());

      expect((await fs.lstat(projectChatsDir(sweeper))).isSymbolicLink()).toBe(false);
    });

    // Repo-backed projects (#187): the keeper's cwd is the nested checkout, the
    // `.chats` store stays in the metadata dir. The healing must follow the
    // STORE, not the cwd, or a repo-backed project keeps its stale link.
    it("heals the store dir, not the working dir, for a repo-backed project", async () => {
      const checkout = path.join(projectDir, "checkout");
      await fs.mkdir(checkout, { recursive: true });
      await ensureProjectChats(checkout, projectDir, host());
      expect((await fs.lstat(projectChatsDir(projectDir))).isSymbolicLink()).toBe(true);

      const unplanted = await ensureProjectChats(checkout, projectDir, owned());

      expect(unplanted?.chatsDir).toBe(projectChatsDir(projectDir));
      expect((await fs.lstat(projectChatsDir(projectDir))).isSymbolicLink()).toBe(false);
      // …and the encoded path for the CHECKOUT now points at that real store.
      const enc = encodedTranscriptDir(home, checkout);
      expect(await fs.realpath(enc)).toBe(await fs.realpath(projectChatsDir(projectDir)));
    });
  });

  // The #690 regression, pinned in BOTH modes because it is the whole reason
  // `host` is an outward symlink rather than a repointed `CLAUDE_CONFIG_DIR`.
  //
  // The agent harness refuses to write to any path containing a `.claude`
  // component, and agent memory lives at `<claudeHome>/projects/<enc>/memory` —
  // so 0.61.1's "share by pointing the home at ~/.claude" silently took agent
  // memory away. Here the LITERAL path stays inside paddock's own home in both
  // modes; only what it resolves to changes.
  describe("the memory path handed to the agent (#690)", () => {
    const hasClaudeComponent = (p: string): boolean =>
      p.split(path.sep).includes(".claude");

    it.each(["own", "host"] as const)(
      "has no .claude component under transcripts: %s",
      async (transcripts) => {
        const target: ClaudeHomeTarget = { path: home, transcripts, userHome };
        await ensureProjectChats(projectDir, projectDir, target);

        const memory = path.join(encodedTranscriptDir(home, projectDir), "memory");
        expect(hasClaudeComponent(memory)).toBe(false);
        // The fixture must be able to fail: the user's home DOES have one, and
        // under `host` that is exactly where these files resolve to.
        expect(hasClaudeComponent(path.join(userHome, ".claude", "projects"))).toBe(true);
      },
    );

    it("resolves INTO the user's home under host, while the literal path stays clean", async () => {
      const realUserHome = path.join(userHome, ".claude");
      await fs.mkdir(realUserHome, { recursive: true });
      const target: ClaudeHomeTarget = { path: home, transcripts: "host", userHome: realUserHome };
      await ensureProjectChats(projectDir, projectDir, target);

      const memory = path.join(encodedTranscriptDir(home, projectDir), "memory");
      expect(hasClaudeComponent(memory)).toBe(false);
      await fs.mkdir(memory, { recursive: true });
      await fs.writeFile(path.join(memory, "note.md"), "remembered", "utf8");
      // Same file, reached through the user's real `.claude` path.
      const shared = path.join(
        encodedTranscriptDir(realUserHome, projectDir),
        "memory",
        "note.md",
      );
      expect(await fs.readFile(shared, "utf8")).toBe("remembered");
    });
  });

  it("never throws (swallows errors) when the encoded path is unwritable", async () => {
    // Point the home at a file (not a dir) so mkdir of projects/ fails.
    const badHome = path.join(home, "afile");
    await fs.writeFile(badHome, "x", "utf8");
    // Resolving, not the value, is the assertion — #708 gave this function a
    // return type (the stale link it unplanted), so the swallow now yields
    // `null` where it used to yield `undefined`. "Found nothing to report" is
    // the right thing for a failed run to say.
    await expect(
      ensureProjectChats(projectDir, projectDir, { path: badHome, transcripts: "own", userHome }),
    ).resolves.toBeNull();
  });
});
