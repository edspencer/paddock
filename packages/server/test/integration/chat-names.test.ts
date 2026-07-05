/**
 * Chat display names are not polluted by the injected preload wrapper (issue
 * #62). Runs a REAL preload turn (so ws.ts wraps the OVERVIEW into the first user
 * message) and asserts the chats list shows the user's actual request as the name
 * — exercising ws.ts's wrapPreload + the chat-list's read-first-message + strip
 * end to end, so the build and strip halves can't drift apart.
 *
 * The overview is deliberately > 100 chars so Claude Code's own preview truncates
 * INSIDE the wrapper (the exact case a naive preview-string strip can't handle).
 *
 * Each test uses its own project so a prior turn's curation sweep can't race the
 * next test's keeper turn on a shared chat dir (see ws-reattach.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === slug &&
  typeof e.payload?.sessionId === "string";

const LONG_OVERVIEW =
  "# Project Overview\n\n" +
  "This is a deliberately long curated overview so that Claude Code's 100-char " +
  "preview truncates inside the injected context block, well before the request marker.";

describe("integration: chat display names strip the preload wrapper (issue #62)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  async function freshProject(overview?: string): Promise<string> {
    const name = `Names ${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    const slug = name.toLowerCase().replace(/\s+/g, "-");
    if (overview) await t.projects.writeOverview(slug, overview);
    return slug;
  }

  async function chatsOf(slug: string) {
    return (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` })).json().chats;
  }

  it("names a preload chat after the user's request, not the injected overview", async () => {
    const slug = await freshProject(LONG_OVERVIEW);
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: slug,
        sessionId: null,
        message: "how do I add a new keeper agent?",
        preloadContext: true,
      },
    });
    const complete = await ws.waitFor(isComplete(slug), { from: mark });
    const sessionId = complete.payload!.sessionId as string;

    // Sanity: the wrapper really is in the transcript's first user message.
    const messages = (
      await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats/${sessionId}/messages` })
    ).json().messages;
    expect(messages.find((m: { role: string }) => m.role === "user").content).toContain(
      "<project-context>",
    );

    // But the chat list name/preview is the clean request.
    const chat = (await chatsOf(slug)).find((c: { sessionId: string }) => c.sessionId === sessionId);
    expect(chat).toBeTruthy();
    expect(chat.name).toBe("how do I add a new keeper agent?");
    expect(chat.name).not.toContain("<project-context>");
    expect(chat.preview).not.toContain("<project-context>");

    // The enriched project detail endpoint cleans names the same way.
    const detail = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}` })).json();
    const detailChat = detail.chats.find((c: { sessionId: string }) => c.sessionId === sessionId);
    expect(detailChat.name).toBe("how do I add a new keeper agent?");
  });

  it("a non-preload chat's name is unchanged (the real first message)", async () => {
    const slug = await freshProject();
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: slug, sessionId: null, message: "plain chat no preload" },
    });
    const complete = await ws.waitFor(isComplete(slug), { from: mark });
    const sessionId = complete.payload!.sessionId as string;

    const chat = (await chatsOf(slug)).find((c: { sessionId: string }) => c.sessionId === sessionId);
    expect(chat.name).toBe("plain chat no preload");
  });
});
