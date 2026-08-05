import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { encodePathForCli } from "@herdctl/core";
import {
  ensureClaudeHome,
  mirrorLegacyTranscriptFolders,
  legacySourcePath,
  countLegacyTranscriptLinks,
  findPlantedChatsLinks,
  probeMacosKeychainLogin,
  BRIDGED_ENTRIES,
  CREDENTIAL_ENTRY,
  type KeychainProbe,
} from "../../src/claude-home.js";
import {
  DEFAULT_CREDENTIALS_MODE,
  SECURE_STORAGE_DIR_VAR,
  type CredentialsMode,
} from "../../src/claude-credentials.js";
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

  /**
   * A config for `ensureClaudeHome`, at the SHIPPED defaults unless a test says
   * otherwise — `credentials: host` included, because that default is load-bearing
   * (#691/#683) and a helper that quietly isolated would hide a regression in it.
   */
  const cfg = (credentials: CredentialsMode = DEFAULT_CREDENTIALS_MODE) => ({
    claudeHome: ownHome,
    legacyClaudeHome: legacyHome,
    claude: { transcripts: "own" as const, credentials },
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

    // #691 removed the "is this home ours?" branch — it always is, and a config
    // that resolves the home to `~/.claude` refuses to boot. The invariant this
    // used to guard is unchanged and stated directly: bridging only ever ADDS
    // symlinks to paddock's own home.
    it("adds nothing to the user's home while bridging out of it", async () => {
      await fs.writeFile(path.join(legacyHome, "CLAUDE.md"), "user memory", "utf8");
      const before = (await fs.readdir(legacyHome)).sort();
      await ensureClaudeHome(cfg(), {});
      expect((await fs.readdir(legacyHome)).sort()).toEqual(before);
    });

    /**
     * The `claude.credentials` lever's two halves (#691).
     *
     * On darwin it is the `CLAUDE_SECURESTORAGE_CONFIG_DIR` empty-string trick;
     * here — Linux, the Docker image, CI — it is the `.credentials.json` symlink,
     * which is where `claude login` actually puts the token. One config key has to
     * mean the same thing on both, so both are asserted, and the environment half
     * is asserted on every platform because the decision is pure.
     */
    describe("credentials: own | host", () => {
      it("bridges the user's login under host, and NOT under own", async () => {
        await fs.writeFile(path.join(legacyHome, CREDENTIAL_ENTRY), "{}", "utf8");

        expect((await ensureClaudeHome(cfg("host"), {})).bridged).toContain(CREDENTIAL_ENTRY);
        await fs.rm(path.join(ownHome, CREDENTIAL_ENTRY));

        expect((await ensureClaudeHome(cfg("own"), {})).bridged).not.toContain(CREDENTIAL_ENTRY);
        await expect(fs.lstat(path.join(ownHome, CREDENTIAL_ENTRY))).rejects.toBeTruthy();
      });

      it("bridges everything else either way — separate levers, still to come", async () => {
        await fs.writeFile(path.join(legacyHome, "CLAUDE.md"), "user memory", "utf8");
        expect((await ensureClaudeHome(cfg("own"), {})).bridged).toContain("CLAUDE.md");
      });

      it("WITHDRAWS a link a previous host boot planted when switched to own", async () => {
        // Otherwise "isolated" would be a claim that only holds for instances
        // that were never anything else — the bridge is non-clobbering, so a
        // stale link would survive the switch and keep reading the user's token.
        await fs.writeFile(path.join(legacyHome, CREDENTIAL_ENTRY), "{}", "utf8");
        await ensureClaudeHome(cfg("host"), {});
        expect((await fs.lstat(path.join(ownHome, CREDENTIAL_ENTRY))).isSymbolicLink()).toBe(true);

        const report = await ensureClaudeHome(cfg("own"), {});
        await expect(fs.lstat(path.join(ownHome, CREDENTIAL_ENTRY))).rejects.toBeTruthy();
        expect(report.notices.some((n) => n.message.includes(`removed the bridged`))).toBe(true);
        // The user's own file is untouched — the withdrawal happens entirely
        // inside paddock's home.
        expect(await fs.readFile(path.join(legacyHome, CREDENTIAL_ENTRY), "utf8")).toBe("{}");
      });

      it("never removes a REAL credentials file of this instance's own", async () => {
        // A `CLAUDE_CONFIG_DIR=<own home> claude login`, or an operator's file.
        // `own` means "use only your own login", not "delete it".
        await fs.mkdir(ownHome, { recursive: true });
        await fs.writeFile(path.join(ownHome, CREDENTIAL_ENTRY), '{"mine":true}', "utf8");
        await ensureClaudeHome(cfg("own"), {});
        const kept = await fs.readFile(path.join(ownHome, CREDENTIAL_ENTRY), "utf8");
        expect(kept).toBe('{"mine":true}');
      });

      it("puts the mode into the environment Claude Code will run in", async () => {
        // The darwin half, asserted where it can be: what paddock hands the
        // runtime. `test/integration/claude-credentials-env.test.ts` carries it
        // through a real boot and a real spawn.
        const host: NodeJS.ProcessEnv = {};
        await ensureClaudeHome(cfg("host"), host);
        expect(host[SECURE_STORAGE_DIR_VAR]).toBe("");

        const own: NodeJS.ProcessEnv = { [SECURE_STORAGE_DIR_VAR]: "" };
        await ensureClaudeHome(cfg("own"), own);
        expect(SECURE_STORAGE_DIR_VAR in own).toBe(false);
      });

      it("honours an operator's own value and says so", async () => {
        const env: NodeJS.ProcessEnv = { [SECURE_STORAGE_DIR_VAR]: "/elsewhere" };
        const report = await ensureClaudeHome(cfg("host"), env);
        expect(env[SECURE_STORAGE_DIR_VAR]).toBe("/elsewhere");
        expect(report.notices.some((n) => n.message.includes("already set to"))).toBe(true);
      });
    });

    // The credential question. Claude Code scopes its secure-storage service name
    // to whether CLAUDE_CONFIG_DIR is SET AT ALL, so a keychain login against the
    // default home is invisible under a relocated one. We cannot fix that; we can
    // refuse to let it be discovered as a chat that never replies.
    describe("credential warning", () => {
      // The probe is injected in EVERY case, including the ones that predate it:
      // left to its default these tests would read the real Keychain, and a
      // logged-in Mac would flip four of them. A decision table has to be a
      // decision table on every machine that runs it.
      const noKeychain: KeychainProbe = () => Promise.resolve("unknown");
      const keychainLogin: KeychainProbe = () => Promise.resolve("found");

      const warned = (r: { notices: { level: string; message: string }[] }) =>
        r.notices.some((n) => n.level === "warn" && n.message.includes("no Claude credentials"));

      it("warns when neither a token env var nor a credentials file is visible", async () => {
        expect(warned(await ensureClaudeHome(cfg(), {}, noKeychain))).toBe(true);
      });

      it("stays quiet when a token is in the environment", async () => {
        expect(
          warned(await ensureClaudeHome(cfg(), { CLAUDE_CODE_OAUTH_TOKEN: "t" }, noKeychain)),
        ).toBe(false);
        expect(warned(await ensureClaudeHome(cfg(), { ANTHROPIC_API_KEY: "k" }, noKeychain))).toBe(
          false,
        );
      });

      it("stays quiet when the user's credentials file was bridged in", async () => {
        await fs.writeFile(path.join(legacyHome, ".credentials.json"), "{}", "utf8");
        expect(warned(await ensureClaudeHome(cfg(), {}, noKeychain))).toBe(false);
      });

      it("names the fix, so it is in the message", async () => {
        const report = await ensureClaudeHome(cfg(), {}, noKeychain);
        const warning = report.notices.find((n) => n.level === "warn")!;
        expect(warning.message).toContain(`CLAUDE_CONFIG_DIR=${ownHome}`);
        // The old remedy — point the whole home at `~/.claude` — is gone (#691),
        // and must not come back in the wording: it re-breaks agent memory.
        expect(warning.message).not.toContain("CLAUDE_HOME");
      });

      // #683 — "you have no login" and "your login exists but I changed the
      // service name it is filed under" were one message, and only one of them
      // is the user's problem to solve. Since #691 there is a third state: the
      // login exists AND this instance is configured to use it, which is not a
      // problem at all and must not be reported as one.
      it("says you ARE logged in when credentials: own hides the Keychain entry", async () => {
        const report = await ensureClaudeHome(cfg("own"), {}, keychainLogin);
        const warning = report.notices.find((n) => n.level === "warn")!;
        expect(warning.message).toContain("you ARE logged in");
        expect(warning.message).not.toContain("no Claude credentials");
        // Both remedies, neither guessable from the generic wording — and the
        // cheap one (drop the key) is the one #691 added.
        expect(warning.message).toContain(`CLAUDE_CONFIG_DIR=${ownHome} claude login`);
        expect(warning.message).toContain("claude.credentials");
      });

      it("does NOT warn under host when the Keychain login is there to be used", async () => {
        const report = await ensureClaudeHome(cfg("host"), {}, keychainLogin);
        expect(report.notices.some((n) => n.level === "warn")).toBe(false);
        // Still said out loud: which login an instance is running on should not
        // have to be deduced from the absence of a warning.
        const info = report.notices.find((n) => n.message.includes("Claude login:"))!;
        expect(info.level).toBe("info");
        expect(info.message).toContain(SECURE_STORAGE_DIR_VAR);
      });

      it("still warns under host when there is no login anywhere to share", async () => {
        const report = await ensureClaudeHome(cfg("host"), {}, noKeychain);
        const warning = report.notices.find((n) => n.level === "warn")!;
        expect(warning.message).toContain("no Claude credentials");
        // The distinction that matters: "host is on and found nothing" is a
        // different sentence from "own is on and shares nothing".
        expect(warning.message).toContain("found nothing on this machine to share");
      });

      it("falls back to the generic wording on an inconclusive probe, never asserting there is no login", async () => {
        // The service name is Claude Code's private detail, so a miss means
        // "did not find one under a name I guessed", not "there isn't one".
        const report = await ensureClaudeHome(cfg(), {}, noKeychain);
        expect(report.notices.find((n) => n.level === "warn")!.message).not.toMatch(
          /you (are|ARE) not logged in|no login/,
        );
      });

      it("does not probe at all when the credential question does not arise", async () => {
        let probed = 0;
        const counting: KeychainProbe = () => {
          probed++;
          return Promise.resolve("unknown");
        };
        await ensureClaudeHome(cfg(), { CLAUDE_CODE_OAUTH_TOKEN: "t" }, counting);
        expect(probed).toBe(0);
      });
    });

    // The probe shells out, so the one thing worth pinning without a Mac is that
    // it cannot do anything on a machine that has no Keychain.
    describe("probeMacosKeychainLogin", () => {
      it("is inconclusive off darwin without spawning anything", async () => {
        expect(await probeMacosKeychainLogin("linux")).toBe("unknown");
        expect(await probeMacosKeychainLogin("win32")).toBe("unknown");
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

    // #691, `claude.transcripts: host`. There the folder in the user's home is a
    // real directory paddock itself writes through, reached by a link of the
    // SAME name in its own home — so mirroring it would offer every project's
    // own live chats back to it as importable. #658 with the arrow reversed.
    it("skips a legacy folder paddock's own home already links straight at", async () => {
      const shared = await seedLegacyFolder("-home-ed-code-shared");
      const own = path.join(ownHome, "projects", "-home-ed-code-shared");
      await fs.mkdir(path.dirname(own), { recursive: true });
      await fs.symlink(shared, own);

      expect(await mirrorLegacyTranscriptFolders(ownHome, legacyHome)).toEqual([]);
      // The direct link is untouched — it is how the chats are read at all.
      expect(await fs.readlink(own)).toBe(shared);
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

  // #682 — anyone who ran an affected build has one of these, and it keeps
  // redirecting their own `claude` sessions until they remove it. The point of
  // the finder is to name the exact path; it must not remove anything.
  describe("findPlantedChatsLinks", () => {
    const projectsOf = (h: string) => path.join(h, "projects");

    it("finds a --here workspace's poisoned link, which the dataDir check misses", async () => {
      // The observed shape: `--here` in ~/Code/thing puts the data dir at
      // <dir>/.paddock but the store at <dir>/.chats, so the link target is NOT
      // under dataDir and countLegacyTranscriptLinks reports nothing.
      const workspace = path.join(root, "Code", "thing");
      const dataDir = path.join(workspace, ".paddock");
      const chats = path.join(workspace, ".chats");
      await fs.mkdir(chats, { recursive: true });
      const link = path.join(projectsOf(legacyHome), "-root-Code-thing");
      await fs.symlink(chats, link);

      expect(await countLegacyTranscriptLinks(legacyHome, dataDir)).toBe(0); // the gap
      expect(await findPlantedChatsLinks(legacyHome, dataDir)).toEqual([
        { link, target: chats, dangling: false },
      ]);
    });

    it("flags a link whose .chats/ has already been deleted as dangling", async () => {
      const link = path.join(projectsOf(legacyHome), "-gone");
      await fs.symlink(path.join(root, "gone", ".chats"), link);
      const [found] = await findPlantedChatsLinks(legacyHome, path.join(root, "data"));
      expect(found.dangling).toBe(true);
    });

    it("ignores this instance's own residue, real dirs, and non-.chats links", async () => {
      const dataDir = path.join(root, "data");
      // Residue from the pre-#620 layout — already reported as harmless.
      await fs.symlink(
        path.join(dataDir, "projects", "a", ".chats"),
        path.join(projectsOf(legacyHome), "-own"),
      );
      // The user's own transcripts, and a link that is nothing to do with us.
      await fs.mkdir(path.join(projectsOf(legacyHome), "-real"), { recursive: true });
      await fs.symlink(path.join(root, "elsewhere"), path.join(projectsOf(legacyHome), "-other"));

      expect(await findPlantedChatsLinks(legacyHome, dataDir)).toEqual([]);
    });

    it("removes nothing it reports", async () => {
      const chats = path.join(root, "ws", ".chats");
      await fs.mkdir(chats, { recursive: true });
      await fs.writeFile(path.join(chats, "s.jsonl"), "{}\n", "utf8");
      const link = path.join(projectsOf(legacyHome), "-ws");
      await fs.symlink(chats, link);

      await findPlantedChatsLinks(legacyHome, path.join(root, "data"));

      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(chats, "s.jsonl"), "utf8")).toBe("{}\n");
    });

    it("never throws when the user has no Claude home at all", async () => {
      expect(await findPlantedChatsLinks(path.join(root, "nope"), root)).toEqual([]);
    });
  });
});
