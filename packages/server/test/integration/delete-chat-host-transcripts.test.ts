/**
 * Deleting a chat under `claude.transcripts: host` removes the transcript.
 *
 * Under `host` the project's transcript symlink points OUT at the user's own
 * `~/.claude/projects/<encoded-cwd>/`, so the file a chat lives in IS the user's
 * Claude Code transcript. #689 made delete RELEASE such a chat and leave the file
 * on disk. Discovery scans that folder structurally, so the released chat was
 * listed again on the next read (#693): delete did not delete. Delete now
 * removes `<id>.jsonl` and its `<id>/` sidecar directory from that folder, and
 * the chat leaves Claude Code's history as well as paddock's list.
 *
 * What is pinned below: the files go, the chat leaves the list, its job records
 * are purged, other sessions in the same folder are untouched, a repeat delete
 * reports nothing removed, an id that is not a session UUID is refused (so a
 * delete cannot reach Claude Code's `memory/` or any other non-session entry),
 * an id with no `.jsonl` removes nothing even when a directory of that name
 * exists, a sidecar that cannot be removed leaves the chat listed and the delete
 * retryable, and a transcript symlink that no longer resolves to the user's
 * folder is refused rather than `rm`-ed through.
 *
 * Every Claude home here is a temp dir: `HOME` is a throwaway directory, so
 * `~/.claude` below is this test's own.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";
import { encodeProjectDir } from "../../src/transcripts.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === slug &&
  typeof e.payload?.sessionId === "string";

/** Drive one real turn through the fake `claude` to mint a real session id. */
async function oneTurn(ws: WsClient, slug: string, message: string): Promise<string> {
  const mark = ws.mark();
  ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message } });
  const complete = await ws.waitFor(isComplete(slug), { from: mark });
  return complete.payload?.sessionId as string;
}

const exists = (p: string) =>
  fs.lstat(p).then(
    () => true,
    () => false,
  );

/** Seed one completed job record for `sessionId`, as a batch-mode turn writes. */
async function seedJob(t: TestApp, id: string, agent: string, sessionId: string): Promise<string> {
  const jobsDir = path.join(t.cfg.stateDir, "jobs");
  await fs.mkdir(jobsDir, { recursive: true });
  const when = new Date().toISOString();
  const file = path.join(jobsDir, `${id}.yaml`);
  const record = {
    id,
    agent,
    trigger_type: "manual",
    status: "completed",
    schedule: null,
    forked_from: null,
    session_id: sessionId,
    started_at: when,
    finished_at: when,
    duration_seconds: 1,
    prompt: null,
  };
  await fs.writeFile(file, YAML.stringify(record), "utf8");
  return file;
}

/** Plant a sidecar directory shaped like Claude Code's: one sub-agent and its meta. */
async function seedSidecar(folder: string, sessionId: string): Promise<string> {
  const subagents = path.join(folder, sessionId, "subagents");
  await fs.mkdir(subagents, { recursive: true });
  await fs.writeFile(path.join(subagents, "agent-a1.jsonl"), '{"type":"user"}\n', "utf8");
  await fs.writeFile(path.join(subagents, "agent-a1.meta.json"), "{}", "utf8");
  return path.join(folder, sessionId);
}

