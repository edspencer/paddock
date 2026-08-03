/**
 * Unit tests for `--here` support (#640).
 *
 * These cover the parts that decide whether Paddock touches somebody's real
 * project directory, so the emphasis is on the negative cases: detection must
 * never throw, and `.gitignore` must never be clobbered.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { encodePathForCli } from "@herdctl/core";
import {
  HERE_MARKER,
  isHereWorkspace,
  countClaudeSessions,
  ensureGitignored,
} from "../../src/cli/here.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
beforeEach(async () => {
  tmp = await makeTmpDir();
});
afterEach(async () => {
  await rmTmpDir(tmp);
});

/** Write a transcript for `cwd` into a fake Claude home. `bytes` pads the body. */
function seedSession(claudeHome: string, cwd: string, id: string, bytes = 600): void {
  const dir = path.join(claudeHome, "projects", encodePathForCli(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ type: "user", sessionId: id, cwd, pad: "x".repeat(bytes) });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${line}\n`, "utf8");
}

describe("isHereWorkspace", () => {
  it("is false for an ordinary directory", () => {
    expect(isHereWorkspace(tmp)).toBe(false);
  });

  it("is true once the marker directory exists", () => {
    fs.mkdirSync(path.join(tmp, HERE_MARKER));
    expect(isHereWorkspace(tmp)).toBe(true);
  });

  it("is false when the marker is a FILE, not a directory", () => {
    // Someone's unrelated `.paddock` notes file must not silently hijack their
    // shell's cwd into being a workspace.
    fs.writeFileSync(path.join(tmp, HERE_MARKER), "not a workspace", "utf8");
    expect(isHereWorkspace(tmp)).toBe(false);
  });

  it("is false for a path that does not exist at all", () => {
    expect(isHereWorkspace(path.join(tmp, "nope"))).toBe(false);
  });
});

describe("countClaudeSessions", () => {
  it("returns 0 when the Claude home has nothing for this directory", () => {
    expect(countClaudeSessions(path.join(tmp, "claude"), "/some/project")).toBe(0);
  });

  it("counts transcripts recorded for the directory", () => {
    const home = path.join(tmp, "claude");
    seedSession(home, "/work/myapp", "a1");
    seedSession(home, "/work/myapp", "a2");
    expect(countClaudeSessions(home, "/work/myapp")).toBe(2);
  });

  it("does not count another directory's sessions", () => {
    const home = path.join(tmp, "claude");
    seedSession(home, "/work/other", "b1");
    expect(countClaudeSessions(home, "/work/myapp")).toBe(0);
  });

  it("ignores transcripts below the adoptable size threshold", () => {
    // Shares MIN_TRANSCRIPT_BYTES with AdoptableIndex so the number we print
    // matches what the import screen will actually offer.
    const home = path.join(tmp, "claude");
    seedSession(home, "/work/myapp", "tiny", 1);
    expect(countClaudeSessions(home, "/work/myapp")).toBe(0);
  });

  it("ignores non-transcript files in the folder", () => {
    const home = path.join(tmp, "claude");
    seedSession(home, "/work/myapp", "real");
    const dir = path.join(home, "projects", encodePathForCli("/work/myapp"));
    fs.writeFileSync(path.join(dir, "notes.txt"), "x".repeat(900), "utf8");
    expect(countClaudeSessions(home, "/work/myapp")).toBe(1);
  });

  it("handles a directory whose path needs encoding", () => {
    const home = path.join(tmp, "claude");
    const spaced = "/work/my project";
    seedSession(home, spaced, "s1");
    expect(countClaudeSessions(home, spaced)).toBe(1);
  });
});

describe("ensureGitignored", () => {
  it("creates .gitignore when absent", () => {
    ensureGitignored(tmp, "/.paddock/");
    expect(fs.readFileSync(path.join(tmp, ".gitignore"), "utf8")).toContain("/.paddock/");
  });

  it("APPENDS, preserving the user's existing rules", () => {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "node_modules/\ndist/\n", "utf8");
    ensureGitignored(tmp, "/.paddock/");
    const body = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
    expect(body).toContain("node_modules/");
    expect(body).toContain("dist/");
    expect(body).toContain("/.paddock/");
  });

  it("adds a trailing newline before appending to a file that lacks one", () => {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "node_modules/", "utf8");
    ensureGitignored(tmp, "/.paddock/");
    expect(fs.readFileSync(path.join(tmp, ".gitignore"), "utf8")).toBe(
      "node_modules/\n/.paddock/\n",
    );
  });

  it("is idempotent — a second call adds nothing", () => {
    ensureGitignored(tmp, "/.paddock/");
    const once = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
    ensureGitignored(tmp, "/.paddock/");
    expect(fs.readFileSync(path.join(tmp, ".gitignore"), "utf8")).toBe(once);
  });

  it.each(["/.paddock/", ".paddock/", ".paddock"])(
    "recognises the equivalent existing form %s and does not duplicate",
    (form) => {
      fs.writeFileSync(path.join(tmp, ".gitignore"), `${form}\n`, "utf8");
      ensureGitignored(tmp, "/.paddock/");
      const lines = fs
        .readFileSync(path.join(tmp, ".gitignore"), "utf8")
        .split("\n")
        .filter((l) => l.includes("paddock"));
      expect(lines).toHaveLength(1);
    },
  );
});
