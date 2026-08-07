/**
 * #730 — the turn AFTER a delete must land in the chat it was addressed to.
 *
 * The reported failure, reproduced through the browser against a live instance:
 * delete the chat you have just finished, go back to an older one, send a
 * message — and the message is silently misfiled into a BRAND-NEW session. The
 * URL and the transcript on screen keep showing the chat you are in, so nothing
 * looks wrong until you reload: your message is gone from that chat, a stray new
 * chat sits in the sidebar, and the keeper answered with no memory of the
 * conversation because it was a fresh session.
 *
 * The mechanism is herdctl's agent-level session pointer
 * (`<stateDir>/sessions/<agent>.json`) — one "current session" per agent,
 * rewritten after every batch turn, so it always names the most-recently-active
 * chat. Deleting that chat leaves the pointer dangling. On the next turn the
 * JobExecutor's timeout-aware read judges it `file_not_found`, clears it, and
 * then REFUSES the caller's explicit `resume` because a pointer had existed a
 * moment ago — which it reads as "this agent's session just expired, start
 * fresh". The pointer named B; the caller asked for A; A's transcript is right
 * there on disk. See `HerdctlService.dropAgentSessionPointer` for the fix and
 * for why the real repair belongs upstream.
 *
 * Every rule the reproduction established falls out of that, and each is pinned
 * below: only the MOST-RECENTLY-ACTIVE chat's deletion breaks the next turn,
 * `promote` breaks it too (same call), and `archive` does not (nothing is
 * removed, so nothing dangles).
 *
 * These tests run on the integration tier's `driveMode: batch` — which is where
 * the bug lives. The SDK session path never reads the pointer when the caller
 * names a session, so it is structurally immune.
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

/** Drive one real turn through the fake `claude`; returns the landed session id. */
async function turn(
  ws: WsClient,
  slug: string,
  sessionId: string | null,
  message: string,
): Promise<string> {
  const mark = ws.mark();
  ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId, message } });
  const complete = await ws.waitFor(isComplete(slug), { from: mark });
  return complete.payload?.sessionId as string;
}

describe("integration: the turn after a delete lands in the chat it was sent to (#730)", () => {
  let t: TestApp;
  let ws: WsClient;

  const transcriptOf = (slug: string, sessionId: string) =>
    fs.readFile(path.join(t.cfg.projectsRoot, slug, ".chats", `${sessionId}.jsonl`), "utf8");

  const chatIds = async (slug: string): Promise<string[]> =>
    (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` }))
      .json()
      .chats.map((c: { sessionId: string }) => c.sessionId);

  beforeAll(async () => {
    t = await startTestApp();
    const { port } = await listen(t.app);
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  const project = async (slug: string) => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: slug } });
    return slug;
  };

  it("resumes A after the most-recently-active chat B is deleted", async () => {
    const slug = await project("del-then-resume");

    const a = await turn(ws, slug, null, "the codeword is zebra");
    const b = await turn(ws, slug, null, "a second chat");
    expect(b).not.toBe(a);

    const del = await t.app.inject({ method: "DELETE", url: `/api/projects/${slug}/chats/${b}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, removed: true });

    const landed = await turn(ws, slug, a, "what was the codeword?");

    // The turn continued A — not a new session wearing A's URL.
    expect(landed).toBe(a);
    // And it really is in A's transcript, with A's history behind it: the whole
    // symptom is a turn that reports one session and writes another.
    const transcript = await transcriptOf(slug, a);
    expect(transcript).toContain("what was the codeword?");
    expect(transcript).toContain("The codeword was zebra.");
    // No stray chat appeared alongside it.
    expect(await chatIds(slug)).toEqual([a]);
  });

  it("resumes A after B is promoted away (promote deletes the source the same way)", async () => {
    const slug = await project("promote-then-resume");

    const a = await turn(ws, slug, null, "the codeword is artichoke");
    const b = await turn(ws, slug, null, "a chat worth promoting");

    const promote = await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${b}/promote`,
      payload: { name: "Promoted Away" },
    });
    expect(promote.statusCode).toBe(201);

    const landed = await turn(ws, slug, a, "what was the codeword?");

    expect(landed).toBe(a);
    expect(await transcriptOf(slug, a)).toContain("The codeword was artichoke.");
    expect(await chatIds(slug)).toEqual([a]);
  });

  it("is unaffected by deleting an OLDER chat, or by archiving", async () => {
    const slug = await project("older-and-archive");

    const a = await turn(ws, slug, null, "the codeword is rhubarb");
    const b = await turn(ws, slug, null, "the newest chat");

    // Deleting the OLDER chat leaves the pointer (which names B) intact.
    expect(
      (await t.app.inject({ method: "DELETE", url: `/api/projects/${slug}/chats/${a}` }))
        .statusCode,
    ).toBe(200);
    expect(await turn(ws, slug, b, "still here?")).toBe(b);

    // Archiving removes nothing from disk, so it never dangles the pointer.
    const c = await turn(ws, slug, null, "one more chat");
    expect(
      (await t.app.inject({ method: "POST", url: `/api/projects/${slug}/chats/${c}/archive` }))
        .statusCode,
    ).toBe(200);
    expect(await turn(ws, slug, b, "and still here?")).toBe(b);
  });
});
