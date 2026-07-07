import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

/**
 * End-to-end "archive chat" (#95) through the REAL app + fake CLI runtime.
 * Archiving is a non-destructive toggle on a Paddock-side sidecar flag: the
 * chat DTO's `archived` flips, the transcript is untouched (still resumable),
 * and deleting a chat clears its flag.
 *
 * Each test gets its OWN project so its chat is that project's first session and
 * surfaces immediately — a second new chat in an already-listed project can lag
 * herdctl's 30s session-discovery cache (see HerdctlService's freshness note).
 */
describe("integration: archive chat (non-destructive flag)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  let n = 0;

  const isComplete = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  /** Create a uniquely-named project and start one chat in it; returns both ids. */
  async function projectWithChat(): Promise<{ slug: string; id: string }> {
    const slug = `arch-${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: slug } });
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: slug, sessionId: null, message: "hello archive" },
    });
    const id = (await ws.waitFor(isComplete(slug), { from: mark })).payload?.sessionId as string;
    return { slug, id };
  }

  const chatDto = async (slug: string, id: string) => {
    const chats = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` }))
      .json().chats as Array<{ sessionId: string; archived?: boolean }>;
    return chats.find((c) => c.sessionId === id);
  };

  // The project-detail endpoint (used on initial load) must carry `archived` too.
  const detailChatDto = async (slug: string, id: string) => {
    const chats = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}` }))
      .json().chats as Array<{ sessionId: string; archived?: boolean }>;
    return chats.find((c) => c.sessionId === id);
  };

  const setArchived = (slug: string, id: string, archived?: boolean) =>
    t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${id}/archive`,
      payload: archived === undefined ? {} : { archived },
    });

  beforeAll(async () => {
    t = await startTestApp({ script: { "hello archive": "hi from the keeper" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("chats are not archived by default", async () => {
    const { slug, id } = await projectWithChat();
    expect((await chatDto(slug, id))?.archived).toBe(false);
  });

  it("archives, then unarchives, a chat via the toggle endpoint", async () => {
    const { slug, id } = await projectWithChat();

    const on = await setArchived(slug, id, true);
    expect(on.statusCode).toBe(200);
    expect(on.json().archived).toBe(true);
    expect((await chatDto(slug, id))?.archived).toBe(true);
    // Both the /chats list AND the project-detail endpoint must agree, so the
    // flag survives a fresh page load (which hydrates from project detail).
    expect((await detailChatDto(slug, id))?.archived).toBe(true);

    // The archived chat is still discoverable + resumable (transcript untouched).
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: slug, sessionId: id, message: "hello archive" },
    });
    expect((await ws.waitFor(isComplete(slug), { from: mark })).payload?.sessionId).toBe(id);

    const off = await setArchived(slug, id, false);
    expect(off.statusCode).toBe(200);
    expect((await chatDto(slug, id))?.archived).toBe(false);
  });

  it("defaults to archived:true when the body omits the flag", async () => {
    const { slug, id } = await projectWithChat();
    const res = await setArchived(slug, id);
    expect(res.json().archived).toBe(true);
    expect((await chatDto(slug, id))?.archived).toBe(true);
  });

  it("clears the archived flag when the chat is deleted", async () => {
    const { slug, id } = await projectWithChat();
    await setArchived(slug, id, true);
    await t.app.inject({ method: "DELETE", url: `/api/projects/${slug}/chats/${id}` });
    // Gone from the list entirely; no orphan flag lingers for a reused id.
    expect(await chatDto(slug, id)).toBeUndefined();
  });
});
