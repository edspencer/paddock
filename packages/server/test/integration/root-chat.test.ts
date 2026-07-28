import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

/**
 * "The root is a project" (issue #516) — Phase 2: root CHATS.
 *
 * The point of the design is that this file should read exactly like
 * `chat.test.ts` with a different slug. A root chat goes down the ORDINARY
 * keeper path — not scratch's — so it streams, persists a transcript under
 * `<projectsRoot>/.chats/`, lists, hydrates, resumes, and archives like any
 * other chat.
 */
describe("integration: root chats (#516)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  const isComplete = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  beforeAll(async () => {
    t = await startTestApp({
      script: {
        "Hello root": "I am the root keeper.",
      },
    });
    await t.app.inject({ method: "POST", url: "/api/root-project", payload: { name: "Root" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("streams a root chat and stores its transcript at <projectsRoot>/.chats", async () => {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "__root", sessionId: null, message: "Hello root" },
    });

    const complete = await ws.waitFor(isComplete("__root"), { from: mark });
    expect(complete.payload?.success).toBe(true);
    const sessionId = complete.payload?.sessionId as string;
    expect(sessionId).toBeTruthy();
    expect(ws.responseText(mark)).toContain("I am the root keeper.");

    // The transcript lands in the ROOT's own `.chats/` — same layout as any
    // project's, one level up.
    const entries = await fs.readdir(path.join(t.projectsRoot, ".chats"));
    expect(entries.some((f) => f.startsWith(sessionId))).toBe(true);

    // …and it lists + hydrates through the ordinary chat routes.
    const chats = (
      await t.app.inject({ method: "GET", url: "/api/projects/__root/chats" })
    ).json().chats;
    expect(chats.map((c: { sessionId: string }) => c.sessionId)).toContain(sessionId);

    const messages = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/__root/chats/${sessionId}/messages`,
      })
    ).json().messages;
    expect(messages.map((m: { role: string }) => m.role)).toContain("assistant");
  });

  it("resumes the SAME root session — continuity, not a fresh chat each turn", async () => {
    const m1 = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: "__root",
        sessionId: null,
        message: "the codeword is pomegranate",
      },
    });
    const c1 = await ws.waitFor(isComplete("__root"), { from: m1 });
    const sessionId = c1.payload?.sessionId as string;

    const m2 = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "__root", sessionId, message: "what was the codeword?" },
    });
    const c2 = await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.sessionId === sessionId,
      { from: m2 },
    );
    expect(c2.payload?.success).toBe(true);
    expect(ws.responseText(m2).toLowerCase()).toContain("pomegranate");
  });

  it("carries the ordinary chat sidecars — rename, star, archive, mark-unread", async () => {
    const sessionId = (
      await t.app.inject({ method: "GET", url: "/api/projects/__root/chats" })
    ).json().chats[0].sessionId;
    const base = `/api/projects/__root/chats/${sessionId}`;

    expect(
      (await t.app.inject({ method: "PATCH", url: base, payload: { name: "Renamed" } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `${base}/star`,
          payload: { starred: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `${base}/archive`,
          payload: { archived: true },
        })
      ).statusCode,
    ).toBe(200);

    const chat = (
      await t.app.inject({ method: "GET", url: "/api/projects/__root/chats" })
    ).json().chats.find((c: { sessionId: string }) => c.sessionId === sessionId);
    expect(chat.name).toBe("Renamed");
    expect(chat.starred).toBe(true);
    expect(chat.archived).toBe(true);
  });
});
