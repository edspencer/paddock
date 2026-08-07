/**
 * State hygiene for things the user DELETED (#732, #734).
 *
 * Both bugs are the same shape one layer apart: herdctl's `job-*.yaml` records
 * are the data source behind the sidebar unread badge (`chatTurns`) and the run
 * history (`/runs`), and nothing removed them when the thing they describe went
 * away. A deleted chat kept feeding the badge (#732) — with no chat left to open
 * to clear it — and a deleted PROJECT left its whole keeper's records behind, so
 * re-creating a project with the same name inherited the previous incarnation's
 * prompts and replies (#734).
 *
 * The third case here is not a leak but a divergence the same issue asks to
 * settle: an ARCHIVED unread chat used to count toward the sidebar badge while
 * being excluded from `/chats/attention`, so the two surfaces disagreed by
 * exactly the archived set. Archiving now silences both.
 *
 * `read-state.test.ts` and `seen-unread-precedence.test.ts` cover the precedence
 * rules thoroughly but always for chats that EXIST; that is the gap this file
 * fills, so everything here is asserted through the real routes.
 *
 * Job records are seeded directly (as `runs.test.ts` does) wherever the test is
 * about bookkeeping rather than about running a turn: it keeps the assertions
 * deterministic and — importantly for #734 — independent of drive mode, since
 * only `batch` turns write these records at all and `session` is the default.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === slug &&
  typeof e.payload?.sessionId === "string";

interface ChatTurn {
  sessionId: string;
  lastTurnCompletedAt: string;
  lastSeen?: number;
  unread?: boolean;
}

/** Seed one completed job record for `agent`/`sessionId`, as a real turn writes. */
async function seedJob(
  jobsDir: string,
  opts: { id: string; agent: string; sessionId: string; when: string; prompt?: string },
): Promise<void> {
  await fs.mkdir(jobsDir, { recursive: true });
  const record = {
    id: opts.id,
    agent: opts.agent,
    trigger_type: "manual",
    status: "completed",
    schedule: null,
    forked_from: null,
    session_id: opts.sessionId,
    started_at: opts.when,
    finished_at: opts.when,
    duration_seconds: 1,
    prompt: opts.prompt ?? null,
  };
  await fs.writeFile(path.join(jobsDir, `${opts.id}.yaml`), YAML.stringify(record), "utf8");
}

function jobsDirOf(t: TestApp): string {
  return path.join(t.tmp, "data", ".herdctl", "jobs");
}

async function chatTurnsFor(t: TestApp, slug: string): Promise<ChatTurn[]> {
  const body = (await t.app.inject({ method: "GET", url: "/api/projects" })).json();
  const p = (body.projects as { slug: string; chatTurns?: ChatTurn[] }[]).find(
    (x) => x.slug === slug,
  );
  return p?.chatTurns ?? [];
}

async function chatsFor(t: TestApp, slug: string): Promise<{ sessionId: string }[]> {
  return (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` })).json().chats;
}

describe("integration: deleted chats stop feeding the unread badge (#732)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  beforeEach(async () => {
    t = await startTestApp({
      script: { one: "reply one", two: "reply two", three: "reply three" },
      sweepIntervalMs: 600_000,
    });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterEach(async () => {
    ws?.close();
    await t.teardown();
  });

  it("prunes chatTurns when a chat is deleted, and drops the chat's run records", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Badge Proj" } });
    const slug = "badge-proj";

    const ids: string[] = [];
    for (const message of ["one", "two", "three"]) {
      const mark = ws.mark();
      ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message } });
      const done = await ws.waitFor(isComplete(slug), { from: mark });
      ids.push(done.payload!.sessionId as string);
    }

    // Baseline: three chats, three badge entries.
    expect((await chatsFor(t, slug)).length).toBe(3);
    expect((await chatTurnsFor(t, slug)).length).toBe(3);

    // Delete two of them.
    for (const sessionId of ids.slice(0, 2)) {
      const res = await t.app.inject({
        method: "DELETE",
        url: `/api/projects/${slug}/chats/${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
    }

    // The badge's feed must not outlive its chats. On `main` this was still 3.
    const chats = await chatsFor(t, slug);
    const turns = await chatTurnsFor(t, slug);
    expect(chats.length).toBe(1);
    expect(turns.length).toBe(chats.length);
    expect(turns.map((x) => x.sessionId)).toEqual([ids[2]]);

    // And the deleted chats' run history goes with them — a deleted chat's
    // prompt text must not survive in `/runs`.
    const runs = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/runs` }))
      .json()
      .runs as { sessionId?: string; session_id?: string }[];
    const runSessions = new Set(runs.map((r) => r.sessionId ?? r.session_id));
    // The survivor's run is still there — without this the two absences below
    // would pass just as well on an empty or misshapen `/runs`.
    expect(runSessions.has(ids[2])).toBe(true);
    expect(runSessions.has(ids[0])).toBe(false);
    expect(runSessions.has(ids[1])).toBe(false);
  });

  it("prunes a batch delete's chats out of chatTurns too", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Batch Proj" } });
    const slug = "batch-proj";

    const ids: string[] = [];
    for (const message of ["one", "two"]) {
      const mark = ws.mark();
      ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message } });
      const done = await ws.waitFor(isComplete(slug), { from: mark });
      ids.push(done.payload!.sessionId as string);
    }
    expect((await chatTurnsFor(t, slug)).length).toBe(2);

    const res = await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/batch/delete`,
      payload: { sessionIds: ids },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toHaveLength(2);

    expect(await chatsFor(t, slug)).toHaveLength(0);
    expect(await chatTurnsFor(t, slug)).toHaveLength(0);
  });

  it("self-heals a badge already stuck on records whose chats are gone", async () => {
    // The delete-time purge above cannot help an instance that is ALREADY stuck,
    // nor a transcript that left by some other route (an unadopt, a hand-deleted
    // JSONL). Seed exactly that state — records with no chat behind them — and
    // require the read to prune them.
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Stuck Proj" } });
    const slug = "stuck-proj";
    await seedJob(jobsDirOf(t), {
      id: "job-2026-07-18-ghost1",
      agent: `keeper-${slug}`,
      sessionId: "11111111-1111-4111-8111-111111111111",
      when: "2026-07-18T12:00:00.000Z",
    });

    expect(await chatsFor(t, slug)).toHaveLength(0);
    expect(await chatTurnsFor(t, slug)).toHaveLength(0);
  });
});