describe("integration: deleting a chat under claude.transcripts: host", () => {
  let t: TestApp;
  let ws: WsClient;
  let userHome: string;
  /** The user's own transcript folder for the project's working directory. */
  let usersFolder: string;

  const SLUG = "unowned-del";
  const KEEPER = `keeper-${SLUG}`;

  const listed = async (): Promise<string[]> =>
    (await t.app.inject({ method: "GET", url: `/api/projects/${SLUG}/chats` }))
      .json()
      .chats.map((c: { sessionId: string }) => c.sessionId);

  beforeAll(async () => {
    // A HOME of our own, so `~/.claude` is a real directory this test owns:
    // `opts.env` is applied last, so it wins over the harness's HOME, and
    // `userClaudeHome()` reads `os.homedir()` at config-build time. Paddock's own
    // home stays where it always is, `<dataDir>/claude-home`.
    userHome = await makeTmpDir("paddock-userhome-");
    t = await startTestApp({
      env: { HOME: userHome, PADDOCK_CLAUDE_TRANSCRIPTS: "host" },
    });
    const { port } = await listen(t.app);
    ws = await connectWs(port);
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: SLUG } });
    usersFolder = path.join(
      userHome,
      ".claude",
      "projects",
      encodeProjectDir(path.join(t.projectsRoot, SLUG)),
    );
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    await t?.teardown();
    await rmTmpDir(userHome);
  });

  it("puts the transcript in the USER's home, reached through paddock's own", async () => {
    // Guards the fixture itself. If this stops holding, the assertions below
    // would be deleting a paddock-owned copy and would pass for the wrong reason.
    const sessionId = await oneTurn(ws, SLUG, "where does this land");
    expect(await fs.stat(path.join(usersFolder, `${sessionId}.jsonl`)).then((s) => s.isFile()))
      .toBe(true);
    // The user's own folder is a real directory — paddock did not plant a link
    // over it (#682); it planted one POINTING at it, in its own home.
    expect((await fs.lstat(usersFolder)).isSymbolicLink()).toBe(false);
    const link = path.join(
      t.cfg.claudeHome,
      "projects",
      encodeProjectDir(path.join(t.projectsRoot, SLUG)),
    );
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(link)).toBe(await fs.realpath(usersFolder));
    // …and the literal path handed to the agent has no `.claude` component, which
    // is what keeps agent memory writable (#690).
    expect(link.split(path.sep)).not.toContain(".claude");
  }, 60_000);

  it("removes the transcript and its sidecar, unlists the chat and purges its jobs", async () => {
    const sessionId = await oneTurn(ws, SLUG, "delete me for real");
    const transcript = path.join(usersFolder, `${sessionId}.jsonl`);
    const sidecar = await seedSidecar(usersFolder, sessionId);
    const job = await seedJob(t, "job-host-del-1", KEEPER, sessionId);

    // A neighbour in the same folder: a terminal session paddock never touched.
    const NEIGHBOUR = "terminal-neighbour-0001";
    const neighbourFile = path.join(usersFolder, `${NEIGHBOUR}.jsonl`);
    await fs.writeFile(neighbourFile, '{"type":"user","message":{"content":"hi"}}\n', "utf8");
    const neighbourSidecar = await seedSidecar(usersFolder, NEIGHBOUR);
    const neighbourJob = await seedJob(t, "job-host-del-2", KEEPER, NEIGHBOUR);

    expect(await listed()).toContain(sessionId);

    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${SLUG}/chats/${sessionId}`,
    });

    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, removed: true, retained: false });
    expect(await exists(transcript)).toBe(false);
    expect(await exists(sidecar)).toBe(false);
    expect(await exists(job)).toBe(false);
    // The bug was this: the chat came straight back on the next list.
    expect(await listed()).not.toContain(sessionId);

    expect(await exists(neighbourFile)).toBe(true);
    expect(await exists(path.join(neighbourSidecar, "subagents", "agent-a1.jsonl"))).toBe(true);
    expect(await exists(neighbourJob)).toBe(true);

    // A repeat delete succeeds but reports nothing removed, as `own` does.
    const again = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${SLUG}/chats/${sessionId}`,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, removed: false, retained: false });
  }, 60_000);

  it("removes the transcripts of a batch delete too", async () => {
    const a = await oneTurn(ws, SLUG, "batch one");
    const b = await oneTurn(ws, SLUG, "batch two");
    const jobA = await seedJob(t, "job-host-batch-a", KEEPER, a);

    const res = await t.app.inject({
      method: "POST",
      url: `/api/projects/${SLUG}/chats/batch/delete`,
      payload: { sessionIds: [a, b] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, failed: [] });
    expect([...res.json().removed].sort()).toEqual([a, b].sort());
    expect(await exists(path.join(usersFolder, `${a}.jsonl`))).toBe(false);
    expect(await exists(path.join(usersFolder, `${b}.jsonl`))).toBe(false);
    expect(await exists(jobA)).toBe(false);
    const after = await listed();
    expect(after).not.toContain(a);
    expect(after).not.toContain(b);
  }, 60_000);

  it("refuses a session id that is not a plain id, and touches nothing", async () => {
    // A file one level above the user's folder, which `..` would reach.
    const canary = path.join(path.dirname(usersFolder), "canary.jsonl");
    await fs.writeFile(canary, "keep", "utf8");

    for (const id of ["..%2Fcanary", "canary.jsonl", "a.b"]) {
      const del = await t.app.inject({
        method: "DELETE",
        url: `/api/projects/${SLUG}/chats/${id}`,
      });
      expect(del.statusCode).toBe(400);
      expect(del.json()).toMatchObject({ code: "invalid" });
    }
    expect(await fs.readFile(canary, "utf8")).toBe("keep");
  });

  it("refuses an id naming Claude Code's memory folder, and leaves it intact", async () => {
    // `memory/` sits beside the transcripts in most folders: Claude Code's
    // auto-memory. `memory` passes the engine's path rule, so only the session
    // id check stands between this request and an `rm -rf` of it.
    const memory = path.join(usersFolder, "memory");
    await fs.mkdir(memory, { recursive: true });
    await fs.writeFile(path.join(memory, "MEMORY.md"), "remember this", "utf8");

    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${SLUG}/chats/memory`,
    });
    expect(del.statusCode).toBe(400);
    expect(del.json()).toMatchObject({ code: "invalid" });

    const batch = await t.app.inject({
      method: "POST",
      url: `/api/projects/${SLUG}/chats/batch/delete`,
      payload: { sessionIds: ["memory"] },
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toMatchObject({ ok: true, removed: [], failed: ["memory"] });

    expect(await fs.readFile(path.join(memory, "MEMORY.md"), "utf8")).toBe("remember this");
  });

  it("removes nothing for a session id with no transcript, even if a folder has its name", async () => {
    const ID = "00000000-0000-4000-8000-000000000001";
    const stray = await seedSidecar(usersFolder, ID);
    expect(await exists(path.join(usersFolder, `${ID}.jsonl`))).toBe(false);

    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${SLUG}/chats/${ID}`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, removed: false, retained: false });

    const batch = await t.app.inject({
      method: "POST",
      url: `/api/projects/${SLUG}/chats/batch/delete`,
      payload: { sessionIds: [ID] },
    });
    expect(batch.json()).toMatchObject({ ok: true, removed: [], failed: [ID] });

    expect(await exists(path.join(stray, "subagents", "agent-a1.jsonl"))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    "leaves the chat listed and retryable when its sidecar cannot be removed",
    async () => {
      const sessionId = await oneTurn(ws, SLUG, "a sidecar that will not go");
      const transcript = path.join(usersFolder, `${sessionId}.jsonl`);
      const sidecar = await seedSidecar(usersFolder, sessionId);
      // A directory without write permission cannot have its entries unlinked.
      const locked = path.join(sidecar, "subagents");
      await fs.chmod(locked, 0o500);
      try {
        const del = await t.app.inject({
          method: "DELETE",
          url: `/api/projects/${SLUG}/chats/${sessionId}`,
        });
        expect(del.statusCode).toBe(500);
        expect(await exists(transcript)).toBe(true);
        expect(await listed()).toContain(sessionId);
      } finally {
        await fs.chmod(locked, 0o700);
      }

      const retry = await t.app.inject({
        method: "DELETE",
        url: `/api/projects/${SLUG}/chats/${sessionId}`,
      });
      expect(retry.json()).toMatchObject({ ok: true, removed: true, retained: false });
      expect(await exists(transcript)).toBe(false);
      expect(await exists(sidecar)).toBe(false);
      expect(await listed()).not.toContain(sessionId);
    },
    60_000,
  );

  // Last in the file: it repoints the project's transcript symlink.
  it("refuses when the transcript link no longer resolves to the user's folder", async () => {
    const link = path.join(
      t.cfg.claudeHome,
      "projects",
      encodeProjectDir(path.join(t.projectsRoot, SLUG)),
    );
    const elsewhere = await makeTmpDir("paddock-elsewhere-");
    try {
      const ID = "00000000-0000-4000-8000-000000000002";
      const stray = path.join(elsewhere, `${ID}.jsonl`);
      await fs.writeFile(stray, "keep", "utf8");
      await fs.rm(link);
      await fs.symlink(elsewhere, link);

      const del = await t.app.inject({
        method: "DELETE",
        url: `/api/projects/${SLUG}/chats/${ID}`,
      });

      expect(del.statusCode).toBe(500);
      expect(del.json().error).toMatch(/refusing to delete/);
      expect(await fs.readFile(stray, "utf8")).toBe("keep");
    } finally {
      await rmTmpDir(elsewhere);
    }
  });
});

