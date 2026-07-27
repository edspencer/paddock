import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";
import { encodeProjectDir, projectChatsDir } from "../../src/transcripts.js";

/**
 * Issue #512 — a root ("scratch") chat runs INSIDE the instance's backing repo.
 *
 * The real fleet + real CLI runtime + fake `claude` are exercised here, so the
 * cwd asserted below is the cwd the agent process actually got (the fake records
 * `process.cwd()` into every transcript line, exactly as Claude Code does).
 *
 * What must hold after the move:
 *   - the root agent's cwd is `projectsRoot`, so `<projectsRoot>/CLAUDE.md` is on
 *     its CLAUDE.md walk-up (the whole point — Paddock sets no system_prompt);
 *   - transcripts still live in `<scratchDir>/.chats/`, i.e. OUTSIDE the repo,
 *     reached through the new cwd's encoded bucket;
 *   - the chat still lists, hydrates and resumes as a scratch chat;
 *   - scratch is still NOT a project (no self-MCP, no sweep, no project routes).
 */
describe("integration: root chats run in the backing repo (#512)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  let sessionId: string;

  const scratchComplete = (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === "scratch" &&
    typeof e.payload?.sessionId === "string";

  beforeAll(async () => {
    t = await startTestApp({ gitRepo: true });
    // The instance-wide CLAUDE.md, where #512 says it canonically lives: the
    // top-level file of the backing repo checked out at projectsRoot.
    await fs.writeFile(
      path.join(t.projectsRoot, "CLAUDE.md"),
      "# Instance\nBox-wide conventions.\n",
      "utf8",
    );
    ({ port } = await listen(t.app));
    ws = await connectWs(port);

    const m = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "scratch", sessionId: null, message: "hello from the root" },
    });
    const done = await ws.waitFor(scratchComplete, { from: m });
    sessionId = done.payload?.sessionId as string;
    expect(sessionId).toBeTruthy();
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("runs the turn with cwd == projectsRoot (so <projectsRoot>/CLAUDE.md is on the walk-up)", async () => {
    const transcript = await fs.readFile(
      path.join(projectChatsDir(t.cfg.scratchDir), `${sessionId}.jsonl`),
      "utf8",
    );
    expect(transcript).toContain(`"cwd":"${t.projectsRoot}"`);
    // The pre-#512 cwd — a sibling of the repo, with nothing above it.
    expect(transcript).not.toContain(`"cwd":"${t.cfg.scratchDir}"`);
    // The CLAUDE.md is in the cwd itself, so Claude Code's walk-up finds it.
    expect((await fs.stat(path.join(t.projectsRoot, "CLAUDE.md"))).isFile()).toBe(true);
  });

  it("keeps the transcript store OUT of the backing repo's working tree", async () => {
    // The store is <scratchDir>/.chats — outside projectsRoot entirely…
    expect(
      (await fs.stat(path.join(projectChatsDir(t.cfg.scratchDir), `${sessionId}.jsonl`))).isFile(),
    ).toBe(true);
    // …and nothing was created at <projectsRoot>/.chats.
    await expect(fs.lstat(path.join(t.projectsRoot, ".chats"))).rejects.toThrow();
    // Belt and braces: git sees no untracked transcript dir at the repo root.
    const ignore = await fs.readFile(path.join(t.projectsRoot, ".gitignore"), "utf8");
    expect(ignore).toContain("/.chats/");
    expect(ignore).toContain("/.playwright-mcp/");
  });

  it("points the new cwd's encoded bucket at that unmoved store, and leaves no legacy bucket", async () => {
    const bucket = path.join(t.home, ".claude", "projects", encodeProjectDir(t.projectsRoot));
    expect((await fs.lstat(bucket)).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(bucket), await fs.readlink(bucket))).toBe(
      path.resolve(projectChatsDir(t.cfg.scratchDir)),
    );
    // The pre-#512 pointer is retired, so no session is listed from two buckets.
    const legacy = path.join(t.home, ".claude", "projects", encodeProjectDir(t.cfg.scratchDir));
    await expect(fs.lstat(legacy)).rejects.toThrow();
  });

  it("still lists, hydrates and resumes as a scratch chat", async () => {
    const chats = (await t.app.inject({ method: "GET", url: "/api/chats" })).json().chats;
    expect(chats.map((c: { sessionId: string }) => c.sessionId)).toContain(sessionId);

    const messages = (
      await t.app.inject({ method: "GET", url: `/api/chats/${sessionId}/messages` })
    ).json().messages;
    expect(messages.some((m: { role: string }) => m.role === "user")).toBe(true);

    const m = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "scratch", sessionId, message: "still here?" },
    });
    const done = await ws.waitFor(scratchComplete, { from: m });
    expect(done.payload?.success).toBe(true);
    expect(done.payload?.sessionId).toBe(sessionId);
  });

  it("does NOT swallow project chats into the Inbox (descendant-bucket guard)", async () => {
    // herdctl's session discovery unions an agent's own transcript bucket with
    // every bucket whose decoded path is a strict DESCENDANT of its cwd
    // (native-worktree support). With the root agent's cwd at projectsRoot, every
    // project's bucket is now a descendant — so the union is wider than before and
    // the per-session attribution index is what keeps the lists apart. Prove it
    // does: a project chat must not show up in the scratch (Inbox) list.
    const created = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Bucket Guard" },
    });
    expect(created.statusCode).toBe(201);
    const slug = created.json().project.slug as string;

    const m = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: slug, sessionId: null, message: "a project chat" },
    });
    const done = await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.projectSlug === slug,
      { from: m },
    );
    const projectSession = done.payload?.sessionId as string;
    expect(projectSession).toBeTruthy();

    const inbox = (await t.app.inject({ method: "GET", url: "/api/chats" })).json().chats;
    const ids = inbox.map((c: { sessionId: string }) => c.sessionId);
    expect(ids).not.toContain(projectSession);
    expect(ids).toContain(sessionId); // …and the real root chat is still there
  });

  it("does NOT promote scratch to a project: the project routes still 404 for it", async () => {
    // The cwd moved; scratch is still not a project (no self-MCP, no sweep, no
    // project file/git surface — those are #513 items, deliberately not here).
    const res = await t.app.inject({ method: "GET", url: "/api/projects/scratch" });
    expect(res.statusCode).toBe(404);
    const listed = (await t.app.inject({ method: "GET", url: "/api/projects" })).json().projects;
    expect(listed.map((p: { slug: string }) => p.slug)).not.toContain("scratch");
  });
});
