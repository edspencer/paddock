import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  encodeProjectDir,
  projectChatsDir,
  ensureProjectChats,
  ensureScratchChats,
  retireChatsLink,
  rewriteTranscriptCwd,
  readFirstUserText,
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
  let prevClaudeHome: string | undefined;

  beforeEach(async () => {
    home = await makeTmpDir("paddock-claude-home-");
    prevClaudeHome = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = home;
    projectDir = await makeTmpDir("paddock-proj-");
  });
  afterEach(async () => {
    if (prevClaudeHome === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = prevClaudeHome;
    await rmTmpDir(home);
    await rmTmpDir(projectDir);
  });

  function encodedPath(): string {
    return path.join(home, "projects", encodeProjectDir(projectDir));
  }

  it("creates .chats and a symlink from the encoded path to it (fresh case)", async () => {
    await ensureProjectChats(projectDir);
    const chats = projectChatsDir(projectDir);
    expect((await fs.stat(chats)).isDirectory()).toBe(true);

    const enc = encodedPath();
    const st = await fs.lstat(enc);
    expect(st.isSymbolicLink()).toBe(true);
    const target = await fs.readlink(enc);
    expect(path.resolve(path.dirname(enc), target)).toBe(path.resolve(chats));
  });

  it("is idempotent (second call leaves a correct symlink)", async () => {
    await ensureProjectChats(projectDir);
    await ensureProjectChats(projectDir);
    const enc = encodedPath();
    expect((await fs.lstat(enc)).isSymbolicLink()).toBe(true);
  });

  it("heals a drifted symlink to point back at .chats", async () => {
    const enc = encodedPath();
    await fs.mkdir(path.dirname(enc), { recursive: true });
    const elsewhere = await makeTmpDir("paddock-elsewhere-");
    await fs.symlink(elsewhere, enc);

    await ensureProjectChats(projectDir);

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

    await ensureProjectChats(projectDir);

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

    await ensureProjectChats(projectDir);

    // The pre-existing .chats copy wins (no clobber).
    expect(await fs.readFile(path.join(chats, "sess-1.jsonl"), "utf8")).toBe("KEEP");
  });

  it("never throws (swallows errors) when the encoded path is unwritable", async () => {
    // Point CLAUDE_HOME at a file (not a dir) so mkdir of projects/ fails.
    const badHome = path.join(home, "afile");
    await fs.writeFile(badHome, "x", "utf8");
    process.env.CLAUDE_HOME = badHome;
    await expect(ensureProjectChats(projectDir)).resolves.toBeUndefined();
  });
});

describe("rewriteTranscriptCwd (promotion, incl. the #512 legacy cwd)", () => {
  const line = (cwd: string) => `{"type":"user","sessionId":"s","cwd":"${cwd}"}`;

  it("rewrites every occurrence of each `from` dir to the target", () => {
    const raw = [line("/data/scratch"), line("/data/scratch")].join("\n");
    expect(rewriteTranscriptCwd(raw, ["/data/scratch"], "/data/projects/p")).toBe(
      [line("/data/projects/p"), line("/data/projects/p")].join("\n"),
    );
  });

  it("rewrites a chat written under EITHER scratch cwd (pre- and post-#512)", () => {
    const raw = [line("/data/projects"), line("/data/scratch")].join("\n");
    // The root agent's cwd moved from <dataDir>/scratch to projectsRoot, so a
    // promoted chat may carry either. Both must land on the project's cwd.
    const out = rewriteTranscriptCwd(raw, ["/data/projects", "/data/scratch"], "/data/projects/p");
    expect(out).toBe([line("/data/projects/p"), line("/data/projects/p")].join("\n"));
  });

  it("does NOT match a deeper cwd that merely starts with the `from` dir", () => {
    // The token carries the closing quote, so projectsRoot can't eat a project's
    // own `<projectsRoot>/<slug>` cwd — the #512 prefix-collision guard.
    const raw = line("/data/projects/other");
    expect(rewriteTranscriptCwd(raw, ["/data/projects"], "/data/projects/p")).toBe(raw);
  });

  it("is a no-op when the same dir is passed twice (scratch store == cwd)", () => {
    const raw = line("/data/projects");
    expect(rewriteTranscriptCwd(raw, ["/data/projects", "/data/projects"], "/x")).toBe(line("/x"));
  });
});

