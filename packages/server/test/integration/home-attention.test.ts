/**
 * The Home tab's server surface (#599), over the REAL app + fake CLI runtime:
 *
 *   - `GET <workspace>/chats/attention` — `{ running, unread }` for the
 *     workspace's SUBTREE, mounted at BOTH `/api/root` and
 *     `/api/projects/:slug`.
 *   - `overview` on the workspace detail route, riding alongside `changelog`.
 *
 * The unit suite (`test/unit/chats-attention.test.ts`) pins the classification
 * rules against a stubbed hub, which is the only way to hold a chat "running".
 * This file is the other half: that the route is actually REGISTERED inside the
 * workspace group (so it exists at both mounts), and that the unread half is
 * derived from the same real read-state the sidebar badge uses — driven with
 * real turns, real job records and the real `/seen` + `/unread` + `/archive`
 * endpoints rather than hand-seeded sidecars.
 *
 * Each chat gets its own project where it matters, and the sweep is pushed out
 * of the way (see unread-timestamp.test.ts) so curation can't race a turn.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === slug &&
  typeof e.payload?.sessionId === "string";

interface AttentionRow {
  sessionId: string;
  projectSlug: string;
  projectName: string;
  archived: boolean;
}
interface Attention {
  running: AttentionRow[];
  unread: AttentionRow[];
}

describe("integration: the Home attention feed + overview (#599)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  /** Session ids of the three chats seeded in beforeAll. */
  let alphaChat: string;
  let betaChat: string;
  let rootChat: string;

  const attention = async (url: string): Promise<Attention> => {
    const res = await t.app.inject({ method: "GET", url });
    expect(res.statusCode, url).toBe(200);
    return res.json() as Attention;
  };
  const ids = (rows: AttentionRow[]) => rows.map((r) => r.sessionId);

  /** Run one real turn and return its session id. */
  async function oneTurn(slug: string, message: string): Promise<string> {
    const mark = ws.mark();
    ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message } });
    return (await ws.waitFor(isComplete(slug), { from: mark })).payload?.sessionId as string;
  }

  beforeAll(async () => {
    t = await startTestApp({
      script: { "hello attention": "hi from the keeper" },
      sweepIntervalMs: 600_000,
    });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Attn Alpha" } });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Attn Beta" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);

    alphaChat = await oneTurn("attn-alpha", "hello attention");
    betaChat = await oneTurn("attn-beta", "hello attention");
    // The root's key is `""` and rides the wire as itself.
    rootChat = await oneTurn("", "hello attention");
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("exists at BOTH mounts and answers the same shape", async () => {
    const root = await attention("/api/root/chats/attention");
    const project = await attention("/api/projects/attn-alpha/chats/attention");
    expect(Object.keys(root).sort()).toEqual(["running", "unread"]);
    expect(Object.keys(project).sort()).toEqual(["running", "unread"]);
  });

  it("is FLEET-WIDE on the root mount — every project's chats AND the root's own", async () => {
    const { unread } = await attention("/api/root/chats/attention");
    expect(ids(unread)).toContain(alphaChat);
    expect(ids(unread)).toContain(betaChat);
    // The root's key is `""`; a falsy guard anywhere on this path drops its own
    // chats from its own feed. Asserted explicitly, by value.
    expect(ids(unread)).toContain(rootChat);
    expect(unread.find((r) => r.sessionId === rootChat)!.projectSlug).toBe("");

    // Attribution survives the fleet-wide merge.
    expect(unread.find((r) => r.sessionId === alphaChat)!.projectSlug).toBe("attn-alpha");
    expect(unread.find((r) => r.sessionId === alphaChat)!.projectName).toBe("Attn Alpha");
    expect(unread.find((r) => r.sessionId === betaChat)!.projectName).toBe("Attn Beta");
  });

  it("is scoped to ITSELF on a project mount", async () => {
    const { unread } = await attention("/api/projects/attn-alpha/chats/attention");
    expect(ids(unread)).toContain(alphaChat);
    expect(ids(unread)).not.toContain(betaChat);
    expect(ids(unread)).not.toContain(rootChat);
    for (const row of unread) expect(row.projectSlug).toBe("attn-alpha");
  });

  it("drops a chat once it is marked seen, and brings it back on a manual unread (#458)", async () => {
    const inFeed = async () =>
      ids((await attention("/api/projects/attn-alpha/chats/attention")).unread).includes(alphaChat);

    expect(await inFeed()).toBe(true);

    // Marking seen advances the watermark past the last completed turn.
    const seen = await t.app.inject({
      method: "POST",
      url: `/api/projects/attn-alpha/chats/${alphaChat}/seen`,
    });
    expect(seen.statusCode).toBe(200);
    expect(await inFeed()).toBe(false);
    // …and it leaves the fleet-wide root feed too — one derivation, both mounts.
    expect(ids((await attention("/api/root/chats/attention")).unread)).not.toContain(alphaChat);

    // The manual override resurfaces it even though it has been seen.
    const flag = await t.app.inject({
      method: "POST",
      url: `/api/projects/attn-alpha/chats/${alphaChat}/unread`,
      payload: { unread: true },
    });
    expect(flag.statusCode).toBe(200);
    expect(await inFeed()).toBe(true);
    expect(ids((await attention("/api/root/chats/attention")).unread)).toContain(alphaChat);
  });

  it("excludes an ARCHIVED chat from the unread feed", async () => {
    // `betaChat` is unread (a completed turn, never seen).
    expect(ids((await attention("/api/projects/attn-beta/chats/attention")).unread)).toContain(
      betaChat,
    );

    const archived = await t.app.inject({
      method: "POST",
      url: `/api/projects/attn-beta/chats/${betaChat}/archive`,
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);

    expect(ids((await attention("/api/projects/attn-beta/chats/attention")).unread)).not.toContain(
      betaChat,
    );
    expect(ids((await attention("/api/root/chats/attention")).unread)).not.toContain(betaChat);

    // Unarchiving puts it back — the flag is the only input.
    await t.app.inject({
      method: "POST",
      url: `/api/projects/attn-beta/chats/${betaChat}/archive`,
      payload: { archived: false },
    });
    expect(ids((await attention("/api/projects/attn-beta/chats/attention")).unread)).toContain(
      betaChat,
    );
  });

  it("404s an unknown project slug", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/projects/ghost/chats/attention" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "not_found" });
  });

});

