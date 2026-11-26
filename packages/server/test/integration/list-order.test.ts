import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

/**
 * The sidebar list-order routes through the REAL app: the workspace-scoped
 * `/chat-order` (mounted on both `/api/root` and `/api/projects/:slug`) and the
 * instance `/api/project-order`, plus the delete paths that clear a chat's or a
 * project's slot so a recycled id or slug starts unplaced.
 */
describe("integration: chat-order and project-order routes", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  let n = 0;

  const isComplete = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  async function project(): Promise<string> {
    const slug = `order-${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: slug } });
    return slug;
  }

  async function chatIn(slug: string): Promise<string> {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: slug, sessionId: null, message: "hello order" },
    });
    return (await ws.waitFor(isComplete(slug), { from: mark })).payload?.sessionId as string;
  }

  const patch = (url: string, payload: unknown) =>
    t.app.inject({ method: "PATCH", url, payload: payload as Record<string, unknown> });

  beforeAll(async () => {
    // OpenAPI is off by default; on, so the last test can read the document.
    t = await startTestApp({
      script: { "hello order": "ordered" },
      env: { PADDOCK_OPENAPI_ENABLED: "1" },
    });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("serves the default order, then persists a patch", async () => {
    const slug = await project();
    const url = `/api/projects/${slug}/chat-order`;
    expect((await t.app.inject({ method: "GET", url })).json()).toEqual({
      mode: "recent",
      orders: {},
    });
    const res = await patch(url, { mode: "manual", orders: { "active:nested:": ["b", "a"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "manual", orders: { "active:nested:": ["b", "a"] } });
    expect((await t.app.inject({ method: "GET", url })).json().mode).toBe("manual");
  });

  it("keeps the root workspace's order separate from a project's", async () => {
    const slug = await project();
    await patch("/api/root/chat-order", { mode: "created" });
    expect((await t.app.inject({ method: "GET", url: "/api/root/chat-order" })).json().mode).toBe(
      "created",
    );
    expect(
      (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chat-order` })).json().mode,
    ).toBe("recent");
  });

  it("answers 404 for an unknown workspace and 400 for a malformed body", async () => {
    expect(
      (await t.app.inject({ method: "GET", url: "/api/projects/no-such/chat-order" })).statusCode,
    ).toBe(404);
    const slug = await project();
    const url = `/api/projects/${slug}/chat-order`;
    expect((await patch(url, { mode: "sideways" })).statusCode).toBe(400);
    expect((await patch(url, { orders: { g: [1, 2] } })).statusCode).toBe(400);
    expect((await patch("/api/project-order", { orders: { g: "a" } })).statusCode).toBe(400);
  });

  it("drops a deleted chat from the chat order", async () => {
    const slug = await project();
    const id = await chatIn(slug);
    const url = `/api/projects/${slug}/chat-order`;
    await patch(url, {
      mode: "manual",
      orders: { "active:nested:": ["x", id], [`active:nested:${id}`]: ["y"] },
    });
    await t.app.inject({ method: "DELETE", url: `/api/projects/${slug}/chats/${id}` });
    expect((await t.app.inject({ method: "GET", url })).json()).toEqual({
      mode: "manual",
      orders: { "active:nested:": ["x"] },
    });
  });

  it("drops batch-deleted chats from the chat order", async () => {
    const slug = await project();
    const id = await chatIn(slug);
    const url = `/api/projects/${slug}/chat-order`;
    await patch(url, { mode: "manual", orders: { "active:flat:": [id, "x"] } });
    await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/batch/delete`,
      payload: { sessionIds: [id] },
    });
    expect((await t.app.inject({ method: "GET", url })).json().orders).toEqual({
      "active:flat:": ["x"],
    });
  });

  it("persists the project order; a project delete clears its slot and chat order", async () => {
    const slug = await project();
    await patch(`/api/projects/${slug}/chat-order`, { mode: "created" });
    const res = await patch("/api/project-order", {
      mode: "manual",
      orders: { "": ["keep", slug] },
    });
    expect(res.json()).toEqual({ mode: "manual", orders: { "": ["keep", slug] } });

    await t.app.inject({ method: "DELETE", url: `/api/projects/${slug}` });
    expect((await t.app.inject({ method: "GET", url: "/api/project-order" })).json()).toEqual({
      mode: "manual",
      orders: { "": ["keep"] },
    });
    // Re-created under the same slug, it starts from the default.
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: slug } });
    expect(
      (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chat-order` })).json().mode,
    ).toBe("recent");
  });

  it("documents all four routes in the OpenAPI schema", async () => {
    const doc = (
      t.app as unknown as { swagger: () => { paths: Record<string, Record<string, unknown>> } }
    ).swagger();
    expect(Object.keys(doc.paths["/api/project-order"] ?? {})).toEqual(
      expect.arrayContaining(["get", "patch"]),
    );
    expect(Object.keys(doc.paths["/api/projects/{slug}/chat-order"] ?? {})).toEqual(
      expect.arrayContaining(["get", "patch"]),
    );
  });
});
