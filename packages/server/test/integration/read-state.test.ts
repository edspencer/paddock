/**
 * Server-side chat read-state (#189): the chat DTO carries `lastSeen`, a
 * `POST .../seen` endpoint persists it, `/api/projects` folds it into
 * `chatTurns`, and `GET /api/me` exposes the principal. Read-state is keyed by
 * user WHEN a real identity is present (trusted-header / jwt), else a single
 * shared bucket (`none` mode / anonymous).
 *
 * Two apps:
 *   - `none` mode (the suite's default) — the shared/anonymous path, exercised
 *     end-to-end with a REAL keeper turn so a discovered session exists and its
 *     DTO can be inspected.
 *   - `trusted-header` mode — the USER-KEYED path, proving the route resolves
 *     `req.user` → username so alice's and bob's read-state are independent and
 *     never alias the shared bucket. No IdP needed; identity rides a header.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === slug &&
  typeof e.payload?.sessionId === "string";

describe("integration: read-state shared/anonymous path (none mode, #189)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  beforeAll(async () => {
    t = await startTestApp({
      script: { "hello there": "hi from the keeper" },
      sweepIntervalMs: 600_000,
    });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("GET /api/me returns the anonymous principal in none mode", async () => {
    const me = (await t.app.inject({ method: "GET", url: "/api/me" })).json();
    expect(me).toMatchObject({ username: "anonymous", anonymous: true });
  });

  it("marks a chat seen and surfaces lastSeen on the DTO + chatTurns", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Seen Proj" } });
    const slug = "seen-proj";

    // Run a real turn so a discovered, attributed session exists.
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: slug, sessionId: null, message: "hello there" },
    });
    const complete = await ws.waitFor(isComplete(slug), { from: mark });
    const sessionId = complete.payload!.sessionId as string;

    // Before marking seen, lastSeen is absent (unseen → 0/undefined).
    const before = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` }))
      .json()
      .chats.find((c: { sessionId: string }) => c.sessionId === sessionId);
    expect(before.lastSeen).toBeUndefined();

    // Mark it seen at a fixed timestamp.
    const when = Date.now();
    const seen = await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${sessionId}/seen`,
      payload: { when },
    });
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({ ok: true, lastSeen: when });

    // The chat list DTO now carries lastSeen.
    const listed = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` }))
      .json()
      .chats.find((c: { sessionId: string }) => c.sessionId === sessionId);
    expect(listed.lastSeen).toBe(when);

    // The enriched detail carries it too.
    const detail = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}` }))
      .json()
      .chats.find((c: { sessionId: string }) => c.sessionId === sessionId);
    expect(detail.lastSeen).toBe(when);

    // /api/projects folds it into the sidebar's chatTurns.
    const project = (await t.app.inject({ method: "GET", url: "/api/projects" }))
      .json()
      .projects.find((p: { slug: string }) => p.slug === slug) as {
      chatTurns?: { sessionId: string; lastSeen?: number }[];
    };
    const turn = project.chatTurns!.find((c) => c.sessionId === sessionId);
    expect(turn!.lastSeen).toBe(when);

    // A default POST (no body) advances to server-now; monotonic, so it moves
    // forward from `when`.
    await new Promise((r) => setTimeout(r, 5));
    const seen2 = await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${sessionId}/seen`,
    });
    expect(seen2.json().lastSeen).toBeGreaterThanOrEqual(when);

    // read-state.json exists in the data dir.
    const file = path.join(t.cfg.dataDir, "read-state.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, number>;
    expect(Object.values(raw).some((v) => v >= when)).toBe(true);
  });
});

describe("integration: read-state user-keyed path (trusted-header mode, #189)", () => {
  let t: TestApp;
  const saved = {
    mode: process.env.PADDOCK_AUTH_MODE,
    header: process.env.PADDOCK_AUTH_USER_HEADER,
  };
  const slug = "keyed-proj";
  const sid = "11111111-2222-3333-4444-555555555555";

  beforeAll(async () => {
    process.env.PADDOCK_AUTH_MODE = "trusted-header";
    process.env.PADDOCK_AUTH_USER_HEADER = "x-forwarded-user";
    t = await startTestApp();
    // Create a project (as a real user — trusted-header 401s without the header).
    await t.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { "x-forwarded-user": "alice" },
      payload: { name: "Keyed Proj" },
    });
  });
  afterAll(async () => {
    await t.teardown();
    if (saved.mode === undefined) delete process.env.PADDOCK_AUTH_MODE;
    else process.env.PADDOCK_AUTH_MODE = saved.mode;
    if (saved.header === undefined) delete process.env.PADDOCK_AUTH_USER_HEADER;
    else process.env.PADDOCK_AUTH_USER_HEADER = saved.header;
  });

  it("GET /api/me returns the real principal (not anonymous)", async () => {
    const me = (
      await t.app.inject({
        method: "GET",
        url: "/api/me",
        headers: { "x-forwarded-user": "alice" },
      })
    ).json();
    expect(me.username).toBe("alice");
    expect(me.anonymous).toBeFalsy();
  });

  it("401s a request with no identity header", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("keys read-state by username so alice and bob are independent", async () => {
    const mark = (user: string, when: number) =>
      t.app.inject({
        method: "POST",
        url: `/api/projects/${slug}/chats/${sid}/seen`,
        headers: { "x-forwarded-user": user },
        payload: { when },
      });
    expect((await mark("alice", 200)).statusCode).toBe(200);
    expect((await mark("bob", 300)).statusCode).toBe(200);

    const file = path.join(t.cfg.dataDir, "read-state.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, number>;
    const entries = Object.entries(raw);
    // Every key is USER-SEGMENTED (3 NUL-joined fields), never the shared bucket.
    for (const [k] of entries) expect(k.split("\u0000")).toHaveLength(3);
    const alice = entries.find(([k]) => k.startsWith(`alice\u0000`));
    const bob = entries.find(([k]) => k.startsWith(`bob\u0000`));
    expect(alice?.[1]).toBe(200);
    expect(bob?.[1]).toBe(300);
    // The two users share a session id but hold distinct read-state.
    expect(alice![0]).not.toBe(bob![0]);
    expect(alice![0]).toContain(sid);
    expect(bob![0]).toContain(sid);
  });
});