describe("retireChatsLink / ensureScratchChats — the #512 root-cwd move", () => {
  let home: string;
  let scratchDir: string;
  let projectsRoot: string;
  let prevClaudeHome: string | undefined;

  beforeEach(async () => {
    home = await makeTmpDir("paddock-claude-home-");
    prevClaudeHome = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = home;
    scratchDir = await makeTmpDir("paddock-scratch-");
    projectsRoot = await makeTmpDir("paddock-projects-");
  });
  afterEach(async () => {
    if (prevClaudeHome === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = prevClaudeHome;
    await rmTmpDir(home);
    await rmTmpDir(scratchDir);
    await rmTmpDir(projectsRoot);
  });

  const encoded = (dir: string) => path.join(home, "projects", encodeProjectDir(dir));

  /** Seed the pre-#512 on-disk state: transcripts in <scratchDir>/.chats, with the
   * encoded bucket for the OLD cwd (the scratch dir itself) symlinked at them. */
  async function seedPre512(sessionId = "sess-live"): Promise<string> {
    const chats = projectChatsDir(scratchDir);
    await fs.mkdir(chats, { recursive: true });
    const file = path.join(chats, `${sessionId}.jsonl`);
    await fs.writeFile(file, `{"type":"user","cwd":"${scratchDir}"}\n`, "utf8");
    await fs.mkdir(path.join(home, "projects"), { recursive: true });
    await fs.symlink(chats, encoded(scratchDir));
    return file;
  }

  it("upgrades a live instance: existing scratch chats stay put and are reachable from the NEW cwd", async () => {
    await seedPre512();

    await ensureScratchChats(projectsRoot, scratchDir);

    // The store did NOT move — no chat file was relocated at all.
    expect(
      await fs.readFile(path.join(projectChatsDir(scratchDir), "sess-live.jsonl"), "utf8"),
    ).toContain("user");
    // …and it is readable THROUGH the new cwd's encoded bucket, which is what
    // Claude Code / herdctl resolve for the relocated scratch agent.
    expect(
      await fs.readFile(path.join(encoded(projectsRoot), "sess-live.jsonl"), "utf8"),
    ).toContain("user");
    expect((await fs.lstat(encoded(projectsRoot))).isSymbolicLink()).toBe(true);
  });

  it("retires the pre-#512 pointer so a session is not listed from two buckets", async () => {
    await seedPre512();
    await ensureScratchChats(projectsRoot, scratchDir);
    await expect(fs.lstat(encoded(scratchDir))).rejects.toThrow();
  });

  it("does NOT put the transcript store inside the backing repo (no repo pollution)", async () => {
    await ensureScratchChats(projectsRoot, scratchDir);
    // <projectsRoot>/.chats must not exist: the store stays outside the repo.
    await expect(fs.lstat(path.join(projectsRoot, ".chats"))).rejects.toThrow();
    expect((await fs.stat(projectChatsDir(scratchDir))).isDirectory()).toBe(true);
  });

  it("folds a legacy REAL transcript dir at the old cwd into the store before retiring it", async () => {
    // An instance so old it predates the .chats relocation entirely.
    const enc = encoded(scratchDir);
    await fs.mkdir(enc, { recursive: true });
    await fs.writeFile(path.join(enc, "old-1.jsonl"), '{"type":"user"}\n', "utf8");

    await ensureScratchChats(projectsRoot, scratchDir);

    expect(
      await fs.readFile(path.join(projectChatsDir(scratchDir), "old-1.jsonl"), "utf8"),
    ).toContain("user");
    expect(
      await fs.readFile(path.join(encoded(projectsRoot), "old-1.jsonl"), "utf8"),
    ).toContain("user");
    await expect(fs.lstat(enc)).rejects.toThrow();
  });

  it("never clobbers a transcript that already exists in the store", async () => {
    const chats = projectChatsDir(scratchDir);
    await fs.mkdir(chats, { recursive: true });
    await fs.writeFile(path.join(chats, "dupe.jsonl"), "KEEP", "utf8");
    const enc = encoded(scratchDir);
    await fs.mkdir(enc, { recursive: true });
    await fs.writeFile(path.join(enc, "dupe.jsonl"), "OVERWRITE", "utf8");

    await ensureScratchChats(projectsRoot, scratchDir);

    expect(await fs.readFile(path.join(chats, "dupe.jsonl"), "utf8")).toBe("KEEP");
  });

  it("leaves a FOREIGN symlink at the old cwd alone (only ever retires our own)", async () => {
    const elsewhere = await makeTmpDir("paddock-elsewhere-");
    await fs.mkdir(path.join(home, "projects"), { recursive: true });
    await fs.symlink(elsewhere, encoded(scratchDir));

    await ensureScratchChats(projectsRoot, scratchDir);

    const target = await fs.readlink(encoded(scratchDir));
    expect(path.resolve(path.dirname(encoded(scratchDir)), target)).toBe(elsewhere);
    await rmTmpDir(elsewhere);
  });

  it("is idempotent — a second boot changes nothing", async () => {
    await seedPre512();
    await ensureScratchChats(projectsRoot, scratchDir);
    await ensureScratchChats(projectsRoot, scratchDir);
    expect(
      await fs.readFile(path.join(encoded(projectsRoot), "sess-live.jsonl"), "utf8"),
    ).toContain("user");
    await expect(fs.lstat(encoded(scratchDir))).rejects.toThrow();
  });

  it("keeps the live pointer when the store IS the cwd (scratch dir == projects root)", async () => {
    await ensureScratchChats(projectsRoot, projectsRoot);
    expect((await fs.lstat(encoded(projectsRoot))).isSymbolicLink()).toBe(true);
  });

  it("never throws (retireChatsLink swallows a broken CLAUDE_HOME)", async () => {
    const badHome = path.join(home, "afile");
    await fs.writeFile(badHome, "x", "utf8");
    process.env.CLAUDE_HOME = badHome;
    await expect(ensureScratchChats(projectsRoot, scratchDir)).resolves.toBeUndefined();
    await expect(retireChatsLink(scratchDir, scratchDir)).resolves.toBeUndefined();
  });
});
