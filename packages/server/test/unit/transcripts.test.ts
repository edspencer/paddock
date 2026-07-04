import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  encodeProjectDir,
  projectChatsDir,
  ensureProjectChats,
  metaUserTexts,
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

describe("metaUserTexts", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTmpDir("paddock-meta-");
  });
  afterEach(async () => {
    await rmTmpDir(projectDir);
  });

  async function writeSession(sessionId: string, lines: unknown[]): Promise<void> {
    const chats = projectChatsDir(projectDir);
    await fs.mkdir(chats, { recursive: true });
    await fs.writeFile(
      path.join(chats, `${sessionId}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );
  }

  it("returns the text of isMeta user lines (string content)", async () => {
    await writeSession("s1", [
      { type: "user", isMeta: true, message: { role: "user", content: "SKILL BODY" } },
      { type: "user", message: { role: "user", content: "real question" } },
      { type: "assistant", message: { role: "assistant", content: "answer" } },
    ]);
    const meta = await metaUserTexts(projectDir, "s1");
    expect(meta.has("SKILL BODY")).toBe(true);
    expect(meta.has("real question")).toBe(false);
    expect(meta.size).toBe(1);
  });

  it("joins text blocks with newlines, matching the parser", async () => {
    await writeSession("s2", [
      {
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        },
      },
    ]);
    const meta = await metaUserTexts(projectDir, "s2");
    expect(meta.has("line one\nline two")).toBe(true);
  });

  it("ignores non-user meta lines and empty-text meta lines", async () => {
    await writeSession("s3", [
      { type: "assistant", isMeta: true, message: { role: "assistant", content: "x" } },
      { type: "user", isMeta: true, message: { role: "user", content: "" } },
    ]);
    const meta = await metaUserTexts(projectDir, "s3");
    expect(meta.size).toBe(0);
  });

  it("skips malformed lines and returns an empty set for a missing transcript", async () => {
    await writeSession("s4", [{ type: "user", isMeta: true, message: { role: "user", content: "keep" } }]);
    // Append a garbage line that must not throw.
    await fs.appendFile(path.join(projectChatsDir(projectDir), "s4.jsonl"), "not json\n", "utf8");
    const meta = await metaUserTexts(projectDir, "s4");
    expect(meta.has("keep")).toBe(true);

    const missing = await metaUserTexts(projectDir, "does-not-exist");
    expect(missing.size).toBe(0);
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
