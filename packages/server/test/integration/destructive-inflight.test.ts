/**
 * Destructive chat operations vs. an IN-FLIGHT turn (issue #731).
 *
 * A chat's transcript is written by `claude` itself, straight through the
 * symlink `ensureProjectAgent` plants — paddock never owns the file handle. So
 * every destructive operation races a live subprocess, and before #731 nothing
 * interlocked the two. Deleting a chat mid-turn unlinked the JSONL and emptied
 * the list, then the still-running process re-created the SAME file from its own
 * tail: the chat came back, named after its raw session id, with a 3-line
 * transcript opening on an orphan `tool_result` and every prior turn gone.
 * Promote lost the chat from BOTH projects the same way; revert truncated under
 * the writer; fork copied a transcript that ended on an unanswered `tool_use`.
 *
 * These tests drive that exact window server-side — no browser needed, this is
 * entirely lifecycle — using the fake `claude`'s existing directives:
 *   - `[[SLOWTOOL]]` writes a `tool_use`, holds it in flight for
 *     PADDOCK_FAKE_SLOWTOOL_MS, then writes the paired `tool_result`. The hold is
 *     the window a destructive op has to land inside, and the write AFTER it is
 *     what resurrects a deleted chat.
 *   - `[[HANG]]` never completes at all — the hung-turn case, where "refuse
 *     while a turn is running" would strand the user forever.
 *
 * Every test here FAILS on main.
 *
 * One shape is worth spelling out, because it is what these assertions are
 * really pinning. On main, deleting a chat mid-turn does not merely fail to stop
 * the turn — the turn's `claude` had not spawned yet, finds no transcript left to
 * `--resume`, and starts a WHOLE NEW SESSION. So the project ends up with a
 * stray chat under a session id nobody asked for, carrying the deleted chat's
 * tail, while `chat:complete { success: true }` is streamed to the chat that no
 * longer exists. Asserting the chat list is EMPTY catches that, the same-id
 * resurrection Ed saw on the session runtime, and anything else that leaves a
 * chat behind.
 *
 * A caveat worth stating out loud (cf. #717): the fake accepts transcript shapes
 * the real Anthropic Messages API rejects — an unpaired `tool_use`, an
 * unexpected `tool_result`. So the assertions below prove the transcripts are
 * STRUCTURALLY sound; they cannot prove real-API resumability, because nothing
 * in this tier can.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

/** How long the fake holds its tool in flight. Long enough to act inside, short enough to wait out. */
const SLOWTOOL_MS = 4000;
/** How long to watch for a resurrection after the op — comfortably past SLOWTOOL_MS. */
const SETTLE_MS = SLOWTOOL_MS + 3000;

