/**
 * REST route coverage gaps (routes.ts), driven through the REAL app via
 * `app.inject` (no socket needed for these — they're pure reads/metadata ops).
 *
 * Covers the endpoints the chat/promote/git/crud suites don't already exercise:
 *   - rename + delete chat (project + scratch variants), incl. unknown-slug 404s
 *   - pins: pin/unpin and the path-traversal guard (escaping the project dir)
 *   - the /context endpoints (project + scratch), with and without usage data
 *   - GET /overview (curated + empty), GET /changelog, GET /files/:name + kinds
 *   - the GitHub device-flow endpoints (connect/poll/disconnect) with mocked fetch
 *   - /api/models shape + the /api/git/github status block
 *
 * A handful of these need a real transcript on disk; for those we run ONE chat
 * turn over WS (the only way to mint a real session id) and then drive the REST
 * endpoints against it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === slug &&
  typeof e.payload?.sessionId === "string";

/** Minimal Response stand-in for the mocked GitHub fetch. */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

describe("integration: REST route coverage (real app, fake claude)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  beforeAll(async () => {
    t = await startTestApp();
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Routes Proj" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  /** Run one chat turn and return its session id (a real transcript on disk). */
  async function oneTurn(slug: string, message: string): Promise<string> {
    const mark = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message } });
    const complete = await ws.waitFor(isComplete(slug), { from: mark });
    return complete.payload?.sessionId as string;
  }

  // --- /api/models edge cases -------------------------------------------------

  it("GET /api/models lists models with keeper + sweeper defaults", async () => {
    const body = (await t.app.inject({ method: "GET", url: "/api/models" })).json();
    expect(body.keeperDefault).toBe("claude-opus-4-8");
    expect(body.sweeperDefault).toBe("claude-haiku-4-5-20251001");
    const ids = body.models.map((m: { id: string }) => m.id);
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("claude-sonnet-4-6");
    // Every model carries a positive context limit (drives the meter).
    for (const m of body.models) expect(m.contextLimit).toBeGreaterThan(0);
  });

  // --- overview + changelog + files ------------------------------------------

  it("GET /overview returns '' before any sweep and the content after writeOverview", async () => {
    const empty = await t.app.inject({ method: "GET", url: "/api/projects/routes-proj/overview" });
    expect(empty.statusCode).toBe(200);
    expect(empty.headers["content-type"]).toContain("text/markdown");
    expect(empty.body).toBe("");

    await t.projects.writeOverview("routes-proj", "# Current State\nAll good.");
    const filled = await t.app.inject({ method: "GET", url: "/api/projects/routes-proj/overview" });
    expect(filled.body).toContain("# Current State");
  });

  it("GET /overview 404s for an unknown project", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/projects/ghost/overview" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /changelog returns the seeded changelog (markdown), 404 for unknown", async () => {
    const ok = await t.app.inject({ method: "GET", url: "/api/projects/routes-proj/changelog" });
    expect(ok.headers["content-type"]).toContain("text/markdown");
    expect(ok.body).toContain("Project opened.");
    const bad = await t.app.inject({ method: "GET", url: "/api/projects/ghost/changelog" });
    expect(bad.statusCode).toBe(404);
  });

  it("GET /files/:name returns content + a render kind, and 404s a missing file", async () => {
    const project = (
      await t.app.inject({ method: "GET", url: "/api/projects/routes-proj" })
    ).json().project;
    await fs.writeFile(path.join(project.dir, "page.html"), "<h1>hi</h1>", "utf8");

    const file = (
      await t.app.inject({ method: "GET", url: "/api/projects/routes-proj/files/page.html" })
    ).json();
    expect(file.kind).toBe("html");
    expect(file.content).toContain("<h1>hi</h1>");

    const missing = await t.app.inject({
      method: "GET",
      url: "/api/projects/routes-proj/files/nope.md",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("GET /files (listing) 404s for an unknown project", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/projects/ghost/files" });
    expect(res.statusCode).toBe(404);
  });

  // --- pins: pin/unpin + traversal guard -------------------------------------

  it("PUT /pins rejects a missing file and a traversal attempt; unpin is idempotent", async () => {
    // Missing file → 400 invalid.
    const missing = await t.app.inject({
      method: "PUT",
      url: "/api/projects/routes-proj/pins",
      payload: { file: "does-not-exist.md" },
    });
    expect(missing.statusCode).toBe(400);

    // Path traversal → guarded (400), never escapes the project dir.
    const traversal = await t.app.inject({
      method: "PUT",
      url: "/api/projects/routes-proj/pins",
      payload: { file: "../../etc/passwd" },
    });
    expect(traversal.statusCode).toBe(400);

    // Empty file name → 400.
    const empty = await t.app.inject({
      method: "PUT",
      url: "/api/projects/routes-proj/pins",
      payload: { file: "" },
    });
    expect(empty.statusCode).toBe(400);

    // Unpin a file that was never pinned → 200, no-op (still []).
    const unpin = await t.app.inject({
      method: "DELETE",
      url: "/api/projects/routes-proj/pins/never-pinned.md",
    });
    expect(unpin.statusCode).toBe(200);
    expect(unpin.json().project.pinned).toEqual([]);
  });

  it("pin then unpin a real file round-trips through project.yaml", async () => {
    const project = (
      await t.app.inject({ method: "GET", url: "/api/projects/routes-proj" })
    ).json().project;
    await fs.writeFile(path.join(project.dir, "pinme.md"), "# pin", "utf8");

    const pinned = (
      await t.app.inject({
        method: "PUT",
        url: "/api/projects/routes-proj/pins",
        payload: { file: "pinme.md" },
      })
    ).json().project.pinned;
    expect(pinned).toContain("pinme.md");

    // Pinning again dedupes (still one entry).
    const again = (
      await t.app.inject({
        method: "PUT",
        url: "/api/projects/routes-proj/pins",
        payload: { file: "pinme.md" },
      })
    ).json().project.pinned;
    expect(again).toEqual(["pinme.md"]);

    const after = (
      await t.app.inject({
        method: "DELETE",
        url: "/api/projects/routes-proj/pins/pinme.md",
      })
    ).json().project.pinned;
    expect(after).not.toContain("pinme.md");
  });

  // --- context endpoints ------------------------------------------------------

  it("GET project /context returns usage after a turn and null for an unknown session", async () => {
    const sessionId = await oneTurn("routes-proj", "hello for context");
    const ctx = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/routes-proj/chats/${sessionId}/context`,
      })
    ).json();
    expect(ctx.usage).toBeTruthy();
    expect(ctx.usage.contextTokens).toBeGreaterThan(0);
    expect(ctx.usage.contextLimit).toBe(200000);

    const none = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/routes-proj/chats/00000000-0000-0000-0000-000000000000/context`,
      })
    ).json();
    expect(none.usage).toBeNull();
  });

  it("GET project /context 404s for an unknown project slug", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/projects/ghost/chats/whatever/context",
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET scratch /context returns usage after a scratch turn", async () => {
    const sessionId = await oneTurn("scratch", "scratch for context");
    const ctx = (
      await t.app.inject({ method: "GET", url: `/api/chats/${sessionId}/context` })
    ).json();
    expect(ctx.usage).toBeTruthy();
    expect(ctx.usage.contextLimit).toBe(200000);

    const none = (
      await t.app.inject({ method: "GET", url: "/api/chats/no-such-session/context" })
    ).json();
    expect(none.usage).toBeNull();
  });

  // --- rename + delete chat (project) ----------------------------------------

  it("PATCH a project chat sets then clears its custom name", async () => {
    const sessionId = await oneTurn("routes-proj", "name me");

    const rename = await t.app.inject({
      method: "PATCH",
      url: `/api/projects/routes-proj/chats/${sessionId}`,
      payload: { name: "My Renamed Chat" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().ok).toBe(true);

    t.herdctl.invalidateSessions("keeper-routes-proj");
    const chats = (
      await t.app.inject({ method: "GET", url: "/api/projects/routes-proj/chats" })
    ).json().chats;
    const renamed = chats.find((c: { sessionId: string }) => c.sessionId === sessionId);
    expect(renamed?.name).toBe("My Renamed Chat");

    // Clearing the name (null) succeeds.
    const clear = await t.app.inject({
      method: "PATCH",
      url: `/api/projects/routes-proj/chats/${sessionId}`,
      payload: { name: null },
    });
    expect(clear.statusCode).toBe(200);
  });

  it("PATCH a project chat 404s for an unknown project slug", async () => {
    const res = await t.app.inject({
      method: "PATCH",
      url: "/api/projects/ghost/chats/abc",
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE a project chat removes its transcript (removed:true), false when absent", async () => {
    const sessionId = await oneTurn("routes-proj", "delete me");

    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/routes-proj/chats/${sessionId}`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().removed).toBe(true);

    // Gone from the listing.
    t.herdctl.invalidateSessions("keeper-routes-proj");
    const chats = (
      await t.app.inject({ method: "GET", url: "/api/projects/routes-proj/chats" })
    ).json().chats;
    expect(chats.map((c: { sessionId: string }) => c.sessionId)).not.toContain(sessionId);

    // Deleting again → removed:false.
    const again = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/routes-proj/chats/${sessionId}`,
    });
    expect(again.json().removed).toBe(false);
  });

  it("DELETE a project chat 404s for an unknown project slug", async () => {
    const res = await t.app.inject({ method: "DELETE", url: "/api/projects/ghost/chats/abc" });
    expect(res.statusCode).toBe(404);
  });

  // --- rename + delete chat (scratch) ----------------------------------------

  it("PATCH + DELETE a scratch chat", async () => {
    const sessionId = await oneTurn("scratch", "scratch rename+delete");

    const rename = await t.app.inject({
      method: "PATCH",
      url: `/api/chats/${sessionId}`,
      payload: { name: "Scratch Name" },
    });
    expect(rename.statusCode).toBe(200);

    const del = await t.app.inject({ method: "DELETE", url: `/api/chats/${sessionId}` });
    expect(del.statusCode).toBe(200);
    expect(del.json().removed).toBe(true);
  });

  // --- messages listings ------------------------------------------------------

  it("GET scratch chat messages hydrates user+assistant roles", async () => {
    const sessionId = await oneTurn("scratch", "scratch messages please");
    const messages = (
      await t.app.inject({ method: "GET", url: `/api/chats/${sessionId}/messages` })
    ).json().messages;
    const roles = messages.map((m: { role: string }) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  });

  it("GET project chat messages 404s for an unknown project slug", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/projects/ghost/chats/abc/messages",
    });
    expect(res.statusCode).toBe(404);
  });

  // --- thin / convenience endpoints ------------------------------------------

  it("GET /api/fleet reports status + agents", async () => {
    const body = (await t.app.inject({ method: "GET", url: "/api/fleet" })).json();
    expect(body.status).toBeTruthy();
    const names = (body.agents as Array<{ name: string }>).map((a) => a.name);
    expect(names).toContain("scratch");
    expect(names).toContain("keeper-routes-proj");
  });

  it("GET /api/health is ok", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/health" });
    expect(res.json().ok).toBe(true);
  });

  it("POST /api/projects/:slug/chats returns the WS target metadata (201)", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/projects/routes-proj/chats" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.projectSlug).toBe("routes-proj");
    expect(body.sessionId).toBeNull();
    expect(body.ws).toBe("/ws");
  });

  it("POST /api/projects/:slug/chats 404s for an unknown project", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/projects/ghost/chats" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/projects/:slug/chats 404s for an unknown project", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/projects/ghost/chats" });
    expect(res.statusCode).toBe(404);
  });

  it("POST /api/git/push returns pushed:false when the store is not a repo", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/git/push" });
    expect(res.statusCode).toBe(200);
    expect(res.json().pushed).toBe(false);
  });

  it("git/status, git/diff and git/commit 404 for an unknown project slug", async () => {
    expect(
      (await t.app.inject({ method: "GET", url: "/api/projects/ghost/git/status" })).statusCode,
    ).toBe(404);
    expect(
      (await t.app.inject({ method: "GET", url: "/api/projects/ghost/git/diff" })).statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/api/projects/ghost/git/commit",
          payload: { message: "x" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("GET /api/projects/:slug/git/diff returns '' (200 text) when not a repo", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/projects/routes-proj/git/diff" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toBe("");
  });

  it("PATCH a project with no body succeeds (no-op update)", async () => {
    const res = await t.app.inject({ method: "PATCH", url: "/api/projects/routes-proj" });
    expect(res.statusCode).toBe(200);
    expect(res.json().project.slug).toBe("routes-proj");
  });

  it("POST /api/projects with no body 400s (name required)", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/projects" });
    expect(res.statusCode).toBe(400);
  });

  // --- GitHub device-flow endpoints (mocked fetch) ---------------------------

  describe("GitHub device-flow endpoints", () => {
    const savedClientId = process.env.PADDOCK_GITHUB_CLIENT_ID;
    const realFetch = globalThis.fetch;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeAll(() => {
      fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    });
    afterAll(() => {
      globalThis.fetch = realFetch;
      if (savedClientId === undefined) delete process.env.PADDOCK_GITHUB_CLIENT_ID;
      else process.env.PADDOCK_GITHUB_CLIENT_ID = savedClientId;
    });

    it("POST /connect 400s when no client id is configured", async () => {
      delete process.env.PADDOCK_GITHUB_CLIENT_ID;
      const res = await t.app.inject({ method: "POST", url: "/api/git/github/connect" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/not configured/i);
    });

    it("POST /connect returns the device code when configured", async () => {
      process.env.PADDOCK_GITHUB_CLIENT_ID = "Iv1.routes";
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          device_code: "DC-1",
          user_code: "AAAA-BBBB",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 900,
        }),
      );
      const res = await t.app.inject({ method: "POST", url: "/api/git/github/connect" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.userCode).toBe("AAAA-BBBB");
      expect(body.deviceCode).toBe("DC-1");
    });

    it("POST /poll requires a deviceCode (400 when missing)", async () => {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/git/github/poll",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/deviceCode required/i);
    });

    it("POST /poll surfaces pending", async () => {
      process.env.PADDOCK_GITHUB_CLIENT_ID = "Iv1.routes";
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }));
      const res = await t.app.inject({
        method: "POST",
        url: "/api/git/github/poll",
        payload: { deviceCode: "DC-1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("pending");
    });

    it("POST /poll authorizes, /api/git reports connected, /disconnect clears it", async () => {
      process.env.PADDOCK_GITHUB_CLIENT_ID = "Iv1.routes";
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "gho_routes", scope: "repo" }))
        .mockResolvedValueOnce(jsonResponse({ login: "octocat" }));
      const poll = await t.app.inject({
        method: "POST",
        url: "/api/git/github/poll",
        payload: { deviceCode: "DC-1" },
      });
      expect(poll.json().status).toBe("authorized");

      // The token file lives under the data dir at 0600.
      const tokenFile = path.join(t.cfg.dataDir, "github-auth.json");
      const st = await fs.stat(tokenFile);
      expect(st.mode & 0o777).toBe(0o600);

      // /api/git reflects the connection.
      const git = (await t.app.inject({ method: "GET", url: "/api/git" })).json();
      expect(git.github.connected).toBe(true);
      expect(git.github.login).toBe("octocat");

      // Disconnect clears it.
      const disc = await t.app.inject({ method: "POST", url: "/api/git/github/disconnect" });
      expect(disc.statusCode).toBe(200);
      expect(disc.json().ok).toBe(true);
      const after = (await t.app.inject({ method: "GET", url: "/api/git" })).json();
      expect(after.github.connected).toBe(false);
    });
  });
});
