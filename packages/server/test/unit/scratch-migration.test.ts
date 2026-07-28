import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  migrateScratchToRoot,
  rekeyScratchKey,
  ROOT_AGENT,
} from "../../src/scratch-migration.js";
import { keyOf as readStateKeyOf } from "../../src/read-state.js";
import { keeperAgentName } from "../../src/herdctl-agent-names.js";
import { ROOT_SLUG } from "../../src/project-paths.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const NUL = "\u0000";
const SID = "ca54e9fe-1cf2-4227-b7af-4390fd68992f";
const SID2 = "d05dd6fc-3dbd-4a13-9b27-8028db644636";

describe("rekeyScratchKey", () => {
  it("targets the root keeper agent", () => {
    expect(ROOT_AGENT).toBe(keeperAgentName(ROOT_SLUG));
    expect(ROOT_AGENT).toBe("keeper-__root");
  });

  it("rewrites the two-segment archive/star/queued key shape", () => {
    expect(rekeyScratchKey(`scratch${NUL}${SID}`)).toBe(`${ROOT_AGENT}${NUL}${SID}`);
  });

  /**
   * The trap this whole function exists for. `read-state`/`unread` prepend a
   * user segment, so the scratch agent is in the MIDDLE — a `startsWith`
   * implementation returns nothing here and silently drops every user's
   * read-state. Asserted against the store's own `keyOf` so the two can't drift.
   */
  it("rewrites the THREE-segment read-state/unread key shape", () => {
    const key = readStateKeyOf("ed", "scratch", SID);
    expect(key).toBe(`ed${NUL}scratch${NUL}${SID}`);
    expect(key.startsWith(`scratch${NUL}`)).toBe(false); // the naive test fails here
    expect(rekeyScratchKey(key)).toBe(readStateKeyOf("ed", ROOT_AGENT, SID));
  });

  it("rewrites read-state's anonymous shared-bucket key (two segments, no user)", () => {
    expect(rekeyScratchKey(readStateKeyOf(null, "scratch", SID))).toBe(
      readStateKeyOf(null, ROOT_AGENT, SID),
    );
  });

  it("leaves non-scratch keys alone", () => {
    expect(rekeyScratchKey(`keeper-paddock${NUL}${SID}`)).toBeNull();
    expect(rekeyScratchKey(`ed${NUL}keeper-paddock${NUL}${SID}`)).toBeNull();
    expect(rekeyScratchKey(`${ROOT_AGENT}${NUL}${SID}`)).toBeNull();
  });

  /**
   * Position, not substring. A user literally called `scratch`, or a session id
   * that happens to contain the word, must not be rewritten — only the agent
   * segment (second-to-last) counts.
   */
  it("does not rewrite a `scratch` user segment or a scratch-shaped session id", () => {
    expect(rekeyScratchKey(`scratch${NUL}keeper-paddock${NUL}${SID}`)).toBeNull();
    expect(rekeyScratchKey(`keeper-paddock${NUL}scratch`)).toBeNull();
  });

  it("ignores a malformed single-segment key", () => {
    expect(rekeyScratchKey("scratch")).toBeNull();
    expect(rekeyScratchKey("")).toBeNull();
  });

  it("is a no-op on an already-migrated key (so a re-run adds nothing)", () => {
    const once = rekeyScratchKey(`scratch${NUL}${SID}`);
    expect(once).not.toBeNull();
    expect(rekeyScratchKey(once as string)).toBeNull();
  });
});

