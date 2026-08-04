import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { encodePathForCli } from "@herdctl/core";
import {
  ensureClaudeHome,
  mirrorLegacyTranscriptFolders,
  legacySourcePath,
  countLegacyTranscriptLinks,
  BRIDGED_ENTRIES,
} from "../../src/claude-home.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * #620 — paddock owns `<dataDir>/claude-home`, and `~/.claude` becomes a
 * READ-ONLY source.
 *
 * The invariant every test here defends: **paddock never moves, deletes or
 * overwrites anything under the user's home.** It may create symlinks pointing
 * INTO it (the config bridge, the adoption mirror), and it must never do more.
 */
describe("claude-home (#620)", () => {
  let root: string;
  let ownHome: string;
  let legacyHome: string;

  const cfg = (owns = true) => ({
    claudeHome: owns ? ownHome : legacyHome,
    legacyClaudeHome: legacyHome,
    ownsClaudeHome: owns,
  });

  beforeEach(async () => {
    root = await makeTmpDir("paddock-claude-home-");
    ownHome = path.join(root, "data", "claude-home");
    legacyHome = path.join(root, "home", ".claude");
    await fs.mkdir(path.join(legacyHome, "projects"), { recursive: true });
  });
  afterEach(async () => {
    await rmTmpDir(root);
  });

  describe("ensureClaudeHome", () => {
    it("creates its own home's projects/ dir", async () => {
      await ensureClaudeHome(cfg(), { CLAUDE_CODE_OAUTH_TOKEN: "t" });
      expect((await fs.stat(path.join(ownHome, "projects"))).isDirectory()).toBe(true);
    });

    it("bridges user-level config in by SYMLINK, never by copy", async () => {
      await fs.writeFile(path.join(legacyHome, "CLAUDE.md"), "user memory", "utf8");
      await fs.writeFile(path.join(legacyHome, ".credentials.json"), "{}", "utf8");
      await fs.mkdir(path.join(legacyHome, "commands"), { recursive: true });

      const report = await ensureClaudeHome(cfg(), {});
      expect(report.bridged).toEqual(
        expect.arrayContaining([".credentials.json", "CLAUDE.md", "commands"]),
      );

      // Symlinks, not copies: a copy of `.credentials.json` would duplicate a
      // live secret onto disk and diverge the moment the token refreshed.
      for (const entry of report.bridged) {
        expect((await fs.lstat(path.join(ownHome, entry))).isSymbolicLink()).toBe(true);
        expect(await fs.readlink(path.join(ownHome, entry))).toBe(path.join(legacyHome, entry));
      }
      // Reading through the link gets the user's real content.
      expect(await fs.readFile(path.join(ownHome, "CLAUDE.md"), "utf8")).toBe("user memory");
    });

    it("bridges nothing that is not present in the user's home", async () => {
      const report = await ensureClaudeHome(cfg(), {});
      expect(report.bridged).toEqual([]);
      for (const entry of BRIDGED_ENTRIES) {
        await expect(fs.lstat(path.join(ownHome, entry))).rejects.toBeTruthy();
      }
    });

    it("never clobbers an entry paddock's home already has", async () => {
      await fs.writeFile(path.join(legacyHome, "settings.json"), '{"from":"user"}', "utf8");
      await fs.mkdir(ownHome, { recursive: true });
      await fs.writeFile(path.join(ownHome, "settings.json"), '{"from":"instance"}', "utf8");

      const report = await ensureClaudeHome(cfg(), {});

      expect(report.bridged).not.toContain("settings.json");
      expect(await fs.readFile(path.join(ownHome, "settings.json"), "utf8")).toBe(
        '{"from":"instance"}',
      );
    });

    it("is idempotent — a second boot re-bridges nothing", async () => {
      await fs.writeFile(path.join(legacyHome, "CLAUDE.md"), "x", "utf8");
      expect((await ensureClaudeHome(cfg(), {})).bridged).toEqual(["CLAUDE.md"]);
      expect((await ensureClaudeHome(cfg(), {})).bridged).toEqual([]);
    });

    it("does not touch the user's home at all when paddock does not own the home", async () => {
      const before = await fs.readdir(legacyHome);
      const report = await ensureClaudeHome(cfg(false), {});
      expect(report.bridged).toEqual([]);
      // No self-bridging: the entries are already there.
      expect((await fs.readdir(legacyHome)).sort()).toEqual(before.sort());
    });

    // The credential question. Claude Code scopes its secure-storage service name
    // to whether CLAUDE_CONFIG_DIR is SET AT ALL, so a keychain login against the
    // default home is invisible under a relocated one. We cannot fix that; we can
    // refuse to let it be discovered as a chat that never replies.
    describe("credential warning", () => {
      const warned = (r: { notices: { level: string; message: string }[] }) =>
        r.notices.some((n) => n.level === "warn" && n.message.includes("no Claude credentials"));

      it("warns when neither a token env var nor a credentials file is visible", async () => {
        expect(warned(await ensureClaudeHome(cfg(), {}))).toBe(true);
      });

      it("stays quiet when a token is in the environment", async () => {
        expect(warned(await ensureClaudeHome(cfg(), { CLAUDE_CODE_OAUTH_TOKEN: "t" }))).toBe(false);
        expect(warned(await ensureClaudeHome(cfg(), { ANTHROPIC_API_KEY: "k" }))).toBe(false);
      });

      it("stays quiet when the user's credentials file was bridged in", async () => {
        await fs.writeFile(path.join(legacyHome, ".credentials.json"), "{}", "utf8");
        expect(warned(await ensureClaudeHome(cfg(), {}))).toBe(false);
      });

      it("names the escape hatch, so the fix is in the message", async () => {
        const report = await ensureClaudeHome(cfg(), {});
        const warning = report.notices.find((n) => n.level === "warn")!;
        expect(warning.message).toContain(`CLAUDE_HOME=${legacyHome}`);
      });
    });

    it("never throws when the home cannot be created", async () => {
      // A FILE where the home should be: mkdir fails.
      await fs.mkdir(path.dirname(ownHome), { recursive: true });
      await fs.writeFile(ownHome, "x", "utf8");
      const report = await ensureClaudeHome(cfg(), {});
      expect(report.notices.some((n) => n.level === "warn")).toBe(true);
    });
  });

  describe("mirrorLegacyTranscriptFolders", () => {
    /** Give the user a real transcript folder for `cwd` in their own home. */
    async function seedLegacyFolder(name: string): Promise<string> {
      const dir = path.join(legacyHome, "projects", name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "sess.jsonl"), '{"type":"user"}\n', "utf8");
      return dir;
    }

    it("makes the user's real transcript folders readable through paddock's home", async () => {
      const legacyDir = await seedLegacyFolder("-home-ed-code-thing");
      const [mirror] = await mirrorLegacyTranscriptFolders(ownHome, legacyHome);

      expect(mirror.legacyDir).toBe(legacyDir);
      const mirrored = path.join(ownHome, "projects", mirror.name);
      expect((await fs.lstat(mirrored)).isSymbolicLink()).toBe(true);
      // Readable THROUGH the mirror — this is what the engine does.
      expect(await fs.readFile(path.join(mirrored, "sess.jsonl"), "utf8")).toContain("user");
    });

    it("names the mirror for a SYNTHETIC path, so it can never collide with a project", async () => {
      // The heart of #620's adoption problem. A project whose working directory
      // IS the directory the user has history for wants the same encoded folder
      // name — and paddock's `.chats/` symlink is already sitting on it. Naming
      // the mirror after the folder's own path makes the clash impossible.
      const cwd = path.join(root, "code", "thing");
      const [mirror] = await mirrorLegacyTranscriptFolders(ownHome, legacyHome).then(async () => {
        await seedLegacyFolder(encodePathForCli(cwd));
        return mirrorLegacyTranscriptFolders(ownHome, legacyHome);
      });

      expect(mirror.engineCwd).toBe(legacySourcePath(legacyHome, encodePathForCli(cwd)));
      expect(mirror.name).toBe(encodePathForCli(mirror.engineCwd));
      expect(mirror.name).not.toBe(encodePathForCli(cwd));

      // The name the project would use is untouched and still free for it.
      await expect(
        fs.lstat(path.join(ownHome, "projects", encodePathForCli(cwd))),
      ).rejects.toBeTruthy();
    });

    it("coexists with a project's own .chats symlink for the very same cwd", async () => {
      const cwd = path.join(root, "data", "projects", "proj");
      await seedLegacyFolder(encodePathForCli(cwd));
      const chats = path.join(cwd, ".chats");
      await fs.mkdir(chats, { recursive: true });
      const own = path.join(ownHome, "projects", encodePathForCli(cwd));
      await fs.mkdir(path.dirname(own), { recursive: true });
      await fs.symlink(chats, own);

      const mirrors = await mirrorLegacyTranscriptFolders(ownHome, legacyHome);

      // Both readable, under different names — which is what lets a copy be
      // taken FROM the user's folder INTO the project's.
      expect(mirrors).toHaveLength(1);
      expect(await fs.readlink(own)).toBe(chats);
      expect(
        await fs.readFile(path.join(ownHome, "projects", mirrors[0].name, "sess.jsonl"), "utf8"),
      ).toContain("user");
    });

    it("skips symlinks in the legacy home — the leftovers of the old layout", async () => {
      // Pre-#620 paddock planted these, pointing back at a project's .chats.
      // Mirroring one would re-offer paddock's OWN chats as adoptable.
      const chats = path.join(root, "data", "projects", "old", ".chats");
      await fs.mkdir(chats, { recursive: true });
      await fs.symlink(chats, path.join(legacyHome, "projects", "-data-old"));

      expect(await mirrorLegacyTranscriptFolders(ownHome, legacyHome)).toEqual([]);
      expect(await fs.readdir(path.join(ownHome, "projects"))).toEqual([]);
    });

    it("does nothing when the two homes are the same directory", async () => {
      await seedLegacyFolder("-a");
      expect(await mirrorLegacyTranscriptFolders(legacyHome, legacyHome)).toEqual([]);
    });

    it("is idempotent — the second call re-reports the same mirrors, plants nothing", async () => {
      await seedLegacyFolder("-a");
      const first = await mirrorLegacyTranscriptFolders(ownHome, legacyHome);
      const second = await mirrorLegacyTranscriptFolders(ownHome, legacyHome);
      expect(first).toHaveLength(1);
      expect(second).toEqual(first);
      expect(await fs.readdir(path.join(ownHome, "projects"))).toHaveLength(1);
    });

    it("leaves the user's transcripts byte-for-byte and mtime-for-mtime intact", async () => {
      const dir = await seedLegacyFolder("-untouched");
      const before = await fs.stat(path.join(dir, "sess.jsonl"));
      await mirrorLegacyTranscriptFolders(ownHome, legacyHome);
      const after = await fs.stat(path.join(dir, "sess.jsonl"));
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.size).toBe(before.size);
      expect((await fs.lstat(dir)).isDirectory()).toBe(true);
    });
  });

  describe("countLegacyTranscriptLinks", () => {
    it("counts only symlinks that point into THIS data dir", async () => {
      const dataDir = path.join(root, "data");
      await fs.symlink(path.join(dataDir, "projects", "a", ".chats"), path.join(legacyHome, "projects", "-a"));
      await fs.symlink("/somewhere/else/.chats", path.join(legacyHome, "projects", "-b"));
      await fs.mkdir(path.join(legacyHome, "projects", "-real"), { recursive: true });

      expect(await countLegacyTranscriptLinks(legacyHome, dataDir)).toBe(1);
    });

    it("is zero when the user has no Claude home at all", async () => {
      expect(await countLegacyTranscriptLinks(path.join(root, "nope"), root)).toBe(0);
    });
  });
});
