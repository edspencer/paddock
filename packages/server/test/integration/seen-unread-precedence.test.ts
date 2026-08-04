/**
 * Explicit "mark unread" beats an inferred "seen" (#608).
 *
 * `POST .../chats/:id/seen` clears the MANUAL unread override (#458) — right for
 * the read/unread toggle and for opening a chat, wrong for the web client's
 * inferred mark-seen when a turn happens to land while the chat is focused: that
 * silently spent a flag the user (or an API caller) had just set, and the `/unread`
 * caller was never told. `/seen` now takes `keepUnread: true` for that inferred
 * case, and always reports the resulting flag back.
 *
 * Uses a REAL turn so the chat exists and its list DTO can be inspected — the flag
 * surviving in `unread-state.json` is only interesting if the chat list still shows
 * it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const SLUG = "seen-precedence";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === slug &&
  typeof e.payload?.sessionId === "string";

describe("integration: /seen vs the manual unread override (#608)", () => {
  let t: TestApp;
  let ws: WsClient;
  let sessionId: string;

  beforeAll(async () => {
    t = await startTestApp({
      script: { "hello there": "hi from the keeper" },
      sweepIntervalMs: 600_000,
    });
    const { port } = await listen(t.app);
    ws = await connectWs(port);
    await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Seen Precedence" },
    });
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: SLUG, sessionId: null, message: "hello there" },
    });
    const complete = await ws.waitFor(isComplete(SLUG), { from: mark });
    sessionId = complete.payload!.sessionId as string;
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  /** The chat's manual-unread flag as the chat list reports it. */
  const flagged = async (): Promise<boolean> => {
    const chats = (await t.app.inject({ method: "GET", url: `/api/projects/${SLUG}/chats` })).json()
      .chats as { sessionId: string; unread?: boolean }[];
    return chats.find((c) => c.sessionId === sessionId)?.unread === true;
  };

  const setUnread = (unread: boolean) =>
    t.app.inject({
      method: "POST",
      url: `/api/projects/${SLUG}/chats/${sessionId}/unread`,
      headers: { "content-type": "application/json" },
      payload: { unread },
    });

  const seen = (body: Record<string, unknown>) =>
    t.app.inject({
      method: "POST",
      url: `/api/projects/${SLUG}/chats/${sessionId}/seen`,
      headers: { "content-type": "application/json" },
      payload: body,
    });

  it("keepUnread leaves an explicit flag intact while still advancing lastSeen", async () => {
    expect((await setUnread(true)).statusCode).toBe(200);
    expect(await flagged()).toBe(true);

    const when = Date.now();
    const res = await seen({ when, keepUnread: true });
    expect(res.statusCode).toBe(200);

    // The flag survives the inferred mark-seen…
    expect(await flagged()).toBe(true);
    // …and the caller is told so, rather than getting a bare `{ ok: true }`.
    expect(res.json()).toMatchObject({ ok: true, lastSeen: when, unread: true });
    // …and the watermark still moved (the user did see the turn land).
    const chats = (await t.app.inject({ method: "GET", url: `/api/projects/${SLUG}/chats` })).json()
      .chats as { sessionId: string; lastSeen?: number }[];
    expect(chats.find((c) => c.sessionId === sessionId)?.lastSeen).toBe(when);
  });

  it("an ordinary /seen still spends the flag and marks the chat seen", async () => {
    expect((await setUnread(true)).statusCode).toBe(200);
    expect(await flagged()).toBe(true);

    const when = Date.now() + 1000;
    const res = await seen({ when });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, lastSeen: when, unread: false });
    expect(await flagged()).toBe(false);
  });

  it("keepUnread on a chat with no flag is an ordinary mark-seen", async () => {
    expect(await flagged()).toBe(false);
    const when = Date.now() + 2000;
    const res = await seen({ when, keepUnread: true });
    expect(res.json()).toMatchObject({ ok: true, lastSeen: when, unread: false });
    expect(await flagged()).toBe(false);
  });
});