describe("integration: deleting a chat under claude.transcripts: own (the default)", () => {
  let t: TestApp;
  let ws: WsClient;

  const SLUG = "owned-del";

  beforeAll(async () => {
    t = await startTestApp(); // default: <dataDir>/claude-home, transcripts: own
    const { port } = await listen(t.app);
    ws = await connectWs(port);
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: SLUG } });
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    await t?.teardown();
  });

  // Under `own` the transcript is paddock's own copy in the project's `.chats/`.
  it("removes the transcript, because the copy is paddock's own", async () => {
    const sessionId = await oneTurn(ws, SLUG, "delete me for real");
    const transcript = path.join(t.projectsRoot, SLUG, ".chats", `${sessionId}.jsonl`);
    expect(await fs.stat(transcript).then((s) => s.isFile())).toBe(true);

    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${SLUG}/chats/${sessionId}`,
    });

    expect(del.json()).toMatchObject({ ok: true, removed: true, retained: false });
    await expect(fs.stat(transcript)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});

/**
 * #708 — the same `rm`, on an instance whose `.chats` is still a symlink left by
 * a `claude.transcripts: host` period.
 *
 * The test above is the reason this one has to exist. Under `own` the delete
 * SHOULD remove the file, because the file is paddock's own copy — and that
 * reasoning is only sound while `<project>/.chats` really is paddock's store. On
 * an instance flipped `host` → `own` it was a leftover symlink into the user's
 * real Claude home, so the "delete has to mean delete" branch resolved straight
 * through it and unlinked the user's terminal history. Same code, same config,
 * opposite meaning — exactly what a test on the healthy layout cannot see.
 *
 * `ensureProjectChats` now clears that link on every boot, so this guard is the
 * second line rather than the fix; it exists because the healing swallows its
 * own errors by design, and this `rm` is the one operation that must not run
 * against an unhealed layout.
 *
 * The stale layout is planted by hand here rather than by restarting the app in
 * the other mode, because the harness builds a fresh data dir per app and cannot
 * be pointed at an existing one. That this IS the layout a real flip produces is
 * pinned separately and structurally in `test/unit/transcripts.test.ts`, where
 * the fixtures are produced by running `ensureProjectChats` in `host` mode
 * rather than by hand.
 */
describe("integration: deleting a chat under own, with a stale host `.chats` link (#708)", () => {
  let t: TestApp;
  let ws: WsClient;
  let userHome: string;

  const SLUG = "stale-link-del";

  beforeAll(async () => {
    userHome = await makeTmpDir("paddock-userhome-stale-");
    t = await startTestApp(); // `own`, the default — as after a flip back
    const { port } = await listen(t.app);
    ws = await connectWs(port);
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: SLUG } });
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    await t?.teardown();
    await rmTmpDir(userHome);
  });

  it("refuses the delete rather than reaching into the user's Claude home", async () => {
    const sessionId = await oneTurn(ws, SLUG, "a chat from the host era");
    const chats = path.join(t.projectsRoot, SLUG, ".chats");

    // Re-shape the project into the state a `host` period leaves behind: the
    // transcripts in the user's own folder, and `.chats` a symlink pointing at it.
    const usersFolder = path.join(
      userHome,
      ".claude",
      "projects",
      encodeProjectDir(path.join(t.projectsRoot, SLUG)), // encoded from the CWD, as Claude does
    );
    await fs.mkdir(usersFolder, { recursive: true });
    const usersFile = path.join(usersFolder, `${sessionId}.jsonl`);
    await fs.rename(path.join(chats, `${sessionId}.jsonl`), usersFile);
    await fs.rm(chats, { recursive: true, force: true });
    await fs.symlink(usersFolder, chats);

    const before = await fs.readFile(usersFile, "utf8");
    // Fixture guard: without it the assertion below could pass for the boring
    // reason that there was never anything for the delete to find.
    expect(before.length).toBeGreaterThan(0);

    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${SLUG}/chats/${sessionId}`,
    });

    // Nothing was deleted, and the reply says so rather than claiming success.
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, removed: false, retained: true });
    // The assertion the bug was.
    expect(await fs.readFile(usersFile, "utf8")).toBe(before);
  }, 60_000);
});
