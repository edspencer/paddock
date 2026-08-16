import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildMigrationPlan,
  probeMigration,
  resetMigrationProbeCache,
  PRESERVE_DIR_NAME,
  type MigrationInput,
  type MigrationPlan,
} from "../../src/transcripts-migration.js";
import { encodeProjectDir } from "../../src/transcripts.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * The `own → host` migration preview (#882), against REAL directory shapes.
 *
 * Everything here is built on disk rather than mocked, because every
 * interesting bug in this module is a bug about a directory: an entry that is
 * not a transcript, a sidecar nobody enumerated, a chat that exists on both
 * sides, a `memory/MEMORY.md` that already exists in the user's own home. A
 * mocked `readdir` would agree with whatever the classifier believes.
 *
 * The `~/.claude` these tests read is a throwaway directory under the temp
 * root. On a machine where `$HOME` is a real Claude home, `userHome` pointing
 * anywhere near it would make this suite read thousands of real transcripts.
 */
describe("own → host migration preview (#882)", () => {
  let tmp: string;
  /** Stands in for the user's own `~/.claude`. */
  let userHome: string;
  let projectsRoot: string;

  beforeEach(async () => {
    tmp = await makeTmpDir("paddock-migration-");
    userHome = path.join(tmp, "home", ".claude");
    projectsRoot = path.join(tmp, "projects");
    await fs.mkdir(userHome, { recursive: true });
    resetMigrationProbeCache();
  });

  afterEach(async () => {
    await rmTmpDir(tmp);
  });

  /* ---------------------------------------------------------------------- */
  /* fixtures                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * A transcript as an append-only uuid-chained record list. `records` is how
   * many conversation records; `from` continues an existing chain so a genuine
   * ancestor/descendant pair can be built rather than approximated.
   */
  function transcriptLines(sessionId: string, records: number, tag = "a"): string[] {
    const lines: string[] = [];
    for (let i = 0; i < records; i++) {
      lines.push(
        JSON.stringify({
          type: i % 2 === 0 ? "user" : "assistant",
          uuid: `${tag}-${sessionId}-${i}`,
          parentUuid: i === 0 ? null : `${tag}-${sessionId}-${i - 1}`,
          sessionId,
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
          message: { role: i % 2 === 0 ? "user" : "assistant", content: `line ${i} ${"x".repeat(64)}` },
        }),
      );
    }
    return lines;
  }

  async function writeLines(file: string, lines: string[]): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, lines.join("\n") + "\n", "utf8");
  }

  /** A project dir with a `.chats/`, plus its host store path. */
  async function project(slug: string, name = slug || "Root"): Promise<{
    slug: string;
    name: string;
    dir: string;
    workingDir: string;
    chats: string;
    host: string;
  }> {
    const dir = path.join(projectsRoot, slug === "" ? "_root" : slug);
    const workingDir = dir;
    const chats = path.join(dir, ".chats");
    const host = path.join(userHome, "projects", encodeProjectDir(workingDir));
    await fs.mkdir(chats, { recursive: true });
    return { slug, name, dir, workingDir, chats, host };
  }

  function input(
    projects: Array<{ slug: string; name: string; dir: string; workingDir: string }>,
    over: Partial<MigrationInput> = {},
  ): MigrationInput {
    return {
      mode: "own",
      profile: "balanced",
      envShadowed: false,
      projects,
      userHome,
      configPath: path.join(tmp, "paddock.config.yaml"),
      configVersion: "v1",
      ...over,
    };
  }

  const rowsOf = (plan: MigrationPlan, slug = "acme") =>
    plan.projects.find((p) => p.slug === slug)?.chats ?? [];

  /* ---------------------------------------------------------------------- */
  /* the four states                                                         */
  /* ---------------------------------------------------------------------- */

  it("classifies new, fast-forward, diverged and identical on real files", async () => {
    const p = await project("acme", "Acme");

    // NEW — exists only in `.chats/`.
    await writeLines(path.join(p.chats, "new-1.jsonl"), transcriptLines("new-1", 4));

    // FAST-FORWARD — the host copy is a strict PREFIX of Paddock's, which is
    // what "one side kept talking" actually looks like on disk.
    const ffAll = transcriptLines("ff-1", 10);
    await writeLines(path.join(p.chats, "ff-1.jsonl"), ffAll);
    await writeLines(path.join(p.host, "ff-1.jsonl"), ffAll.slice(0, 4));

    // DIVERGED — a shared prefix, then both sides advanced independently.
    const shared = transcriptLines("div-1", 4);
    await writeLines(path.join(p.chats, "div-1.jsonl"), [
      ...shared,
      ...transcriptLines("div-1", 3, "own"),
    ]);
    await writeLines(path.join(p.host, "div-1.jsonl"), [
      ...shared,
      ...transcriptLines("div-1", 6, "host"),
    ]);

    // IDENTICAL — same bytes, same mtime, on both sides.
    const same = transcriptLines("same-1", 5);
    await writeLines(path.join(p.chats, "same-1.jsonl"), same);
    await writeLines(path.join(p.host, "same-1.jsonl"), same);
    const when = new Date("2026-02-02T02:02:02Z");
    await fs.utimes(path.join(p.chats, "same-1.jsonl"), when, when);
    await fs.utimes(path.join(p.host, "same-1.jsonl"), when, when);

    const plan = await buildMigrationPlan(input([p]));
    const byId = new Map(rowsOf(plan).map((r) => [r.sessionId, r]));

    expect(byId.get("new-1")?.state).toBe("new");
    expect(byId.get("new-1")?.defaultSelected).toBe(true);
    expect(byId.get("new-1")?.host).toBeUndefined();

    expect(byId.get("ff-1")?.state).toBe("fast-forward");
    expect(byId.get("ff-1")?.defaultSelected).toBe(true);
    // Paddock's copy is the descendant, so Paddock's copy is the one that lives.
    expect(byId.get("ff-1")?.ahead).toBe("own");

    expect(byId.get("div-1")?.state).toBe("diverged");
    expect(byId.get("div-1")?.defaultSelected).toBe(false);
    expect(byId.get("div-1")?.ahead).toBeUndefined();

    expect(plan.totals).toMatchObject({
      chats: 3,
      new: 1,
      fastForward: 1,
      diverged: 1,
      unknown: 0,
      identical: 1,
      defaultSelected: 2,
    });
  });

  it("omits an identical pair from the rows but still counts it", async () => {
    const p = await project("acme");
    const same = transcriptLines("same-1", 5);
    await writeLines(path.join(p.chats, "same-1.jsonl"), same);
    await writeLines(path.join(p.host, "same-1.jsonl"), same);
    const when = new Date("2026-02-02T02:02:02Z");
    await fs.utimes(path.join(p.chats, "same-1.jsonl"), when, when);
    await fs.utimes(path.join(p.host, "same-1.jsonl"), when, when);

    const plan = await buildMigrationPlan(input([p]));
    expect(rowsOf(plan)).toHaveLength(0);
    expect(plan.totals.identical).toBe(1);
    // There is no decision to make, so there is no row — but the chat still
    // MOVES, because the postcondition is about `.chats/` ending up empty.
    expect(plan.totals.chats).toBe(0);
  });

  it("treats same-size copies with different mtimes as identical, not diverged", async () => {
    // A `cp` without `preserveTimestamps` produces exactly this pair, and
    // calling it a divergence would put an unnecessary decision in front of
    // every user who has ever relocated a store.
    const p = await project("acme");
    const same = transcriptLines("same-2", 5);
    await writeLines(path.join(p.chats, "same-2.jsonl"), same);
    await writeLines(path.join(p.host, "same-2.jsonl"), same);
    const older = new Date("2020-01-01T00:00:00Z");
    await fs.utimes(path.join(p.host, "same-2.jsonl"), older, older);

    const plan = await buildMigrationPlan(input([p]));
    expect(rowsOf(plan)).toHaveLength(0);
    expect(plan.totals.identical).toBe(1);
  });

  it("finds a fast-forward whose history was rewritten, via the stage-3 scan", async () => {
    // The bounded probe looks at ONE window, ending at byte `shorter.size`. A
    // descendant whose earlier records changed length puts the ancestor's tip
    // somewhere else entirely, and only the full scan finds it. Getting this
    // wrong reports a lossless case as a decision the user has to make.
    const p = await project("acme");
    const short = transcriptLines("rw-1", 4);
    await writeLines(path.join(p.host, "rw-1.jsonl"), short);
    await writeLines(path.join(p.chats, "rw-1.jsonl"), [
      JSON.stringify({ type: "system", uuid: "pad", padding: "p".repeat(50_000) }),
      ...short,
      ...transcriptLines("rw-1", 2, "later"),
    ]);

    const plan = await buildMigrationPlan(input([p]));
    const row = rowsOf(plan)[0];
    expect(row.state).toBe("fast-forward");
    expect(row.ahead).toBe("own");
  });

  it("gives a diverged row both sides' message counts and last-message times", async () => {
    const p = await project("acme");
    const shared = transcriptLines("div-2", 4);
    await writeLines(path.join(p.chats, "div-2.jsonl"), [
      ...shared,
      ...transcriptLines("div-2", 2, "own"),
    ]);
    await writeLines(path.join(p.host, "div-2.jsonl"), [
      ...shared,
      ...transcriptLines("div-2", 8, "host"),
    ]);

    const plan = await buildMigrationPlan(input([p]));
    const row = rowsOf(plan)[0];
    expect(row.state).toBe("diverged");
    expect(row.own.messageCount).toBe(6);
    expect(row.host?.messageCount).toBe(12);
    expect(row.own.lastMessageAt).toBeTruthy();
    expect(row.host?.lastMessageAt).toBeTruthy();
  });

  it("reports unknown rows and scanBudgetExhausted rather than truncating silently", async () => {
    const p = await project("acme");
    for (const id of ["big-1", "big-2"]) {
      const shared = transcriptLines(id, 4);
      await writeLines(path.join(p.chats, `${id}.jsonl`), [
        ...shared,
        ...transcriptLines(id, 20, "own"),
      ]);
      await writeLines(path.join(p.host, `${id}.jsonl`), [
        ...shared,
        ...transcriptLines(id, 40, "host"),
      ]);
    }

    // A budget big enough for neither scan.
    const plan = await buildMigrationPlan(input([p], { scanBudgetBytes: 10 }));
    expect(plan.scanBudgetExhausted).toBe(true);
    expect(plan.totals.unknown).toBe(2);
    expect(plan.totals.defaultSelected).toBe(0);
    for (const row of rowsOf(plan)) {
      expect(row.state).toBe("unknown");
      expect(row.defaultSelected).toBe(false);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* real directory shapes                                                   */
  /* ---------------------------------------------------------------------- */

  it("enumerates a chat's sidecars and the project's own artifacts", async () => {
    const p = await project("acme");
    const id = "0199abcd-1111-2222-3333-444455556666";
    await writeLines(path.join(p.chats, `${id}.jsonl`), transcriptLines(id, 3));
    await writeLines(path.join(p.chats, id, "subagents", "agent-1.jsonl"), transcriptLines("s", 2));
    await fs.mkdir(path.join(p.chats, id, "tool-results"), { recursive: true });
    await fs.writeFile(path.join(p.chats, id, "tool-results", "r1.json"), "{}", "utf8");
    await writeLines(path.join(p.chats, ".reverts", `${id}-1738000000000.jsonl`), ["{}"]);
    // A different chat's revert must NOT come along with this one.
    await writeLines(path.join(p.chats, ".reverts", "other-9999999999999.jsonl"), ["{}"]);
    // Project-level: agent memory and a flat sidechain transcript.
    await fs.writeFile(path.join(p.chats, "agent-deadbeef.jsonl"), "{}\n", "utf8");
    await fs.mkdir(path.join(p.chats, "memory"), { recursive: true });
    await fs.writeFile(path.join(p.chats, "memory", "MEMORY.md"), "# index\n", "utf8");
    // And something nobody enumerated.
    await fs.writeFile(path.join(p.chats, "notes.txt"), "hello\n", "utf8");

    const plan = await buildMigrationPlan(input([p]));
    const entry = plan.projects[0];
    const row = entry.chats[0];

    expect(row.extras).toEqual(
      expect.arrayContaining([
        path.join(p.chats, id, "subagents"),
        path.join(p.chats, id, "tool-results"),
        path.join(p.chats, ".reverts", `${id}-1738000000000.jsonl`),
      ]),
    );
    expect(row.extras).not.toContain(path.join(p.chats, ".reverts", "other-9999999999999.jsonl"));

    expect(entry.projectExtras).toEqual(
      expect.arrayContaining([
        path.join(p.chats, "memory"),
        path.join(p.chats, "agent-deadbeef.jsonl"),
      ]),
    );
    // The preserve dir is a SIBLING of `.chats/`, never a child (§5.1).
    expect(entry.preserveDir).toBe(path.join(p.dir, PRESERVE_DIR_NAME));
    // …and note it is a string PREFIX of `.chats` while not being inside it,
    // which is what a naive `startsWith` containment check gets wrong.
    expect(entry.preserveDir.startsWith(p.chats)).toBe(true);
    expect(entry.preserveDir.startsWith(p.chats + path.sep)).toBe(false);

    const unexpected = plan.warnings.find((w) => w.code === "unexpected-entries");
    expect(unexpected?.paths).toEqual([path.join(p.chats, "notes.txt")]);
  });

  it("gives a revert to the longest matching chat id, not the first", async () => {
    // `.reverts/` is one shared directory and a session id may itself contain
    // dashes, so `<id>-<stamp>.jsonl` is genuinely ambiguous: `chat-1` is a
    // prefix of `chat-1-b`. Splitting on the first dash hands `chat-1-b`'s
    // reverts to `chat-1`, and a partial migration then moves them to the
    // wrong side.
    const p = await project("acme");
    await writeLines(path.join(p.chats, "chat-1.jsonl"), transcriptLines("chat-1", 2));
    await writeLines(path.join(p.chats, "chat-1-b.jsonl"), transcriptLines("chat-1-b", 2));
    await writeLines(path.join(p.chats, ".reverts", "chat-1-b-1738000000000.jsonl"), ["{}"]);
    await writeLines(path.join(p.chats, ".reverts", "gone-1738000000001.jsonl"), ["{}"]);

    const plan = await buildMigrationPlan(input([p]));
    const byId = new Map(rowsOf(plan).map((r) => [r.sessionId, r]));
    expect(byId.get("chat-1")?.extras).toEqual([]);
    expect(byId.get("chat-1-b")?.extras).toEqual([
      path.join(p.chats, ".reverts", "chat-1-b-1738000000000.jsonl"),
    ]);
    // A revert whose chat is gone still has to leave `.chats/`.
    expect(plan.projects[0].projectExtras).toContain(
      path.join(p.chats, ".reverts", "gone-1738000000001.jsonl"),
    );
  });

  it("warns about a memory file that already exists in the user's own home", async () => {
    const p = await project("acme");
    await writeLines(path.join(p.chats, "c1.jsonl"), transcriptLines("c1", 2));
    await fs.mkdir(path.join(p.chats, "memory"), { recursive: true });
    await fs.writeFile(path.join(p.chats, "memory", "MEMORY.md"), "paddock's\n", "utf8");
    await fs.writeFile(path.join(p.chats, "memory", "only-here.md"), "mine\n", "utf8");
    await fs.mkdir(path.join(p.host, "memory"), { recursive: true });
    await fs.writeFile(path.join(p.host, "memory", "MEMORY.md"), "the user's own\n", "utf8");

    const plan = await buildMigrationPlan(input([p]));
    const warn = plan.warnings.find((w) => w.code === "memory-collision");
    expect(warn).toBeDefined();
    expect(warn?.slug).toBe("acme");
    // Source and destination, in pairs, so the summary can name both.
    expect(warn?.paths).toEqual([
      path.join(p.chats, "memory", "MEMORY.md"),
      path.join(p.host, "memory", "MEMORY.md"),
    ]);
  });

  it("keeps the root workspace, whose slug is the empty string", async () => {
    // `if (!slug)` drops it. Every filter and lookup in the plan has to test
    // for undefined explicitly, or the one workspace every instance has goes
    // missing from the migration.
    const root = await project("", "Root");
    await writeLines(path.join(root.chats, "r1.jsonl"), transcriptLines("r1", 3));

    const plan = await buildMigrationPlan(input([root]));
    expect(plan.projects).toHaveLength(1);
    expect(plan.projects[0].slug).toBe("");
    expect(plan.projects[0].chats).toHaveLength(1);
  });

  it("classifies a project as unknown when its host store cannot be read", async () => {
    const p = await project("acme");
    await writeLines(path.join(p.chats, "c1.jsonl"), transcriptLines("c1", 3));
    // A file where the store directory should be: readdir fails with ENOTDIR,
    // which is neither "no history here" nor something to guess through.
    await fs.mkdir(path.dirname(p.host), { recursive: true });
    await fs.writeFile(p.host, "not a directory\n", "utf8");

    const plan = await buildMigrationPlan(input([p]));
    expect(plan.warnings.map((w) => w.code)).toContain("host-store-unreadable");
    // NOT `new`: defaulting a row to CHECKED on the strength of a read that
    // failed is the one direction that can lose data.
    expect(rowsOf(plan)[0].state).toBe("unknown");
    expect(rowsOf(plan)[0].defaultSelected).toBe(false);
  });

  it("skips a `.chats/` that is already a symlink at the host store", async () => {
    const p = await project("acme");
    await fs.rm(p.chats, { recursive: true, force: true });
    await fs.mkdir(p.host, { recursive: true });
    await fs.symlink(p.host, p.chats);

    const plan = await buildMigrationPlan(input([p]));
    expect(plan.projects).toHaveLength(0);
    expect((await probeMigration(input([p]))).eligible).toBe(false);
  });

  it("counts sweeper stores without giving them rows", async () => {
    const p = await project("acme");
    await writeLines(path.join(p.chats, "c1.jsonl"), transcriptLines("c1", 2));
    const sweeper = path.join(tmp, "data", "sweepers", "acme");
    await writeLines(path.join(sweeper, ".chats", "s1.jsonl"), transcriptLines("s1", 2));
    await writeLines(path.join(sweeper, ".chats", "s2.jsonl"), transcriptLines("s2", 2));

    const plan = await buildMigrationPlan(
      input([p], { sweeperDirs: new Map([["acme", sweeper]]) }),
    );
    expect(plan.sweepers).toEqual({ stores: 1, chats: 2 });
    expect(rowsOf(plan).map((r) => r.sessionId)).toEqual(["c1"]);
  });

  /* ---------------------------------------------------------------------- */
  /* the banner probe                                                        */
  /* ---------------------------------------------------------------------- */

  describe("the banner probe", () => {
    it("§10.1 regression: is eligible when NOTHING is new — every chat exists on both sides", async () => {
      // The case the first draft of the design was blind to, and the whole
      // reason §10.1 exists. Someone adopts their CLI history into Paddock and
      // then works in both places: every session id is present in the host
      // store, so a probe that short-circuits on "present in `.chats/` and
      // absent from the host store" finds ZERO and never shows the banner —
      // to precisely the user #882 was opened for.
      const p = await project("acme");
      for (const id of ["adopted-1", "adopted-2"]) {
        const shared = transcriptLines(id, 4);
        await writeLines(path.join(p.chats, `${id}.jsonl`), [
          ...shared,
          ...transcriptLines(id, 2, "own"),
        ]);
        await writeLines(path.join(p.host, `${id}.jsonl`), [
          ...shared,
          ...transcriptLines(id, 3, "host"),
        ]);
      }

      const probe = await probeMigration(input([p]));
      expect(probe.eligible).toBe(true);
      expect(probe.reason).toBeUndefined();
      expect(probe.pendingProjects).toBe(1);
      expect(probe.pendingChats).toBe(2);

      // And the control the regression needs: the plan agrees there is work,
      // and none of it is `new`.
      const plan = await buildMigrationPlan(input([p]));
      expect(plan.totals.new).toBe(0);
      expect(plan.totals.chats).toBe(2);
    });

    it("is eligible for a chat that is IDENTICAL on both sides", async () => {
      // The sharper half of the same correction: identity means no decision,
      // not no work. The entry still has to leave `.chats/` for the redirect
      // symlink to be planted at all.
      const p = await project("acme");
      const same = transcriptLines("same-1", 5);
      await writeLines(path.join(p.chats, "same-1.jsonl"), same);
      await writeLines(path.join(p.host, "same-1.jsonl"), same);
      const when = new Date("2026-02-02T02:02:02Z");
      await fs.utimes(path.join(p.chats, "same-1.jsonl"), when, when);
      await fs.utimes(path.join(p.host, "same-1.jsonl"), when, when);

      const probe = await probeMigration(input([p]));
      expect(probe.eligible).toBe(true);

      // …and the plan has no rows at all, which is the state that makes the
      // banner and the table disagree unless the probe is entry-based.
      const plan = await buildMigrationPlan(input([p]));
      expect(plan.totals.chats).toBe(0);
      expect(plan.totals.identical).toBe(1);
    });

    it("is eligible for a `.chats/` holding only agent memory, with pendingChats 0", async () => {
      const p = await project("acme");
      await fs.mkdir(path.join(p.chats, "memory"), { recursive: true });
      await fs.writeFile(path.join(p.chats, "memory", "MEMORY.md"), "# index\n", "utf8");

      const probe = await probeMigration(input([p]));
      expect(probe.eligible).toBe(true);
      // Eligibility is about ENTRIES; the count is about TRANSCRIPTS. A client
      // that keys the banner off the count hides it here.
      expect(probe.pendingChats).toBe(0);
    });

    it("reports nothing-pending for an empty `.chats/`", async () => {
      const p = await project("acme");
      const probe = await probeMigration(input([p]));
      expect(probe.eligible).toBe(false);
      expect(probe.reason).toBe("nothing-pending");
      expect(probe.scannedProjects).toBe(1);
    });

    it("refuses on env-shadowed and paranoid, in that precedence", async () => {
      const p = await project("acme");
      await writeLines(path.join(p.chats, "c1.jsonl"), transcriptLines("c1", 3));

      expect(await probeMigration(input([p], { envShadowed: true }))).toMatchObject({
        eligible: false,
        reason: "env-shadowed",
        envVar: "PADDOCK_CLAUDE_TRANSCRIPTS",
      });
      expect(await probeMigration(input([p], { profile: "paranoid" }))).toMatchObject({
        eligible: false,
        reason: "profile-paranoid",
      });
      // A blocking condition beats a posture one: the write would be inert
      // either way, and that is the thing the user needs told.
      expect(
        await probeMigration(input([p], { envShadowed: true, profile: "paranoid" })),
      ).toMatchObject({ reason: "env-shadowed" });
    });

    /* -------------------------------------------------------------------- */
    /* eligibility under `host` — the four cases (#708/#882 §2)              */
    /* -------------------------------------------------------------------- */

    describe("under `host`, eligibility is about the DIRECTORY, not the mode", () => {
      // `host` shipped as an unconditional refusal. That is right for the two
      // healthy shapes and wrong for the stranded one, which is #708 itself:
      // `pointChatsDirAt` declines the redirect against a non-empty real
      // `.chats/`, so the transcripts sit there unreachable — and the probe told
      // exactly those users there was nothing to do.

      it("is ELIGIBLE for a stranded `.chats/`: a non-empty REAL directory", async () => {
        const p = await project("acme");
        for (const id of ["stranded-1", "stranded-2"]) {
          await writeLines(path.join(p.chats, `${id}.jsonl`), transcriptLines(id, 4));
        }

        const probe = await probeMigration(input([p], { mode: "host" }));
        expect(probe.eligible).toBe(true);
        expect(probe.reason).toBeUndefined();
        expect(probe.mode).toBe("host");
        expect(probe.pendingChats).toBe(2);

        // The control the bug needs: the plan endpoint could ALWAYS see these
        // chats. Only the probe refused, which is why the banner never showed.
        const plan = await buildMigrationPlan(input([p], { mode: "host" }));
        expect(plan.totals.chats).toBe(2);
      });

      it("is NOT eligible for a healthy `.chats` SYMLINK into the host store", async () => {
        // The overwhelmingly common `host` instance. `lstat`, not `stat`: the
        // link resolves to a directory full of transcripts, so a `stat`-based
        // check would call every migrated user stranded and show them all a
        // banner — worse than the bug being fixed.
        const p = await project("acme");
        await fs.rm(p.chats, { recursive: true, force: true });
        await fs.mkdir(p.host, { recursive: true });
        await writeLines(path.join(p.host, "migrated-1.jsonl"), transcriptLines("migrated-1", 4));
        await fs.symlink(p.host, p.chats);

        // The link really does resolve to a non-empty directory — otherwise
        // this test would pass for the wrong reason.
        expect((await fs.readdir(p.chats)).length).toBeGreaterThan(0);

        const probe = await probeMigration(input([p], { mode: "host" }));
        expect(probe.eligible).toBe(false);
        expect(probe.reason).toBe("already-host");
      });

      it("is NOT eligible for an EMPTY real `.chats/` under host", async () => {
        // Migrated, restart pending: the next boot finds it empty, plants the
        // redirect and finishes on its own. Nothing to offer.
        const p = await project("acme");
        const probe = await probeMigration(input([p], { mode: "host" }));
        expect(probe.eligible).toBe(false);
        expect(probe.reason).toBe("already-host");
      });

      it("leaves `own` exactly as it was", async () => {
        const p = await project("acme");
        expect(await probeMigration(input([p]))).toMatchObject({
          eligible: false,
          reason: "nothing-pending",
        });
        await writeLines(path.join(p.chats, "c1.jsonl"), transcriptLines("c1", 3));
        expect(await probeMigration(input([p]))).toMatchObject({
          eligible: true,
          mode: "own",
          pendingChats: 1,
        });
      });

      it("still refuses a stranded `host` instance whose env var shadows the key", async () => {
        // Not narrowed: the execute ROUTE 400s on `env_shadowed` before anything
        // moves, so an eligible probe here would be a banner leading nowhere.
        const p = await project("acme");
        await writeLines(path.join(p.chats, "c1.jsonl"), transcriptLines("c1", 3));
        expect(
          await probeMigration(input([p], { mode: "host", envShadowed: true })),
        ).toMatchObject({ eligible: false, reason: "env-shadowed" });
      });

      it("offers a stranded `paranoid` instance the recovery anyway", async () => {
        // §10.4 suppresses the banner so a `paranoid` posture is not nagged into
        // flipping. Under `host` there is no flip to nag about — the instance
        // already IS `host` and this only makes its own chats readable again.
        const p = await project("acme");
        await writeLines(path.join(p.chats, "c1.jsonl"), transcriptLines("c1", 3));
        expect(
          await probeMigration(input([p], { mode: "host", profile: "paranoid" })),
        ).toMatchObject({ eligible: true });
        // …and the `own` suppression it exists for is untouched.
        expect(await probeMigration(input([p], { profile: "paranoid" }))).toMatchObject({
          eligible: false,
          reason: "profile-paranoid",
        });
      });
    });

    it("notices a new chat through the memoised answer", async () => {
      // The cache key is `mtimeMs:size` of `.chats/` plus the config version.
      // Adding a file changes the directory's own mtime, so a stale `false`
      // must not survive it — that would be a banner that never appears.
      const p = await project("acme");
      expect((await probeMigration(input([p]))).eligible).toBe(false);
      await writeLines(path.join(p.chats, "c1.jsonl"), transcriptLines("c1", 3));
      expect((await probeMigration(input([p]))).eligible).toBe(true);
    });
  });
});
