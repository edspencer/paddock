import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

/**
 * End-to-end coverage for the chat tree's subtree (batch) actions and
 * detach-from-parent (#508), through the REAL app + fake CLI runtime.
 *
 * The batch routes exist because shift-clicking a parent applies an action to it
 * AND every descendant, and looping the single-chat routes client-side over a
 * 21-chat family can half-succeed — leaving a torn family with nothing to roll
 * back. So the properties under test are: the whole set moves together, a repeat
 * is a no-op, a malformed set changes NOTHING, and a delete is honest about which
 * ids it actually removed.
 *
 * ONE project holding one pool of chats, built once. Unlike archive.test.ts
 * (project-per-test, one chat each) these routes need SEVERAL chats visible in
 * the same list, and @herdctl/core's attribution index — which decides whether a
 * session belongs to this keeper — is a process-wide 30s cache with no public
 * invalidation. A project created after that index was built stays partially
 * invisible until it expires, so the pool is paid for once here rather than per
 * test. Tests below therefore use DISJOINT slices of `ids` and clean up after
 * themselves; the destructive ones run last and take the tail of the pool.
 */
describe("integration: batch subtree chat actions + detach (#508)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  /** How many listable chats the tests below need. */
  const POOL = 6;
  /** The shared project + its chats, in list order. */
  const slug = "batch-subtree";
  let keeper: string;
  let ids: string[] = [];

  const isComplete = (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  type Dto = {
    sessionId: string;
    archived?: boolean;
    unread?: boolean;
    lastSeen?: number;
    parent?: { project: string; sessionId: string };
  };

  async function chatDtos(): Promise<Dto[]> {
    const res = await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` });
    return res.json().chats as Dto[];
  }

  const dtoFor = async (id: string) => (await chatDtos()).find((c) => c.sessionId === id);

  const batch = (op: string, payload: unknown) =>
    t.app.inject({ method: "POST", url: `/api/projects/${slug}/chats/batch/${op}`, payload });

  const detach = (id: string, payload: unknown) =>
    t.app.inject({ method: "POST", url: `/api/projects/${slug}/chats/${id}/detach`, payload });

  beforeAll(async () => {
    t = await startTestApp({ script: { "hello batch": "hi from the keeper" } });
    keeper = `keeper-${slug}`;
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: slug } });
    for (let i = 0; i < 8; i++) {
      const mark = ws.mark();
      ws.send({
        type: "chat:send",
        payload: { projectSlug: slug, sessionId: null, message: "hello batch" },
      });
      await ws.waitFor(isComplete, { from: mark });
    }
    // Take the pool from what the LIST actually shows, not from the ids the sends
    // returned. Two known harness effects make those diverge: @herdctl/core's 30s
    // attribution cache, and the post-turn sweep transiently stamping a chat's job
    // `sweeper-<slug>`, which hides it from `getAgentSessions("keeper-<slug>")`
    // (#154). Neither is what this file is testing, and asserting through a chat
    // the list can't see would only ever produce a confusing failure. So: send
    // more than needed, wait for enough to surface, and work with those.
    const deadline = Date.now() + 60_000;
    while ((await chatDtos()).length < POOL && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    ids = (await chatDtos()).map((c) => c.sessionId).slice(0, POOL);
    expect(ids).toHaveLength(POOL);
  }, 120_000);

  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  // --- batch archive ------------------------------------------------------

  it("archives a whole family in one call, and reports only the real transitions", async () => {
    const family = ids.slice(0, 3);

    const res = await batch("archive", { sessionIds: family, archived: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().archived).toBe(true);
    expect((res.json().changed as string[]).sort()).toEqual([...family].sort());
    const archived = (await chatDtos()).filter((c) => c.archived).map((c) => c.sessionId);
    expect(archived.sort()).toEqual([...family].sort());

    // Re-archiving is a no-op: nothing "changed", so no duplicate onArchive fires.
    const again = await batch("archive", { sessionIds: family, archived: true });
    expect(again.json().changed).toEqual([]);

    // …and the whole family comes back together.
    await batch("archive", { sessionIds: family, archived: false });
    expect((await chatDtos()).filter((c) => c.archived)).toEqual([]);
  });

  it("archives only the ids it was given, leaving the rest of the list alone", async () => {
    await batch("archive", { sessionIds: [ids[0]], archived: true });
    const dtos = await chatDtos();
    expect(dtos.find((c) => c.sessionId === ids[0])?.archived).toBe(true);
    expect(dtos.find((c) => c.sessionId === ids[1])?.archived).toBe(false);
    expect(dtos.find((c) => c.sessionId === ids[2])?.archived).toBe(false);
    await batch("archive", { sessionIds: [ids[0]], archived: false });
  });

  it("defaults to archived:true when the body omits the flag", async () => {
    expect((await batch("archive", { sessionIds: [ids[0]] })).json().archived).toBe(true);
    expect((await dtoFor(ids[0]))?.archived).toBe(true);
    await batch("archive", { sessionIds: [ids[0]], archived: false });
  });

  // --- batch read / unread ------------------------------------------------

  it("marks a family unread, then read — clearing the flag AND advancing last-seen", async () => {
    const family = ids.slice(0, 3);

    const on = await batch("unread", { sessionIds: family, unread: true });
    expect(on.statusCode).toBe(200);
    expect((on.json().changed as string[]).sort()).toEqual([...family].sort());
    const flagged = (await chatDtos()).filter((c) => c.unread).map((c) => c.sessionId);
    expect(flagged.sort()).toEqual([...family].sort());

    const off = await batch("unread", { sessionIds: family, unread: false });
    expect(off.statusCode).toBe(200);
    for (const id of family) {
      const dto = await dtoFor(id);
      // Both halves of "mark read": the manual override is gone, and the
      // watermark moved — otherwise the DERIVED unread signal (#160) would
      // immediately re-raise the cue for a chat whose last turn is newer.
      expect(dto?.unread).toBeUndefined();
      expect(dto?.lastSeen).toBeGreaterThan(0);
    }
  });

  // --- validation ---------------------------------------------------------

  it("rejects an unusable id set with a 400 and changes nothing", async () => {
    for (const payload of [
      {},
      { sessionIds: [] },
      // An object can't be coerced into an array, so this one is caught by the
      // route schema. (A bare STRING deliberately isn't in this list: Fastify's
      // ajv runs with `coerceTypes: "array"`, so `"abc"` arrives as `["abc"]` —
      // a well-formed one-id batch naming a chat that doesn't exist, which is a
      // no-op rather than an error. `normalizeBatchSessionIds` is the guard that
      // actually matters here, and it runs AFTER that coercion.)
      { sessionIds: { nope: true } },
      // One traversal-shaped id poisons the whole batch — all-or-nothing, so the
      // valid sibling in the same request must NOT be archived.
      { sessionIds: [ids[0], "../../etc/passwd"] },
    ]) {
      const res = await batch("archive", payload);
      expect(res.statusCode, `payload ${JSON.stringify(payload)}`).toBe(400);
    }
    expect((await chatDtos()).filter((c) => c.archived)).toEqual([]);
  });

  it("404s a batch call against an unknown project", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/no-such-project/chats/batch/archive",
      payload: { sessionIds: ["a"] },
    });
    expect(res.statusCode).toBe(404);
  });

  // --- detach from parent -------------------------------------------------

  it("detaches a nested chat to the top level and re-attaches it", async () => {
    const [parent, child] = ids;
    // Record the edge through the REAL provenance store, the way create_chat does
    // (#510) — so this exercises route → sidecar → parent resolver, not a stub.
    await t.runProvenance.stamp(child, {
      origin: "spawned",
      depth: 1,
      parentSessionId: parent,
      parentProject: slug,
    });
    expect((await dtoFor(child))?.parent).toEqual({ project: slug, sessionId: parent });

    const off = await detach(child, {});
    expect(off.statusCode).toBe(200);
    expect(off.json().detached).toBe(true);
    // The edge is still RECORDED — detach is an override, not an erase…
    expect((await t.runProvenance.get(child))?.parentSessionId).toBe(parent);
    // …but the chat now resolves as a root, so the list renders it top-level.
    expect((await dtoFor(child))?.parent).toBeUndefined();
    expect(await t.parentDetach.isDetached(keeper, child)).toBe(true);

    const on = await detach(child, { detached: false });
    expect(on.json().detached).toBe(false);
    expect((await dtoFor(child))?.parent).toEqual({ project: slug, sessionId: parent });
  });

  // --- batch delete (destructive — takes the tail of the pool) -------------

  it("reports an id it could not delete instead of failing the whole call", async () => {
    const doomed = ids[5];
    // A syntactically valid id that names no transcript: the real chat must still
    // be deleted, and the response must name the one that wasn't.
    const res = await batch("delete", { sessionIds: [doomed, "no-such-session"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toEqual([doomed]);
    expect(res.json().failed).toEqual(["no-such-session"]);
    expect(await dtoFor(doomed)).toBeUndefined();
  });

  it("leaves the flags of a chat it FAILED to delete completely alone", async () => {
    // Review catch: the cleanup used to run over the whole REQUESTED set, so a
    // chat the response reported as SURVIVING was silently unarchived, unstarred,
    // marked read and re-attached by the delete that spared it.
    //
    // Driven with an id that has no transcript, which is precisely the shape of a
    // failed delete — flags key on (agent, sessionId) and don't require the chat
    // to exist, so the sidecars can be set up exactly as a real chat's would be
    // without putting a pool chat at risk.
    const ghost = "ghost-session-508";
    await batch("archive", { sessionIds: [ghost], archived: true });
    await batch("unread", { sessionIds: [ghost], unread: true });
    await detach(ghost, {});
    await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${ghost}/star`,
      payload: { starred: true },
    });

    const res = await batch("delete", { sessionIds: [ghost] });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toEqual([]);
    expect(res.json().failed).toEqual([ghost]);

    // Told it survived — so it must be untouched, in every sidecar.
    expect(await t.archive.isArchived(keeper, ghost)).toBe(true);
    expect(await t.star.isStarred(keeper, ghost)).toBe(true);
    expect(await t.unread.isUnread(null, keeper, ghost)).toBe(true);
    expect(await t.parentDetach.isDetached(keeper, ghost)).toBe(true);
  });

  it("deletes a whole family and clears its flags", async () => {
    const family = ids.slice(3, 5);
    await batch("archive", { sessionIds: family, archived: true });
    await detach(family[1], {});

    const res = await batch("delete", { sessionIds: family });
    expect(res.statusCode).toBe(200);
    expect((res.json().removed as string[]).sort()).toEqual([...family].sort());
    expect(res.json().failed).toEqual([]);
    const remaining = (await chatDtos()).map((c) => c.sessionId);
    for (const id of family) expect(remaining).not.toContain(id);
    // No orphan flags linger for a reused session id.
    expect(await t.archive.isArchived(keeper, family[0])).toBe(false);
    expect(await t.parentDetach.isDetached(keeper, family[1])).toBe(false);
  });
});
