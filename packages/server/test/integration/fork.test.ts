import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

/**
 * End-to-end "fork chat" over WS through the REAL @herdctl/core CLI runtime + the
 * fake `claude` binary (which honors `--fork-session`). Proves the whole chain:
 * a `chat:send` with `forkFrom` resumes the source's context but writes a
 * BRAND-NEW session id, the child inherits the parent's context (codeword
 * recall), both sessions coexist, and the source transcript is left untouched.
 *
 * We assert the fork's correctness via the TRANSCRIPT (the child's answer recalls
 * the parent's codeword) rather than the streamed chunks: a fork's first turn
 * skips the copied history on the wire (herdctl's watcher initializes past it),
 * and the exact chunk timing is sensitive to the fake's compressed clock + the
 * filesystem's mtime granularity. Real streaming is covered by the resume turn
 * below (second test) and by the real-`claude` spike.
 *
 * Sweep isolation: a fork is a *new-session* turn, so it locates its transcript
 * via new-file detection (like any new chat) — which can attach to a concurrent
 * curation sweep's transcript written into the same project dir. We use a huge
 * sweep interval AND wait for the parent turn's (immediate, first-time) sweep to
 * finish before forking, so no sweep runs concurrently with a fork turn.
 */
describe("integration: fork chat over WS (real CLI runtime, fake claude)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  const isComplete = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  /** Fire a turn on a new chat and return its established session id. */
  async function newChat(slug: string, message: string): Promise<string> {
    const mark = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message } });
    return (await ws.waitFor(isComplete(slug), { from: mark })).payload?.sessionId as string;
  }

  /**
   * Wait for the post-turn curation sweep to run to completion (it writes
   * OVERVIEW.md → project.hasOverview flips true). Forking only after this means
   * no sweeper turn is writing a competing transcript while the fork turn detects
   * its new session file.
   */
  async function waitForSweep(slug: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const p = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}` })).json()
        .project;
      if (p?.hasOverview) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timed out waiting for the curation sweep to complete");
  }

  beforeAll(async () => {
    // Huge sweep interval: the FIRST turn in a project still sweeps immediately
    // (no prior watermark), but once that sweep runs no further sweep fires
    // within the test — so a fork turn never races a concurrent sweeper turn.
    t = await startTestApp({ sweepIntervalMs: 60 * 60 * 1000 });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Fork Proj" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("forks a chat into a new session that inherits the parent's context", async () => {
    // Parent chat with a codeword in its context; then let its sweep settle.
    const parentId = await newChat("fork-proj", "the codeword is pomegranate");
    await waitForSweep("fork-proj");

    // Fork it: a NEW chat (sessionId null) that forks from the parent. Its first
    // message asks for the codeword — recall proves the child inherited the
    // parent's transcript as context.
    const m2 = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: "fork-proj",
        sessionId: null,
        forkFrom: parentId,
        message: "what was the codeword?",
      },
    });
    const childId = (await ws.waitFor(isComplete("fork-proj"), { from: m2 })).payload
      ?.sessionId as string;

    // The fork wrote a BRAND-NEW session id, distinct from the parent.
    expect(childId).toBeTruthy();
    expect(childId).not.toBe(parentId);

    // Both sessions now exist independently in the project's chat list.
    const chats = (
      await t.app.inject({ method: "GET", url: "/api/projects/fork-proj/chats" })
    ).json().chats as Array<{ sessionId: string }>;
    const ids = chats.map((c) => c.sessionId);
    expect(ids).toContain(parentId);
    expect(ids).toContain(childId);

    // The child's transcript carries the inherited history PLUS its own new turn,
    // and its answer recalls the parent's codeword — proving it reasoned over the
    // inherited context, not just that lines were copied.
    const childMessages = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/fork-proj/chats/${childId}/messages`,
      })
    ).json().messages as Array<{ role: string; content: string }>;
    const childText = childMessages.map((m) => m.content).join("\n");
    expect(childText).toContain("the codeword is pomegranate"); // inherited history
    expect(childText).toContain("what was the codeword?"); // the child's own turn
    expect(childText).toContain("The codeword was pomegranate."); // reasoned over context

    // The parent transcript is untouched by the fork: it never learned the
    // child's question.
    const parentMessages = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/fork-proj/chats/${parentId}/messages`,
      })
    ).json().messages as Array<{ role: string; content: string }>;
    const parentText = parentMessages.map((m) => m.content).join("\n");
    expect(parentText).not.toContain("what was the codeword?");
  });

  it("a forked chat then resumes as its own independent session", async () => {
    const parentId = await newChat("fork-proj", "the codeword is saffron");
    await waitForSweep("fork-proj");

    // Fork it.
    const mf = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: "fork-proj",
        sessionId: null,
        forkFrom: parentId,
        message: "acknowledge the fork",
      },
    });
    const childId = (await ws.waitFor(isComplete("fork-proj"), { from: mf })).payload
      ?.sessionId as string;
    expect(childId).not.toBe(parentId);

    // RESUME the child by its own id (no forkFrom) and confirm continuity: it
    // still recalls the inherited codeword AND streams its reply — proving it's a
    // real, resumable session in its own right (resume watches the file by id, so
    // its streaming is not subject to the fork's new-file timing).
    const mr = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "fork-proj", sessionId: childId, message: "what was the codeword?" },
    });
    const cr = await ws.waitFor(isComplete("fork-proj"), { from: mr });
    expect(cr.payload?.sessionId).toBe(childId); // resumed the same id, no new fork
    expect(ws.responseText(mr)).toContain("saffron");
  });
});