describe("migrateScratchToRoot", () => {
  let dataDir: string;
  let scratchDir: string;
  let projectsRoot: string;

  const opts = (over: Partial<Parameters<typeof migrateScratchToRoot>[0]> = {}) => ({
    dataDir,
    scratchDir,
    projectsRoot,
    hasRootProject: true,
    ...over,
  });

  const writeSidecar = (file: string, value: unknown) =>
    fs.writeFile(path.join(dataDir, file), JSON.stringify(value), "utf8");
  const readSidecar = async (file: string) =>
    JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8"));

  beforeEach(async () => {
    dataDir = await makeTmpDir("scratch-migration");
    scratchDir = path.join(dataDir, "scratch");
    projectsRoot = path.join(dataDir, "projects");
    await fs.mkdir(path.join(scratchDir, ".chats"), { recursive: true });
    await fs.mkdir(projectsRoot, { recursive: true });
    await fs.writeFile(path.join(scratchDir, ".chats", `${SID}.jsonl`), '{"type":"user"}\n', "utf8");
    await fs.writeFile(path.join(scratchDir, ".chats", `${SID2}.jsonl`), '{"type":"user"}\n', "utf8");
  });

  afterEach(async () => {
    await rmTmpDir(dataDir);
  });

  it("is a no-op without a root project — the opt-in gate", async () => {
    const res = await migrateScratchToRoot(opts({ hasRootProject: false }));
    expect(res).toMatchObject({ ran: false, skipped: "no-root-project", copied: 0 });
    await expect(fs.readdir(path.join(projectsRoot, ".chats"))).rejects.toThrow();
  });

  it("is a no-op when scratch has no .chats dir", async () => {
    await fs.rm(path.join(scratchDir, ".chats"), { recursive: true, force: true });
    const res = await migrateScratchToRoot(opts());
    expect(res).toMatchObject({ ran: false, skipped: "no-scratch-chats" });
  });

  it("refuses to copy a directory onto itself when scratch .chats IS the root's", async () => {
    await fs.mkdir(path.join(projectsRoot, ".chats"), { recursive: true });
    await fs.rm(path.join(scratchDir, ".chats"), { recursive: true, force: true });
    await fs.symlink(path.join(projectsRoot, ".chats"), path.join(scratchDir, ".chats"));
    const res = await migrateScratchToRoot(opts());
    expect(res).toMatchObject({ ran: false, skipped: "same-dir" });
  });

  it("copies transcripts into the root's .chats and leaves scratch fully intact", async () => {
    const res = await migrateScratchToRoot(opts());
    expect(res.ran).toBe(true);
    expect(res.copied).toBe(2);
    expect((await fs.readdir(path.join(projectsRoot, ".chats"))).sort()).toEqual([
      `${SID}.jsonl`,
      `${SID2}.jsonl`,
    ]);
    // The source is the ONLY copy of these transcripts — never moved, never removed.
    expect((await fs.readdir(path.join(scratchDir, ".chats"))).sort()).toEqual([
      `${SID}.jsonl`,
      `${SID2}.jsonl`,
    ]);
  });

  it("copies the scratch agent's memory/ dir too, recursively", async () => {
    await fs.mkdir(path.join(scratchDir, ".chats", "memory"), { recursive: true });
    await fs.writeFile(path.join(scratchDir, ".chats", "memory", "notes.md"), "hi", "utf8");
    await migrateScratchToRoot(opts());
    expect(
      await fs.readFile(path.join(projectsRoot, ".chats", "memory", "notes.md"), "utf8"),
    ).toBe("hi");
  });

  it("never clobbers a transcript already at the destination", async () => {
    await fs.mkdir(path.join(projectsRoot, ".chats"), { recursive: true });
    await fs.writeFile(path.join(projectsRoot, ".chats", `${SID}.jsonl`), "MINE", "utf8");
    const res = await migrateScratchToRoot(opts());
    expect(res).toMatchObject({ copied: 1, alreadyPresent: 1 });
    expect(await fs.readFile(path.join(projectsRoot, ".chats", `${SID}.jsonl`), "utf8")).toBe(
      "MINE",
    );
  });

  it("re-keys all five sidecars and touches neither provenance file", async () => {
    await writeSidecar("archive-state.json", [
      `scratch${NUL}${SID}`,
      `keeper-paddock${NUL}${SID2}`,
    ]);
    await writeSidecar("star-state.json", [`scratch${NUL}${SID}`]);
    await writeSidecar("read-state.json", { [readStateKeyOf("ed", "scratch", SID)]: 1700 });
    await writeSidecar("unread-state.json", [readStateKeyOf("ed", "scratch", SID)]);
    await writeSidecar("queued-message.json", { [`scratch${NUL}${SID}`]: { text: "later" } });
    const provenance = { [SID]: { origin: "human", depth: 0 } };
    await writeSidecar("run-provenance.json", provenance);
    await writeSidecar("message-provenance.json", provenance);

    const res = await migrateScratchToRoot(opts());

    expect(res.rekeyed).toEqual({
      "archive-state.json": 1,
      "star-state.json": 1,
      "read-state.json": 1,
      "unread-state.json": 1,
      "queued-message.json": 1,
    });
    expect(await readSidecar("archive-state.json")).toEqual([
      `scratch${NUL}${SID}`,
      `keeper-paddock${NUL}${SID2}`,
      `${ROOT_AGENT}${NUL}${SID}`,
    ]);
    expect(await readSidecar("star-state.json")).toContain(`${ROOT_AGENT}${NUL}${SID}`);
    expect(await readSidecar("read-state.json")).toEqual({
      [readStateKeyOf("ed", "scratch", SID)]: 1700,
      [readStateKeyOf("ed", ROOT_AGENT, SID)]: 1700,
    });
    expect(await readSidecar("unread-state.json")).toContain(
      readStateKeyOf("ed", ROOT_AGENT, SID),
    );
    expect(await readSidecar("queued-message.json")).toMatchObject({
      [`${ROOT_AGENT}${NUL}${SID}`]: { text: "later" },
    });
    // Keyed by bare session id — a re-homed chat keeps its provenance for free.
    expect(await readSidecar("run-provenance.json")).toEqual(provenance);
    expect(await readSidecar("message-provenance.json")).toEqual(provenance);
  });

  it("re-keys read-state for MULTIPLE users, not just the first", async () => {
    await writeSidecar("read-state.json", {
      [readStateKeyOf("ed", "scratch", SID)]: 1,
      [readStateKeyOf("sam", "scratch", SID)]: 2,
      [readStateKeyOf(null, "scratch", SID2)]: 3,
    });
    const res = await migrateScratchToRoot(opts());
    expect(res.rekeyed["read-state.json"]).toBe(3);
    const after = await readSidecar("read-state.json");
    expect(after[readStateKeyOf("ed", ROOT_AGENT, SID)]).toBe(1);
    expect(after[readStateKeyOf("sam", ROOT_AGENT, SID)]).toBe(2);
    expect(after[readStateKeyOf(null, ROOT_AGENT, SID2)]).toBe(3);
  });

  it("is idempotent — a second run copies nothing and re-keys nothing", async () => {
    await writeSidecar("archive-state.json", [`scratch${NUL}${SID}`]);
    await writeSidecar("read-state.json", { [readStateKeyOf("ed", "scratch", SID)]: 1700 });
    const first = await migrateScratchToRoot(opts());
    const firstArchive = await readSidecar("archive-state.json");
    const firstRead = await readSidecar("read-state.json");

    const second = await migrateScratchToRoot(opts());
    expect(second).toMatchObject({ ran: true, copied: 0, alreadyPresent: first.copied, rekeyed: {} });
    expect(await readSidecar("archive-state.json")).toEqual(firstArchive);
    expect(await readSidecar("read-state.json")).toEqual(firstRead);
  });

  it("never overwrites an existing destination sidecar value", async () => {
    await writeSidecar("read-state.json", {
      [readStateKeyOf("ed", "scratch", SID)]: 100,
      [readStateKeyOf("ed", ROOT_AGENT, SID)]: 999,
    });
    const res = await migrateScratchToRoot(opts());
    expect(res.rekeyed["read-state.json"]).toBeUndefined();
    expect((await readSidecar("read-state.json"))[readStateKeyOf("ed", ROOT_AGENT, SID)]).toBe(999);
  });

  it("leaves a corrupt sidecar untouched rather than rewriting it", async () => {
    await fs.writeFile(path.join(dataDir, "archive-state.json"), "{not json", "utf8");
    const res = await migrateScratchToRoot(opts());
    expect(res.ran).toBe(true);
    expect(res.rekeyed["archive-state.json"]).toBeUndefined();
    expect(await fs.readFile(path.join(dataDir, "archive-state.json"), "utf8")).toBe("{not json");
  });

  it("tolerates every sidecar being absent", async () => {
    const res = await migrateScratchToRoot(opts());
    expect(res).toMatchObject({ ran: true, copied: 2, rekeyed: {} });
  });

  it("writes re-keyed sidecars 0o600", async () => {
    await writeSidecar("read-state.json", { [readStateKeyOf("ed", "scratch", SID)]: 1 });
    await migrateScratchToRoot(opts());
    const st = await fs.stat(path.join(dataDir, "read-state.json"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("leaves no .tmp file behind", async () => {
    await writeSidecar("star-state.json", [`scratch${NUL}${SID}`]);
    await migrateScratchToRoot(opts());
    expect((await fs.readdir(dataDir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