describe("integration: archived chats are silent on BOTH surfaces (#732)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  beforeEach(async () => {
    t = await startTestApp({ script: { one: "reply one" }, sweepIntervalMs: 600_000 });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterEach(async () => {
    ws?.close();
    await t.teardown();
  });

  it("an archived unread chat leaves the sidebar badge as well as the Home feed", async () => {
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Arch Proj" } });
    const slug = "arch-proj";
    const mark = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message: "one" } });
    const sessionId = (await ws.waitFor(isComplete(slug), { from: mark })).payload!
      .sessionId as string;

    // Unread on both surfaces to begin with.
    expect(await chatTurnsFor(t, slug)).toHaveLength(1);
    const before = (
      await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats/attention` })
    ).json();
    expect(before.unread).toHaveLength(1);

    await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${sessionId}/archive`,
      payload: { archived: true },
    });

    // Archiving is "stop bothering me". The feed already honoured that; the
    // badge did not — on `main` chatTurns was still 1 here.
    expect(await chatTurnsFor(t, slug)).toHaveLength(0);
    const after = (
      await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats/attention` })
    ).json();
    expect(after.unread).toHaveLength(0);

    // Unarchiving restores it on both — archiving silences, it does not consume.
    await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/chats/${sessionId}/archive`,
      payload: { archived: false },
    });
    expect(await chatTurnsFor(t, slug)).toHaveLength(1);
    const restored = (
      await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats/attention` })
    ).json();
    expect(restored.unread).toHaveLength(1);
  });
});

describe("integration: a re-created project does not inherit the old one's history (#734)", () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await startTestApp({ sweepIntervalMs: 600_000 });
  });
  afterEach(async () => {
    await t.teardown();
  });

  it("delete + re-create with the same name leaves no runs and no phantom badge", async () => {
    const create = () =>
      t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Foo" } });

    expect((await create()).statusCode).toBe(201);
    const slug = "foo";

    // The previous incarnation's turns, as a `batch` keeper turn would record
    // them — prompt text and all, which is the privacy half of the bug.
    await seedJob(jobsDirOf(t), {
      id: "job-2026-07-18-prev01",
      agent: `keeper-${slug}`,
      sessionId: "22222222-2222-4222-8222-222222222222",
      when: "2026-07-18T12:00:00.000Z",
      prompt: "Set codeword: SECRETSAUCE",
    });
    // A trigger agent of the same project leaves records too; they are just as
    // much the deleted project's history.
    await seedJob(jobsDirOf(t), {
      id: "job-2026-07-18-prev02",
      agent: `sweeper-${slug}`,
      sessionId: "33333333-3333-4333-8333-333333333333",
      when: "2026-07-18T12:01:00.000Z",
      prompt: "curate SECRETSAUCE",
    });
    expect(
      ((await t.app.inject({ method: "GET", url: `/api/projects/${slug}/runs` })).json().runs as [])
        .length,
    ).toBe(1);

    // A SIBLING whose slug merely starts with this one's. Agent names are
    // matched exactly, and this is the assertion that keeps it that way — a
    // prefix match here would silently eat an unrelated project's history.
    expect(
      (await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Foo Bar" } }))
        .statusCode,
    ).toBe(201);
    await seedJob(jobsDirOf(t), {
      id: "job-2026-07-18-sib001",
      agent: "keeper-foo-bar",
      sessionId: "44444444-4444-4444-8444-444444444444",
      when: "2026-07-18T12:02:00.000Z",
      prompt: "the sibling's own work",
    });

    const del = await t.app.inject({ method: "DELETE", url: `/api/projects/${slug}` });
    expect(del.statusCode).toBe(200);

    // The sibling is untouched.
    const sibRuns = (await t.app.inject({ method: "GET", url: "/api/projects/foo-bar/runs" }))
      .json().runs as unknown[];
    expect(sibRuns).toHaveLength(1);

    // Re-create with the SAME name, so the same slug and the same agent names.
    expect((await create()).statusCode).toBe(201);

    const runs = (await t.app.inject({ method: "GET", url: `/api/projects/${slug}/runs` })).json()
      .runs as unknown[];
    expect(runs).toHaveLength(0);
    expect(await chatTurnsFor(t, slug)).toHaveLength(0);

    // Nothing of the old project's prose survives anywhere in the jobs dir.
    const jobsDir = jobsDirOf(t);
    const left = await fs.readdir(jobsDir).catch(() => [] as string[]);
    for (const name of left) {
      const raw = await fs.readFile(path.join(jobsDir, name), "utf8").catch(() => "");
      expect(raw).not.toContain("SECRETSAUCE");
    }
  });
});
