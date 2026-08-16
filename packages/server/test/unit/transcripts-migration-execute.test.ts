import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  executeMigration,
  type MigrationExecuteInput,
  type MigrationExecuteResult,
} from "../../src/transcripts-migration-execute.js";
import { encodeProjectDir } from "../../src/transcripts.js";
import { PRESERVE_DIR_NAME } from "../../src/transcripts-migration.js";
import { moveEntry, DestinationExistsError } from "../../src/transcript-move.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * The `own → host` migration EXECUTE half (#882), against real directory shapes.
 *
 * Everything is built on disk rather than mocked, for the reason the preview
 * suite gives and one more: this module's whole job is to move files, so a
 * mocked filesystem would be asserting that the mock agrees with itself. The
 * assertions that matter here are about what is on disk AFTERWARDS — which copy
 * survived, where the other one went, and whether anything vanished.
 *
 * Every scenario asserts {@link countFiles} did not DROP. That one is not
 * implied by the others: a migration that silently unlinked a superseded copy
 * would pass "the survivor is in the host store" and "`.chats/` is empty" and
 * fail only this. "Nothing is ever deleted" is the promise the whole modal
 * rests on, so it is asserted literally rather than inferred.
 *
 * The `~/.claude` here is a throwaway directory under the temp root. On this
 * box `$HOME` is a real Claude home holding thousands of real transcripts and a
 * hand-curated `memory/MEMORY.md`, and this module MOVES FILES INTO the home it
 * is given. `userHome` never resolves anywhere near the real one.
 */