describe("integration: destructive ops vs an in-flight turn (#731)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp({
      // The curation sweep would otherwise start its own turns mid-test.
      sweepIntervalMs: 600_000,
      env: { PADDOCK_FAKE_SLOWTOOL_MS: String(SLOWTOOL_MS) },
    });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  // --- harness ------------------------------------------------------------

  /** A fresh project per test: herdctl's session-discovery cache is per-agent. */
  async function freshProject(): Promise<string> {
    const slug = `inflight-${++n}`;
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: slug } });
    return slug;
  }

  const isComplete = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  /** A chat with one completed turn of real history behind it. */
  async function chatWithHistory(slug: string): Promise<string> {
    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: slug, sessionId: null, message: "the codeword is pomegranate" },
    });
    return (await ws.waitFor(isComplete(slug), { from: mark })).payload?.sessionId as string;
  }

  /**
   * Start a turn on an existing chat and return once it is genuinely LIVE —
   * `chat:active { running: true }` with its cancellable job id armed. Does NOT
   * wait for completion: the caller acts inside the window.
   */
  async function startInFlightTurn(slug: string, sessionId: string, message: string): Promise<void> {
    const mark = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId, message } });
    await ws.waitFor(
      (e: WsEvent) =>
        e.type === "chat:active" &&
        e.payload?.sessionId === sessionId &&
        e.payload?.running === true &&
        typeof e.payload?.jobId === "string",
      { from: mark },
    );
  }

  const transcriptPath = (slug: string, sessionId: string): string =>
    path.join(t.projectsRoot, slug, ".chats", `${sessionId}.jsonl`);

  const readTranscript = async (slug: string, sessionId: string): Promise<string | null> =>
    fs.readFile(transcriptPath(slug, sessionId), "utf8").catch(() => null);

  async function listChatIds(slug: string): Promise<string[]> {
    const res = await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` });
    return (res.json().chats as Array<{ sessionId: string }>).map((c) => c.sessionId);
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /**
   * Every `tool_use` id in a transcript that never receives a `tool_result`.
   * A non-empty result is a transcript the Messages API refuses to resume.
   */
  function unpairedToolUses(raw: string): string[] {
    const open = new Set<string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: { message?: { content?: unknown } };
      try {
        rec = JSON.parse(trimmed) as { message?: { content?: unknown } };
      } catch {
        continue;
      }
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; id?: string; tool_use_id?: string };
        if (b?.type === "tool_use" && b.id) open.add(b.id);
        else if (b?.type === "tool_result" && b.tool_use_id) open.delete(b.tool_use_id);
      }
    }
    return [...open];
  }

  /** Every `tool_result` whose `tool_use` is absent — the shape a mid-turn revert left behind. */
  function orphanToolResults(raw: string): string[] {
    const seen = new Set<string>();
    const orphans: string[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: { message?: { content?: unknown } };
      try {
        rec = JSON.parse(trimmed) as { message?: { content?: unknown } };
      } catch {
        continue;
      }
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; id?: string; tool_use_id?: string };
        if (b?.type === "tool_use" && b.id) seen.add(b.id);
        else if (b?.type === "tool_result" && b.tool_use_id && !seen.has(b.tool_use_id)) {
          orphans.push(b.tool_use_id);
        }
      }
    }
    return orphans;
  }

  // --- variant A: delete --------------------------------------------------

  it("delete mid-turn removes the chat for good — the turn cannot resurrect it", async () => {
    const slug = await freshProject();
    const sid = await chatWithHistory(slug);
    expect(await readTranscript(slug, sid)).toContain("pomegranate");

    const mark = ws.mark();
    await startInFlightTurn(slug, sid, "take your time [[SLOWTOOL]]");

    const res = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${slug}/chats/${sid}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(await readTranscript(slug, sid)).toBeNull();

    // The whole point: wait out the window in which the surviving turn used to
    // write itself back to disk.
    await sleep(SETTLE_MS);

    expect(await readTranscript(slug, sid)).toBeNull();
    // It was the project's only chat, so anything at all here is a resurrection
    // — under the deleted id, or under the fresh one main's respawn invents.
    expect(await listChatIds(slug)).toEqual([]);
    // And no turn ran to completion against a chat that no longer exists.
    expect(
      ws.events
        .slice(mark)
        .filter((e) => e.type === "chat:complete" && e.payload?.success === true),
    ).toEqual([]);
    expect(res.json().cancelledTurn).toBe(true);
  });

  it("batch delete mid-turn removes the chat for good", async () => {
    const slug = await freshProject();
    const sid = await chatWithHistory(slug);
    const mark = ws.mark();
    await startInFlightTurn(slug, sid, "take your time [[SLOWTOOL]]");

    const res = await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/batch/delete`,
      payload: { sessionIds: [sid] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toEqual([sid]);
    expect(res.json().failed).toEqual([]);

    await sleep(SETTLE_MS);

    expect(await readTranscript(slug, sid)).toBeNull();
    expect(await listChatIds(slug)).toEqual([]);
    expect(
      ws.events
        .slice(mark)
        .filter((e) => e.type === "chat:complete" && e.payload?.success === true),
    ).toEqual([]);
  });

  // --- variant C: a HUNG turn is stopped, not merely orphaned ---------------

  it("delete of a HUNG turn reaps the process and leaves no permanently-running row", async () => {
    const slug = await freshProject();
    const sid = await chatWithHistory(slug);

    // [[HANG]] never completes on its own, so a terminal chat:complete is proof
    // the subprocess was actually interrupted — not left orphaned as it was
    // before #731, where the child was still alive 20s later and never reaped.
    const mark = ws.mark();
    await startInFlightTurn(slug, sid, "hold the line [[HANG]]");

    const res = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${slug}/chats/${sid}`,
    });
    expect(res.statusCode).toBe(200);

    const complete = await ws.waitFor(
      (e: WsEvent) => e.type === "chat:complete" && e.payload?.sessionId === sid,
      { from: mark, timeoutMs: 15_000 },
    );
    expect(complete.payload?.success).toBe(false);
    expect(res.json().cancelledTurn).toBe(true);

    // …and the run row does not sit at `running` forever for a chat that is gone.
    const runs = await t.app.inject({ method: "GET", url: `/api/projects/${slug}/runs` });
    const stillRunning = (runs.json().runs as Array<{ sessionId?: string; status: string }>).filter(
      (r) => r.status === "running" && r.sessionId === sid,
    );
    expect(stillRunning).toEqual([]);
  });

  // --- variant B: promote --------------------------------------------------

  it("promote mid-turn lands the chat in the TARGET only, with its history intact", async () => {
    const slug = await freshProject();
    const sid = await chatWithHistory(slug);
    await startInFlightTurn(slug, sid, "take your time [[SLOWTOOL]]");

    const res = await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${sid}/promote`,
      payload: { name: `Target ${n}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().promoted).toBe(true);
    const targetSlug = res.json().project.slug as string;

    await sleep(SETTLE_MS);

    // The source must not resurrect the chat it no longer owns.
    expect(await readTranscript(slug, sid)).toBeNull();
    expect(await listChatIds(slug)).toEqual([]);

    // …and the target must actually LIST it (the promoted transcript was on disk
    // all along; the bug was that nothing there could see it).
    expect(await listChatIds(targetSlug)).toContain(sid);
    expect(await readTranscript(targetSlug, sid)).toContain("pomegranate");
  });

  // --- revert --------------------------------------------------------------

  it("revert mid-turn truncates without leaving an orphan tool_result", async () => {
    const slug = await freshProject();
    const sid = await chatWithHistory(slug);

    // Revert back to the first record of the history turn.
    const before = (await readTranscript(slug, sid))!;
    const firstUuid = before
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { uuid?: string }).uuid)
      .find((u): u is string => typeof u === "string")!;

    await startInFlightTurn(slug, sid, "take your time [[SLOWTOOL]]");

    const res = await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${sid}/revert`,
      payload: { uuid: firstUuid },
    });
    expect(res.statusCode).toBe(200);
    const truncated = (await readTranscript(slug, sid))!;

    await sleep(SETTLE_MS);

    // Nothing appended after the truncation — the in-flight turn is gone, so the
    // `tool_result` whose `tool_use` was just truncated away is never written.
    const after = (await readTranscript(slug, sid))!;
    expect(orphanToolResults(after)).toEqual([]);
    expect(unpairedToolUses(after)).toEqual([]);
    expect(after).toBe(truncated);
    expect(res.json().cancelledTurn).toBe(true);
  });

  // --- fork ----------------------------------------------------------------

  it("fork mid-turn copies a tool-paired transcript and leaves the source running", async () => {
    const slug = await freshProject();
    const sid = await chatWithHistory(slug);
    await startInFlightTurn(slug, sid, "take your time [[SLOWTOOL]]");

    // Wait until the unanswered `tool_use` is actually on disk — that is the
    // shape the fork used to copy verbatim.
    for (let i = 0; i < 100; i++) {
      const raw = await readTranscript(slug, sid);
      if (raw && unpairedToolUses(raw).length > 0) break;
      await sleep(50);
    }
    expect(unpairedToolUses((await readTranscript(slug, sid))!).length).toBeGreaterThan(0);

    // Fork is NOT interlocked: the `fork_chat` fan-out (#214) is invoked BY a
    // keeper from inside its own running turn, so refusing here would break that
    // contract. The copy is sanitised instead.
    const res = await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${sid}/fork`,
      payload: { name: "Fork mid-turn" },
    });
    expect(res.statusCode).toBe(201);
    const childId = res.json().sessionId as string;

    const child = (await readTranscript(slug, childId))!;
    expect(child).toContain("pomegranate"); // the inherited history survived
    expect(unpairedToolUses(child)).toEqual([]);
    expect(orphanToolResults(child)).toEqual([]);

    // The source is untouched: its turn was never cancelled and still completes.
    await ws.waitFor((e: WsEvent) => e.type === "chat:complete" && e.payload?.sessionId === sid, {
      timeoutMs: 15_000,
    });
    expect(await listChatIds(slug)).toContain(sid);
  });

  // --- project delete ------------------------------------------------------

  it("project delete mid-turn stops the turn instead of orphaning it", async () => {
    const slug = await freshProject();
    const sid = await chatWithHistory(slug);
    const mark = ws.mark();
    await startInFlightTurn(slug, sid, "hold the line [[HANG]]");

    const res = await t.app.inject({ method: "DELETE", url: `/api/projects/${slug}` });
    expect(res.statusCode).toBe(200);

    // The hung turn was interrupted rather than left running against a project
    // directory that no longer exists.
    const complete = await ws.waitFor(
      (e: WsEvent) => e.type === "chat:complete" && e.payload?.sessionId === sid,
      { from: mark, timeoutMs: 15_000 },
    );
    expect(complete.payload?.success).toBe(false);

    const listed = await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` });
    expect(listed.statusCode).toBe(404);
  });
});