/**
 * `overview` on the workspace detail route (`GET <workspace>/`), which now
 * returns OVERVIEW.md alongside CHANGELOG.md so Home can render both from one
 * request.
 *
 * Deliberately its OWN app with NO chats in it: the post-turn sweep curates
 * OVERVIEW.md, so any workspace that has run a turn has a file racing these
 * assertions. A chat-free instance never sweeps, which makes "absent reads as
 * empty" a fact rather than a timing window.
 */
describe("integration: `overview` on the workspace detail route (#599)", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Ov Proj" } });
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("returns `overview` alongside `changelog` — '' when there is no OVERVIEW.md", async () => {
    // Project creation seeds a CHANGELOG.md but deliberately NOT an OVERVIEW.md
    // (the first sweep writes that), so a fresh project IS the absent case.
    const body = (await t.app.inject({ method: "GET", url: "/api/projects/ov-proj" })).json();
    expect(body).toHaveProperty("overview");
    // Absent reads as empty — the same contract `changelog` has always had.
    expect(body.overview).toBe("");
    expect(body.changelog).toContain("Project opened.");
  });

  it("returns the OVERVIEW.md text once one exists, on the SAME payload as the changelog", async () => {
    await t.projects.writeOverview("ov-proj", "# Current State\nEverything is fine.\n");
    const body = (await t.app.inject({ method: "GET", url: "/api/projects/ov-proj" })).json();
    expect(body.overview).toContain("# Current State");
    expect(body.overview).toContain("Everything is fine.");
    // One request, so Home can't render the two cards a beat apart.
    expect(body.changelog).toContain("Project opened.");
  });

  it("returns `overview` on the ROOT mount too — the root's key is ''", async () => {
    const before = (await t.app.inject({ method: "GET", url: "/api/root" })).json();
    expect(before).toHaveProperty("overview");
    expect(before.overview).toBe("");

    await t.projects.writeOverview("", "# Root overview\nThe whole instance.\n");
    const after = (await t.app.inject({ method: "GET", url: "/api/root" })).json();
    expect(after.overview).toContain("# Root overview");

    // Same handler at both mounts ⇒ same payload shape.
    const project = (await t.app.inject({ method: "GET", url: "/api/projects/ov-proj" })).json();
    expect(Object.keys(after).sort()).toEqual(Object.keys(project).sort());
    expect(Object.keys(after)).toContain("overview");
  });
});