describe("own → host migration execute (#882)", () => {
  let tmp: string;
  let userHome: string;
  let projectsRoot: string;
  let configPath: string;
  /** What `commitConfig` recorded, so the commit point can be asserted. */
  let commits: number;

  beforeEach(async () => {
    tmp = await makeTmpDir("paddock-migrate-exec-");
    userHome = path.join(tmp, "home", ".claude");
    projectsRoot = path.join(tmp, "projects");
    configPath = path.join(tmp, "paddock.config.yaml");
    commits = 0;
    await fs.mkdir(userHome, { recursive: true });
  });

  afterEach(async () => {
    await rmTmpDir(tmp);
  });

  /* ---------------------------------------------------------------------- */
  /* fixtures                                                                */
  /* ---------------------------------------------------------------------- */

  /** An append-only, uuid-chained transcript. `tag` forks the chain. */
  function lines(sessionId: string, count: number, tag = "a", from = 0): string[] {
    const out: string[] = [];
    for (let i = from; i < from + count; i++) {
      out.push(
        JSON.stringify({
          type: i % 2 === 0 ? "user" : "assistant",
          uuid: `${tag}-${sessionId}-${i}`,
          parentUuid: i === 0 ? null : `${tag}-${sessionId}-${i - 1}`,
          sessionId,
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
          message: {
            role: i % 2 === 0 ? "user" : "assistant",
            content: `turn ${i} ${"x".repeat(64)}`,
          },
        }),
      );
    }
    return out;
  }

  async function write(file: string, body: string[]): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body.join("\n") + "\n", "utf8");
  }

  interface Project {
    slug: string;
    name: string;
    dir: string;
    workingDir: string;
    chats: string;
    host: string;
    preserve: string;
  }

  async function project(slug = "acme"): Promise<Project> {
    const dir = path.join(projectsRoot, slug || "_root");
    const chats = path.join(dir, ".chats");
    await fs.mkdir(chats, { recursive: true });
    return {
      slug,
      name: slug || "Root",
      dir,
      workingDir: dir,
      chats,
      host: path.join(userHome, "projects", encodeProjectDir(dir)),
      preserve: path.join(dir, PRESERVE_DIR_NAME),
    };
  }

  /** Every regular file under `root`, by path. */
  async function listFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(full);
      }
    };
    await walk(root);
    return out.sort();
  }

  /**
   * How many files exist anywhere the migration can reach. The number must
   * never go DOWN — see the suite doc.
   */
  async function countFiles(): Promise<number> {
    return (await listFiles(tmp)).length;
  }

  function input(
    projects: Project[],
    over: Partial<MigrationExecuteInput> = {},
  ): MigrationExecuteInput {
    return {
      mode: "own",
      profile: "balanced",
      envShadowed: false,
      projects: projects.map((p) => ({
        slug: p.slug,
        name: p.name,
        dir: p.dir,
        workingDir: p.workingDir,
      })),
      userHome,
      configPath,
      configVersion: "v1",
      sessionIds: [],
      pendingMode: "own",
      commitConfig: async () => {
        commits++;
        await fs.writeFile(configPath, "claude:\n  transcripts: host\n", "utf8");
        return "v2";
      },
      ...over,
    };
  }

  const exists = (p: string) =>
    fs
      .lstat(p)
      .then(() => true)
      .catch(() => false);

  const read = (p: string) => fs.readFile(p, "utf8");

  /** Run, asserting the one invariant every scenario shares. */
  async function run(
    projects: Project[],
    over: Partial<MigrationExecuteInput> = {},
  ): Promise<MigrationExecuteResult> {
    const before = await countFiles();
    const result = await executeMigration(input(projects, over));
    const after = await countFiles();
    expect(after, "a file disappeared — nothing is ever deleted").toBeGreaterThanOrEqual(before);
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /* the survivor table, one test per row                                    */
  /* ---------------------------------------------------------------------- */

  it("row `new`: Paddock's copy is the survivor and nothing is preserved", async () => {
    const p = await project();
    await write(path.join(p.chats, "n1.jsonl"), lines("n1", 6));

    const r = await run([p], { sessionIds: ["n1"] });

    expect(r.migrated).toEqual(["n1"]);
    expect(r.preserved).toEqual([]);
    expect(await exists(path.join(p.host, "n1.jsonl"))).toBe(true);
    expect(await fs.readdir(p.chats)).toEqual([]);
    expect(r.projects[0]).toMatchObject({ outcome: "migrated", chatsDirEmpty: true });
    expect(r.configWritten).toBe(true);
  });

  it("row `identical`: the user's copy survives, Paddock's goes to the preserve dir", async () => {
    const p = await project();
    const same = lines("id1", 5);
    await write(path.join(p.chats, "id1.jsonl"), same);
    await write(path.join(p.host, "id1.jsonl"), same);
    const when = new Date("2026-03-03T03:03:03Z");
    await fs.utimes(path.join(p.chats, "id1.jsonl"), when, when);
    await fs.utimes(path.join(p.host, "id1.jsonl"), when, when);

    // NOT ticked, and not tickable: an identical chat is never offered a row.
    const r = await run([p], { sessionIds: [] });

    expect(r.migrated).toEqual([]);
    expect(r.preserved).toEqual([
      {
        sessionId: "id1",
        slug: "acme",
        side: "own",
        path: path.join(p.preserve, "id1.jsonl"),
        reason: "identical",
      },
    ]);
    expect(await read(path.join(p.host, "id1.jsonl"))).toBe(same.join("\n") + "\n");
    expect(await fs.readdir(p.chats)).toEqual([]);
    expect(r.configWritten).toBe(true);
  });

  it("row `fast-forward`, host ahead: the user's descendant survives, Paddock's ancestor is preserved", async () => {
    const p = await project();
    const base = lines("ff1", 4);
    const ahead = [...base, ...lines("ff1", 6, "a", 4)];
    await write(path.join(p.chats, "ff1.jsonl"), base);
    await write(path.join(p.host, "ff1.jsonl"), ahead);

    // Ticked — and ticking must NOT move an ancestor over its descendant.
    const r = await run([p], { sessionIds: ["ff1"] });

    expect(r.migrated).toEqual([]);
    expect(r.preserved).toMatchObject([{ sessionId: "ff1", side: "own", reason: "already-ahead" }]);
    expect(await read(path.join(p.host, "ff1.jsonl"))).toBe(ahead.join("\n") + "\n");
    expect(await read(path.join(p.preserve, "ff1.jsonl"))).toBe(base.join("\n") + "\n");
    expect(await fs.readdir(p.chats)).toEqual([]);
  });

  it("row `fast-forward`, own ahead: the user's ancestor is preserved FIRST, then Paddock's lands", async () => {
    const p = await project();
    const base = lines("ff2", 4);
    const ahead = [...base, ...lines("ff2", 6, "a", 4)];
    await write(path.join(p.chats, "ff2.jsonl"), ahead);
    await write(path.join(p.host, "ff2.jsonl"), base);

    const r = await run([p], { sessionIds: ["ff2"] });

    expect(r.migrated).toEqual(["ff2"]);
    expect(r.preserved).toMatchObject([{ sessionId: "ff2", side: "host", reason: "superseded" }]);
    // The survivor is in the store…
    expect(await read(path.join(p.host, "ff2.jsonl"))).toBe(ahead.join("\n") + "\n");
    // …and the ancestor is intact in the preserve dir, not gone.
    expect(await read(path.join(p.preserve, "ff2.jsonl"))).toBe(base.join("\n") + "\n");
    expect(await fs.readdir(p.chats)).toEqual([]);
  });

  it("row `diverged`, ticked: the user's copy is preserved FIRST, then Paddock's lands", async () => {
    const p = await project();
    const shared = lines("dv1", 4);
    const own = [...shared, ...lines("dv1", 2, "own", 4)];
    const host = [...shared, ...lines("dv1", 5, "host", 4)];
    await write(path.join(p.chats, "dv1.jsonl"), own);
    await write(path.join(p.host, "dv1.jsonl"), host);

    const r = await run([p], { sessionIds: ["dv1"] });

    expect(r.migrated).toEqual(["dv1"]);
    expect(r.preserved).toMatchObject([{ sessionId: "dv1", side: "host", reason: "superseded" }]);
    expect(await read(path.join(p.host, "dv1.jsonl"))).toBe(own.join("\n") + "\n");
    expect(await read(path.join(p.preserve, "dv1.jsonl"))).toBe(host.join("\n") + "\n");
    expect(await fs.readdir(p.chats)).toEqual([]);
  });

  it("row `diverged`, unticked: the user's copy survives untouched, Paddock's is preserved", async () => {
    const p = await project();
    const shared = lines("dv2", 4);
    const own = [...shared, ...lines("dv2", 2, "own", 4)];
    const host = [...shared, ...lines("dv2", 5, "host", 4)];
    await write(path.join(p.chats, "dv2.jsonl"), own);
    await write(path.join(p.host, "dv2.jsonl"), host);

    const r = await run([p], { sessionIds: [] });

    expect(r.migrated).toEqual([]);
    expect(r.preserved).toMatchObject([{ sessionId: "dv2", side: "own", reason: "unchecked" }]);
    expect(await read(path.join(p.host, "dv2.jsonl"))).toBe(host.join("\n") + "\n");
    expect(await read(path.join(p.preserve, "dv2.jsonl"))).toBe(own.join("\n") + "\n");
    expect(await fs.readdir(p.chats)).toEqual([]);
  });

  /* ---------------------------------------------------------------------- */
  /* the ruling                                                              */
  /* ---------------------------------------------------------------------- */

  it("the skip-if-present deadlock: every chat on both sides, nothing new, still succeeds", async () => {
    // The instance §10.1 describes: the user adopted their whole CLI history
    // into Paddock and then kept working in both places. ZERO chats are `new`.
    //
    // On the design as originally written this migration cannot succeed at all:
    // §4.2 makes the move skip-if-present, so every destination exists, every
    // move skips, every file stays in `.chats/`, every project reports
    // `chatsDirEmpty: false`, and the config is never written. The feature fails
    // hardest for the person it was designed around. This test is the ruling
    // that replaced that rule.
    const p = await project();
    const shared = lines("z", 4);
    for (let i = 0; i < 6; i++) {
      const id = `both-${i}`;
      const base = lines(id, 4);
      if (i % 3 === 0) {
        // identical
        await write(path.join(p.chats, `${id}.jsonl`), base);
        await write(path.join(p.host, `${id}.jsonl`), base);
        const when = new Date(Date.UTC(2026, 2, 3, 3, i));
        await fs.utimes(path.join(p.chats, `${id}.jsonl`), when, when);
        await fs.utimes(path.join(p.host, `${id}.jsonl`), when, when);
      } else if (i % 3 === 1) {
        // fast-forward, own ahead
        await write(path.join(p.chats, `${id}.jsonl`), [...base, ...lines(id, 3, "a", 4)]);
        await write(path.join(p.host, `${id}.jsonl`), base);
      } else {
        // diverged
        await write(path.join(p.chats, `${id}.jsonl`), [...shared, ...lines(id, 2, "own", 4)]);
        await write(path.join(p.host, `${id}.jsonl`), [...shared, ...lines(id, 5, "host", 4)]);
      }
    }

    const before = await listFiles(tmp);
    const r = await run([p], {
      sessionIds: ["both-0", "both-1", "both-2", "both-3", "both-4", "both-5"],
    });

    expect(r.ok).toBe(true);
    expect(r.configWritten).toBe(true);
    expect(commits).toBe(1);
    expect(r.projects[0]).toMatchObject({ outcome: "migrated", chatsDirEmpty: true });
    expect(await fs.readdir(p.chats)).toEqual([]);
    // Six chats in, twelve files out: every superseded or redundant copy is
    // still on disk somewhere.
    expect((await listFiles(tmp)).length).toBe(before.length + 1); // +1 = the config file
  });

  /* ---------------------------------------------------------------------- */
  /* idempotency, and the postcondition gate                                 */
  /* ---------------------------------------------------------------------- */

  it("a second POST is alreadyMigrated and moves nothing", async () => {
    const p = await project();
    await write(path.join(p.chats, "n1.jsonl"), lines("n1", 6));

    const first = await run([p], { sessionIds: ["n1"] });
    expect(first.configWritten).toBe(true);

    const snapshot = await listFiles(tmp);
    // The config file now says `host`; the running process is still `own` until
    // the restart, which is exactly the window a repeat POST arrives in.
    const second = await run([p], { sessionIds: ["n1"], pendingMode: "host" });

    expect(second.alreadyMigrated).toBe(true);
    expect(second.migrated).toEqual([]);
    expect(second.preserved).toEqual([]);
    expect(second.configWritten).toBe(false);
    expect(commits).toBe(1);
    // …and it still asks for the restart the first call earned.
    expect(second.restartRequired).toBe(true);
    expect(await listFiles(tmp)).toEqual(snapshot);
  });

  /* ---------------------------------------------------------------------- */
  /* the stranded `host` recovery (#708's other half, #882 §2)               */
  /* ---------------------------------------------------------------------- */

  it("under `host`, a stranded store is recovered: files move, no config is written", async () => {
    // The instance flipped to `host` while `.chats/` was non-empty, so
    // `pointChatsDirAt` declined the redirect and the transcripts are
    // unreachable. There is no flip left to make — the run is a RECOVERY, and
    // its success cannot be measured by a config write that is correctly
    // skipped.
    const p = await project();
    await write(path.join(p.chats, "s1.jsonl"), lines("s1", 6));
    await write(path.join(p.chats, "s2.jsonl"), lines("s2", 4));

    const r = await run([p], {
      mode: "host",
      pendingMode: "host",
      sessionIds: ["s1", "s2"],
    });

    // The files moved into the host store…
    expect(r.migrated.sort()).toEqual(["s1", "s2"]);
    expect(await exists(path.join(p.host, "s1.jsonl"))).toBe(true);
    expect(await exists(path.join(p.host, "s2.jsonl"))).toBe(true);
    // …`.chats/` is empty, which is what lets the next boot plant the redirect…
    expect(r.projects[0].chatsDirEmpty).toBe(true);
    expect(await fs.readdir(p.chats)).toEqual([]);
    // …the config write is skipped, because the config already says `host`…
    expect(r.configWritten).toBe(false);
    expect(commits).toBe(0);
    // …a restart is still required, because the redirect is planted at boot…
    expect(r.restartRequired).toBe(true);
    // …this is NOT the no-op second POST: real work happened.
    expect(r.alreadyMigrated).toBe(false);
    // …and the run reports success. `ok` keyed on `configWritten` alone made a
    // recovery that moved every stranded chat report failure, while the dry run
    // that predicted it reported success.
    expect(r.ok).toBe(true);
  });

  it("under `host`, a dry run and the real run agree", async () => {
    const p = await project();
    await write(path.join(p.chats, "s1.jsonl"), lines("s1", 6));

    const dry = await run([p], {
      mode: "host",
      pendingMode: "host",
      sessionIds: ["s1"],
      dryRun: true,
    });
    expect(dry.ok).toBe(true);
    expect(await exists(path.join(p.chats, "s1.jsonl"))).toBe(true); // untouched

    const real = await run([p], { mode: "host", pendingMode: "host", sessionIds: ["s1"] });
    expect(real.ok).toBe(dry.ok);
    expect(real.migrated).toEqual(dry.migrated);
  });

  it("under `host`, a stranded store that cannot be drained still reports failure", async () => {
    // The control for the two above: `ok` under `host` is not a rubber stamp.
    const p = await project();
    await write(path.join(p.chats, "s1.jsonl"), lines("s1", 4));
    await fs.mkdir(path.dirname(p.host), { recursive: true });
    await fs.writeFile(p.host, "not a directory", "utf8");

    const r = await run([p], { mode: "host", pendingMode: "host", sessionIds: ["s1"] });

    expect(r.ok).toBe(false);
    expect(r.projects[0].chatsDirEmpty).toBe(false);
    expect(r.failed.length).toBeGreaterThan(0);
  });

  it("a non-empty `.chats/` blocks the config write for the WHOLE instance", async () => {
    const a = await project("acme");
    const b = await project("beta");
    await write(path.join(a.chats, "a1.jsonl"), lines("a1", 4));
    await write(path.join(b.chats, "b1.jsonl"), lines("b1", 4));
    // Beta cannot move anything: its host store PATH is occupied by a regular
    // file, so both the readdir and every destination mkdir under it fail with
    // ENOTDIR. A real shape — `~/.claude/projects/<enc>` is a path Paddock does
    // not own — and deterministic, unlike a permissions trick that root ignores.
    await fs.mkdir(path.dirname(b.host), { recursive: true });
    await fs.writeFile(b.host, "not a directory", "utf8");

    const r = await run([a, b], { sessionIds: ["a1", "b1"] });

    // acme is clean, but the instance-global commit is refused all the same.
    expect(r.projects.find((x) => x.slug === "acme")?.chatsDirEmpty).toBe(true);
    expect(r.configWritten).toBe(false);
    expect(commits).toBe(0);
    expect(r.ok).toBe(false);
  });

  /* ---------------------------------------------------------------------- */
  /* the crash the design claims is safe                                     */
  /* ---------------------------------------------------------------------- */

  it("a crash between the moves and the config write reconciles on a re-run", async () => {
    const p = await project();
    await write(path.join(p.chats, "c1.jsonl"), lines("c1", 6));
    await write(path.join(p.chats, "c2.jsonl"), lines("c2", 6));

    // §4.1 claims the ordering makes this safe. Prove it rather than trust it:
    // the files move, the commit throws, and the instance is left mid-flight.
    const crashed = await run([p], {
      sessionIds: ["c1", "c2"],
      commitConfig: async () => {
        throw new Error("SIGKILL between step 5 and step 6");
      },
    });
    expect(crashed.configWritten).toBe(false);
    expect(crashed.migrated.sort()).toEqual(["c1", "c2"]);
    expect(crashed.failed).toHaveLength(1);
    // The on-disk state is the "transient blank list" the design says it is:
    // files in the store, `.chats/` empty, config still `own`.
    expect(await fs.readdir(p.chats)).toEqual([]);
    expect(await exists(path.join(p.host, "c1.jsonl"))).toBe(true);

    const rerun = await run([p], { sessionIds: ["c1", "c2"] });
    expect(rerun.configWritten).toBe(true);
    expect(rerun.migrated).toEqual([]); // nothing left to move
    expect(rerun.failed).toEqual([]);
    expect(rerun.ok).toBe(true);
  });

  /* ---------------------------------------------------------------------- */
  /* sidecars, memory, and the postcondition's long tail                     */
  /* ---------------------------------------------------------------------- */

  it("moves a chat's `<id>/` and its prefix-matched reverts, and nobody else's", async () => {
    const p = await project();
    await write(path.join(p.chats, "s1.jsonl"), lines("s1", 4));
    await write(path.join(p.chats, "s1-extra.jsonl"), lines("s1-extra", 4));
    await write(path.join(p.chats, "s1", "subagents", "agent-9.jsonl"), ["{}"]);
    await fs.mkdir(path.join(p.chats, "s1", "tool-results"), { recursive: true });
    await fs.writeFile(path.join(p.chats, "s1", "tool-results", "r.json"), "{}", "utf8");
    await write(path.join(p.chats, ".reverts", "s1-1738000000000.jsonl"), ["{}"]);
    await write(path.join(p.chats, ".reverts", "s1-extra-1738000000001.jsonl"), ["{}"]);

    // Only `s1` is ticked — its longer-named neighbour must keep its own revert.
    const r = await run([p], { sessionIds: ["s1"] });

    expect(r.migrated).toEqual(["s1"]);
    expect(await exists(path.join(p.host, "s1", "subagents", "agent-9.jsonl"))).toBe(true);
    expect(await exists(path.join(p.host, "s1", "tool-results", "r.json"))).toBe(true);
    expect(await exists(path.join(p.host, ".reverts", "s1-1738000000000.jsonl"))).toBe(true);
    // The unticked neighbour's revert went with IT, to the preserve dir — not
    // with `s1`, whose id is a prefix of its own.
    expect(await exists(path.join(p.preserve, ".reverts", "s1-extra-1738000000001.jsonl"))).toBe(
      true,
    );
    expect(await exists(path.join(p.host, ".reverts", "s1-extra-1738000000001.jsonl"))).toBe(false);
    // The postcondition holds even though `.reverts/` is now an empty shell.
    expect(await fs.readdir(p.chats)).toEqual([]);
  });

  it("merges `memory/` per file, setting aside collisions instead of overwriting", async () => {
    const p = await project();
    await write(path.join(p.chats, "m1.jsonl"), lines("m1", 4));
    await fs.mkdir(path.join(p.chats, "memory"), { recursive: true });
    await fs.writeFile(path.join(p.chats, "memory", "MEMORY.md"), "# paddock's index\n", "utf8");
    await fs.writeFile(path.join(p.chats, "memory", "only-ours.md"), "ours\n", "utf8");
    // The user already ran `claude` in this directory from a terminal.
    await fs.mkdir(path.join(p.host, "memory"), { recursive: true });
    await fs.writeFile(path.join(p.host, "memory", "MEMORY.md"), "# the user's own\n", "utf8");

    const r = await run([p], { sessionIds: ["m1"] });

    // The user's hand-curated index is byte-for-byte what it was.
    expect(await read(path.join(p.host, "memory", "MEMORY.md"))).toBe("# the user's own\n");
    // Paddock's is beside it, not on top of it, and named in the response.
    expect(await read(path.join(p.preserve, "memory", "MEMORY.md"))).toBe("# paddock's index\n");
    // A file with no counterpart just moves.
    expect(await read(path.join(p.host, "memory", "only-ours.md"))).toBe("ours\n");
    expect(r.warnings.map((w) => w.code)).toContain("memory-collision");
    expect(await fs.readdir(p.chats)).toEqual([]);
    expect(r.configWritten).toBe(true);
  });

  it("drains an entry nobody enumerated, so the postcondition fails CLOSED", async () => {
    const p = await project();
    await write(path.join(p.chats, "d1.jsonl"), lines("d1", 4));
    // A sidechain transcript at the top level (45 of these on this box), and
    // something no release has invented yet.
    await write(path.join(p.chats, "agent-beef.jsonl"), ["{}"]);
    await fs.writeFile(path.join(p.chats, "future-feature.db"), "binary", "utf8");

    const r = await run([p], { sessionIds: ["d1"] });

    expect(await fs.readdir(p.chats)).toEqual([]);
    expect(await exists(path.join(p.host, "agent-beef.jsonl"))).toBe(true);
    expect(await exists(path.join(p.host, "future-feature.db"))).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain("unexpected-entries");
    expect(r.configWritten).toBe(true);
  });

  /* ---------------------------------------------------------------------- */
  /* the refusals and the reports                                            */
  /* ---------------------------------------------------------------------- */

  it("skips a project whose turn woke up between the quiesce and its moves, untouched", async () => {
    const p = await project();
    await write(path.join(p.chats, "b1.jsonl"), lines("b1", 4));
    const snapshot = await listFiles(tmp);

    const r = await run([p], {
      sessionIds: ["b1"],
      busySessions: (slug) => (slug === "acme" ? ["b1"] : []),
    });

    expect(r.projects[0]).toMatchObject({ outcome: "skipped-busy", chatsDirEmpty: false });
    expect(r.configWritten).toBe(false);
    expect(await listFiles(tmp)).toEqual(snapshot);
  });

  it("applies an unplanned chat's own default and reports it", async () => {
    const p = await project();
    // Planned and ticked.
    await write(path.join(p.chats, "planned.jsonl"), lines("planned", 4));
    // Created between preview and submit: `new`, so its default is CHECKED.
    await write(path.join(p.chats, "late-new.jsonl"), lines("late-new", 4));
    // Also created late, but diverged: default UNCHECKED.
    const shared = lines("late-div", 4);
    await write(path.join(p.chats, "late-div.jsonl"), [...shared, ...lines("late-div", 2, "o", 4)]);
    await write(path.join(p.host, "late-div.jsonl"), [...shared, ...lines("late-div", 5, "h", 4)]);

    const r = await run([p], {
      sessionIds: ["planned"],
      plannedSessionIds: ["planned"],
    });

    expect(r.migrated.sort()).toEqual(["late-new", "planned"]);
    expect(r.unplanned).toEqual(
      expect.arrayContaining([
        { sessionId: "late-new", slug: "acme", state: "new", action: "migrated" },
        { sessionId: "late-div", slug: "acme", state: "diverged", action: "preserved" },
      ]),
    );
    expect(r.preserved).toMatchObject([
      { sessionId: "late-div", side: "own", reason: "unplanned-diverged" },
    ]);
    expect(await fs.readdir(p.chats)).toEqual([]);
  });

  it("without plannedSessionIds, an untricked chat is a deliberate choice and unplanned is empty", async () => {
    const p = await project();
    await write(path.join(p.chats, "k1.jsonl"), lines("k1", 4));

    const r = await run([p], { sessionIds: [] });

    expect(r.unplanned).toEqual([]);
    expect(r.preserved).toMatchObject([{ sessionId: "k1", reason: "unchecked" }]);
  });

  it("names ids that are not in any `.chats/` rather than dropping them", async () => {
    const p = await project();
    await write(path.join(p.chats, "real.jsonl"), lines("real", 4));

    const r = await run([p], { sessionIds: ["real", "ghost"] });

    expect(r.migrated).toEqual(["real"]);
    expect(r.ignoredSessionIds).toEqual(["ghost"]);
  });

  it("empty sessionIds preserves everything and still flips the lever", async () => {
    const p = await project();
    await write(path.join(p.chats, "e1.jsonl"), lines("e1", 4));
    await write(path.join(p.chats, "e2.jsonl"), lines("e2", 4));

    const r = await run([p], { sessionIds: [] });

    expect(r.migrated).toEqual([]);
    expect(r.preserved).toHaveLength(2);
    expect(await exists(path.join(p.preserve, "e1.jsonl"))).toBe(true);
    expect(await fs.readdir(p.chats)).toEqual([]);
    expect(r.configWritten).toBe(true);
  });

  it("refuses to commit while the env shadows the key, even when everything moved", async () => {
    const p = await project();
    await write(path.join(p.chats, "s.jsonl"), lines("s", 4));

    const r = await run([p], { sessionIds: ["s"], envShadowed: true });

    expect(r.configWritten).toBe(false);
    expect(commits).toBe(0);
    expect(r.warnings.map((w) => w.code)).toContain("env-shadowed");
  });

  /* ---------------------------------------------------------------------- */
  /* dry run                                                                 */
  /* ---------------------------------------------------------------------- */

  it("a dry run predicts the real run and touches nothing", async () => {
    const p = await project();
    await write(path.join(p.chats, "n1.jsonl"), lines("n1", 4));
    const shared = lines("d1", 4);
    await write(path.join(p.chats, "d1.jsonl"), [...shared, ...lines("d1", 2, "o", 4)]);
    await write(path.join(p.host, "d1.jsonl"), [...shared, ...lines("d1", 5, "h", 4)]);
    await fs.mkdir(path.join(p.chats, "memory"), { recursive: true });
    await fs.writeFile(path.join(p.chats, "memory", "MEMORY.md"), "ours\n", "utf8");

    const snapshot = await listFiles(tmp);
    const dry = await run([p], { sessionIds: ["n1", "d1"], dryRun: true });

    expect(await listFiles(tmp)).toEqual(snapshot);
    expect(commits).toBe(0);
    expect(dry.dryRun).toBe(true);
    expect(dry.configWritten).toBe(false);
    expect(dry.restartRequired).toBe(false);
    // `ok` is the PREDICTION here. A dry run can never write the config, so
    // deriving it from `configWritten` reported a healthy plan as a failure —
    // found by driving the real endpoint, not by the tests.
    expect(dry.ok).toBe(true);
    // The prediction, including the postcondition it could not observe.
    expect(dry.projects[0]).toMatchObject({ chatsDirEmpty: true, outcome: "migrated" });

    const real = await run([p], { sessionIds: ["n1", "d1"] });
    expect(real.migrated.sort()).toEqual(dry.migrated.sort());
    expect(real.preserved.map((x) => x.path).sort()).toEqual(
      dry.preserved.map((x) => x.path).sort(),
    );
    expect(real.projects[0].chatsDirEmpty).toBe(true);
  });

  /* ---------------------------------------------------------------------- */
  /* sweepers                                                                */
  /* ---------------------------------------------------------------------- */

  it("migrates a sweeper store silently, and its failure still blocks the commit", async () => {
    const p = await project();
    await write(path.join(p.chats, "p1.jsonl"), lines("p1", 4));
    const sweeperDir = path.join(tmp, "data", "sweepers", "acme");
    await write(path.join(sweeperDir, ".chats", "sw1.jsonl"), lines("sw1", 4));

    const r = await run([p], {
      sessionIds: ["p1"],
      sweeperDirs: new Map([["acme", sweeperDir]]),
    });

    // No rows, no user choice — counts only, and it migrated without being
    // ticked.
    expect(r.sweepers).toEqual({ stores: 1, chats: 1 });
    expect(r.migrated).toEqual(["p1"]);
    const sweeperHost = path.join(userHome, "projects", encodeProjectDir(sweeperDir));
    expect(await exists(path.join(sweeperHost, "sw1.jsonl"))).toBe(true);
    expect(await fs.readdir(path.join(sweeperDir, ".chats"))).toEqual([]);
    expect(r.configWritten).toBe(true);
  });

  /* ---------------------------------------------------------------------- */
  /* the primitive                                                           */
  /* ---------------------------------------------------------------------- */

  it("moveEntry refuses an occupied destination rather than letting rename clobber it", async () => {
    // POSIX `rename(2)` SILENTLY replaces an existing destination file. Every
    // "nothing in ~/.claude is overwritten" claim above rests on this refusal,
    // so it is asserted against the primitive directly rather than inferred
    // from the paths that happen not to collide.
    const from = path.join(tmp, "from.jsonl");
    const to = path.join(tmp, "to.jsonl");
    await fs.writeFile(from, "new\n", "utf8");
    await fs.writeFile(to, "precious\n", "utf8");

    await expect(moveEntry(from, to)).rejects.toBeInstanceOf(DestinationExistsError);
    expect(await read(to)).toBe("precious\n");
    expect(await read(from)).toBe("new\n");
  });
});
