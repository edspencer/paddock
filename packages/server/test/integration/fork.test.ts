import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

/**
 * End-to-end "fork chat" through the REAL @herdctl/core CLI runtime + the fake
 * `claude`. Fork is EAGER: `POST /chats/:id/fork` duplicates the transcript into a
 * brand-new session immediately (source untouched), so the fork is a real,
 * resumable chat with the parent's full history from the start — no first message
 * required. This test proves the copy is discoverable, correctly named, leaves the
 * source intact, and — crucially — is resumable with the inherited context.
 */
describe("integration: fork chat (eager transcript copy, real CLI runtime)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  const isComplete = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  async function newChat(slug: string, message: string): Promise<string> {
    const mark = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message } });
    return (await ws.waitFor(isComplete(slug), { from: mark })).payload?.sessionId as string;
  }

  const messagesOf = async (slug: string, id: string): Promise<string> => {
    const body = (
      await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats/${id}/messages` })
    ).json();
    return (body.messages as Array<{ content: string }>).map((m) => m.content).join("\n");
  };

  beforeAll(async () => {
    t = await startTestApp();
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Fork Proj" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("forks a chat into a new, named, resumable session that inherits context", async () => {
    // A parent chat with a codeword in its history.
    const parentId = await newChat("fork-proj", "the codeword is pomegranate");

    // Fork it eagerly (no message sent yet).
    const forkRes = await t.app.inject({
      method: "POST",
      url: `/api/projects/fork-proj/chats/${parentId}/fork`,
      payload: { name: "Fork of the codeword" },
    });
    expect(forkRes.statusCode).toBe(201);
    const childId = forkRes.json().sessionId as string;

    // A brand-new id, distinct from the parent.
    expect(childId).toBeTruthy();
    expect(childId).not.toBe(parentId);

    // The fork exists in the chat list right away — named, and BEFORE any message
    // is sent to it — with both sessions present.
    const chats = (
      await t.app.inject({ method: "GET", url: "/api/projects/fork-proj/chats" })
    ).json().chats as Array<{ sessionId: string; name: string }>;
    const child = chats.find((c) => c.sessionId === childId);
    expect(child?.name).toBe("Fork of the codeword");
    expect(chats.map((c) => c.sessionId)).toContain(parentId);

    // The fork's transcript already carries the parent's full history (copied).
    expect(await messagesOf("fork-proj", childId)).toContain("the codeword is pomegranate");

    // The fork is a real resumable session: resuming it (by its own id) recalls
    // the inherited codeword — the copied transcript works as live context.
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "fork-proj", sessionId: childId, message: "what was the codeword?" },
    });
    const done = await ws.waitFor(isComplete("fork-proj"), { from: mark });
    expect(done.payload?.sessionId).toBe(childId); // resumed the same id, no new session
    expect(ws.responseText(mark)).toContain("pomegranate");

    // The source chat is untouched: it never learned the fork's question.
    expect(await messagesOf("fork-proj", parentId)).not.toContain("what was the codeword?");
  });

  it("404s when forking a session that does not exist", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/fork-proj/chats/00000000-0000-0000-0000-000000000000/fork",
      payload: {},
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
