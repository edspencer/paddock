import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

/**
 * End-to-end "star chat" (#373) through the REAL app + fake CLI runtime.
 * Starring is a non-destructive toggle on a Paddock-side sidecar flag, ORTHOGONAL
 * to archiving: the chat DTO's `starred` flips, the transcript is untouched, and
 * deleting a chat clears its flag. Mirrors the archive integration test.
 */
describe("integration: star chat (non-destructive, orthogonal flag)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  let n = 0;

  const isComplete = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  async function projectWithChat(): Promise<{ slug: string; id: string }> {
    const slug = `star-${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: slug } });
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: slug, sessionId: null, message: "hello star" },
    });
    const id = (await ws.waitFor(isComplete(slug), { from: mark })).payload?.sessionId as string;
    return { slug, id };
  }

  const chatDto = async (slug: string, id: string) => {
    const chats = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` }))
      .json().chats as Array<{ sessionId: string; starred?: boolean; archived?: boolean }>;
    return chats.find((c) => c.sessionId === id);
  };

  const detailChatDto = async (slug: string, id: string) => {
    const chats = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}` }))
      .json().chats as Array<{ sessionId: string; starred?: boolean; archived?: boolean }>;
    return chats.find((c) => c.sessionId === id);
  };

  const setStarred = (slug: string, id: string, starred?: boolean) =>
    t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${id}/star`,
      payload: starred === undefined ? {} : { starred },
    });

  const setArchived = (slug: string, id: string, archived?: boolean) =>
    t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${id}/archive`,
      payload: archived === undefined ? {} : { archived },
    });

  beforeAll(async () => {
    t = await startTestApp({ script: { "hello star": "hi from the keeper" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("chats are not starred by default", async () => {
    const { slug, id } = await projectWithChat();
    expect((await chatDto(slug, id))?.starred).toBe(false);
  });

  it("stars, then unstars, a chat via the toggle endpoint", async () => {
    const { slug, id } = await projectWithChat();

    const on = await setStarred(slug, id, true);
    expect(on.statusCode).toBe(200);
    expect(on.json().starred).toBe(true);
    expect((await chatDto(slug, id))?.starred).toBe(true);
    // Both the /chats list AND the project-detail endpoint carry the flag, so it
    // survives a fresh page load (which hydrates from project detail).
    expect((await detailChatDto(slug, id))?.starred).toBe(true);

    const off = await setStarred(slug, id, false);
    expect(off.statusCode).toBe(200);
    expect((await chatDto(slug, id))?.starred).toBe(false);
  });

  it("defaults to starred:true when the body omits the flag", async () => {
    const { slug, id } = await projectWithChat();
    const res = await setStarred(slug, id);
    expect(res.json().starred).toBe(true);
    expect((await chatDto(slug, id))?.starred).toBe(true);
  });

  it("star is orthogonal to archive (a chat can be both)", async () => {
    const { slug, id } = await projectWithChat();
    await setStarred(slug, id, true);
    await setArchived(slug, id, true);
    const dto = await chatDto(slug, id);
    expect(dto?.starred).toBe(true);
    expect(dto?.archived).toBe(true);
    // Unstarring leaves the archived flag intact.
    await setStarred(slug, id, false);
    const dto2 = await chatDto(slug, id);
    expect(dto2?.starred).toBe(false);
    expect(dto2?.archived).toBe(true);
  });

  it("clears the starred flag when the chat is deleted", async () => {
    const { slug, id } = await projectWithChat();
    await setStarred(slug, id, true);
    await t.app.inject({ method: "DELETE", url: `/api/projects/${slug}/chats/${id}` });
    expect(await chatDto(slug, id)).toBeUndefined();
  });
});
