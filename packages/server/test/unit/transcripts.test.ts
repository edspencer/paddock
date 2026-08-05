import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  encodeProjectDir,
  projectChatsDir,
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

  // The home is passed explicitly, never read from the environment (#620): the
  // parameter is required precisely so no caller can silently take a default.
  const owned = (): ClaudeHomeTarget => ({ path: home, owned: true });

  beforeEach(async () => {
    home = await makeTmpDir("paddock-claude-home-");
    projectDir = await makeTmpDir("paddock-proj-");
  });
  afterEach(async () => {
    await rmTmpDir(home);
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

  // #620: the migrate branch copies transcripts into `.chats/` and then `fs.rm`s
  // the originals. That is fine inside a home paddock owns — such a directory can
  // only be its own doing. Inside the user's `~/.claude` it is somebody else's
  // `claude` CLI history for a directory paddock happens to also manage, and
  // deleting it was the destructive behaviour #620 exists to stop.
  describe("in a home paddock does NOT own", () => {
    const unowned = (h: string): ClaudeHomeTarget => ({ path: h, owned: false });

    it("leaves an existing real transcript dir completely alone", async () => {
      const enc = encodedPath();
      await fs.mkdir(enc, { recursive: true });
      await fs.writeFile(path.join(enc, "mine.jsonl"), '{"type":"user"}\n', "utf8");
      const before = await fs.stat(path.join(enc, "mine.jsonl"));

      await ensureProjectChats(projectDir, projectDir, unowned(home));

      // Still a real directory, still holding the user's transcript, untouched.
      expect((await fs.lstat(enc)).isDirectory()).toBe(true);
      expect((await fs.lstat(enc)).isSymbolicLink()).toBe(false);
      const after = await fs.stat(path.join(enc, "mine.jsonl"));
      expect(after.mtimeMs).toBe(before.mtimeMs);
      // …and nothing was copied out of it either.
      await expect(
        fs.access(path.join(projectChatsDir(projectDir), "mine.jsonl")),
      ).rejects.toBeTruthy();
    });

    // #682, the regression this file did not have. The two branches above were
    // guarded and tested; this one was not, on the reading that creating a name
    // nobody has used yet cannot destroy anything. It can: the encoded path is
    // where the user's FUTURE `claude` sessions for this directory land, so the
    // link quietly redirects them into `.chats/` — and then deleting `.chats/`,
    // an ordinary thing to do, takes transcripts paddock never owned with it.
    it("plants NOTHING when the encoded folder does not exist yet", async () => {
      await ensureProjectChats(projectDir, projectDir, unowned(home));

      const enc = encodedPath();
      // The decisive assertion: the name is still free, so Claude Code will
      // create its own real directory there and keep the user's history.
      await expect(fs.lstat(enc)).rejects.toMatchObject({ code: "ENOENT" });
      // Nothing else was left in the home either — not a stray dir, not a link.
      expect(await fs.readdir(path.join(home, "projects")).catch(() => [])).toEqual([]);
    });

    it("still creates the project's .chats/ store (bailing is not failing)", async () => {
      // Adoption (#588) copies INTO `.chats/`, and every direct reader of the
      // store (readFirstUserText, subagents) resolves it by path — so the
      // directory must exist even when no symlink points at it.
      await ensureProjectChats(projectDir, projectDir, unowned(home));
      expect((await fs.stat(projectChatsDir(projectDir))).isDirectory()).toBe(true);
    });
  });

  it("never throws (swallows errors) when the encoded path is unwritable", async () => {
    // Point the home at a file (not a dir) so mkdir of projects/ fails.
    const badHome = path.join(home, "afile");
    await fs.writeFile(badHome, "x", "utf8");
    await expect(
      ensureProjectChats(projectDir, projectDir, { path: badHome, owned: true }),
    ).resolves.toBeUndefined();
  });
});
