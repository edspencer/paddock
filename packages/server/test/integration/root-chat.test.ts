import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

/**
 * The workspace model (#531) — root CHATS.
 *
 * The point of the design is that this file should read exactly like
 * `chat.test.ts` with the root's key (`""`) in place of a slug — no creation
 * step, no sentinel on the wire. A root chat goes down the ORDINARY keeper path,
 * so it streams, persists a transcript under `<projectsRoot>/.chats/`, lists,
 * hydrates, resumes and archives like any other chat, through the `/api/root`
 * mount of the very same handlers `/api/projects/:slug` uses.
 */
describe("integration: root chats (#531)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;

  const isComplete = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  beforeAll(async () => {
    t = await startTestApp({
      script: {
        "Hello root": "I am the root keeper.",
      },
    });
    // No root creation step — the root workspace always exists. A sibling
    // project exists purely to prove root chats aren't attributed to one.
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Alpha" } });
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("streams a root chat and stores its transcript at <projectsRoot>/.chats", async () => {
    const mark = ws.mark();
    // `""` is the root workspace's key, and it rides the wire as itself — the
    // socket must treat it as an address, not as "no project" (a falsy check
    // here drops every root chat).
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "", sessionId: null, message: "Hello root" },
    });

    const complete = await ws.waitFor(isComplete(""), { from: mark });
    expect(complete.payload?.success).toBe(true);
    const sessionId = complete.payload?.sessionId as string;
    expect(sessionId).toBeTruthy();
    expect(ws.responseText(mark)).toContain("I am the root keeper.");

    // The transcript lands in the ROOT's own `.chats/` — same layout as any
    // project's, one level up.
    const entries = await fs.readdir(path.join(t.projectsRoot, ".chats"));
    expect(entries.some((f) => f.startsWith(sessionId))).toBe(true);

    // …and it lists + hydrates through the ordinary chat routes, at the root mount.
    const chats = (await t.app.inject({ method: "GET", url: "/api/root/chats" })).json().chats;
    expect(chats.map((c: { sessionId: string }) => c.sessionId)).toContain(sessionId);

    const messages = (
      await t.app.inject({
        method: "GET",
        url: `/api/root/chats/${sessionId}/messages`,
      })
    ).json().messages;
    expect(messages.map((m: { role: string }) => m.role)).toContain("assistant");
  });

  it("is NOT attributed to any project — the root is a peer, not a member", async () => {
    const rootChats = (await t.app.inject({ method: "GET", url: "/api/root/chats" })).json().chats;
    const rootIds = rootChats.map((c: { sessionId: string }) => c.sessionId);
    expect(rootIds.length).toBeGreaterThan(0);

    // No project's chat list claims it…
    const list = (await t.app.inject({ method: "GET", url: "/api/projects" })).json();
    const slugs = (list.projects as Array<{ slug: string }>).map((p) => p.slug);
    expect(slugs).toEqual(["alpha"]); // the root is not enumerated
    for (const slug of slugs) {
      const theirs = (
        await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` })
      ).json().chats;
      for (const id of rootIds) {
        expect(theirs.map((c: { sessionId: string }) => c.sessionId), slug).not.toContain(id);
      }
    }
    // …and the root chat's transcript lives at the projects root, not under one.
    // (Every project has a `.chats/` dir from keeper registration; what matters
    // is that no root transcript landed in it.)
    const alphaChats = await fs
      .readdir(path.join(t.projectsRoot, "alpha", ".chats"))
      .catch(() => [] as string[]);
    for (const id of rootIds) {
      expect(alphaChats.some((f: string) => f.startsWith(id))).toBe(false);
    }
    const rootTranscripts = await fs.readdir(path.join(t.projectsRoot, ".chats"));
    for (const id of rootIds) {
      expect(rootTranscripts.some((f) => f.startsWith(id)), id).toBe(true);
    }
  });

  it("resumes the SAME root session — continuity, not a fresh chat each turn", async () => {
    const m1 = ws.mark();
    ws.send({
      type: "chat:send",
      payload: {
        projectSlug: "",
        sessionId: null,
        message: "the codeword is pomegranate",
      },
    });
    const c1 = await ws.waitFor(isComplete(""), { from: m1 });
    const sessionId = c1.payload?.sessionId as string;

    const m2 = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "", sessionId, message: "what was the codeword?" },
    });
    const c2 = await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.sessionId === sessionId,
      { from: m2 },
    );
    expect(c2.payload?.success).toBe(true);
    expect(ws.responseText(m2).toLowerCase()).toContain("pomegranate");
  });

  it("carries the ordinary chat sidecars — rename, star, archive", async () => {
    const sessionId = (await t.app.inject({ method: "GET", url: "/api/root/chats" })).json()
      .chats[0].sessionId;
    const base = `/api/root/chats/${sessionId}`;

    expect(
      (await t.app.inject({ method: "PATCH", url: base, payload: { name: "Renamed" } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `${base}/star`,
          payload: { starred: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `${base}/archive`,
          payload: { archived: true },
        })
      ).statusCode,
    ).toBe(200);

    const chat = (await t.app.inject({ method: "GET", url: "/api/root/chats" }))
      .json()
      .chats.find((c: { sessionId: string }) => c.sessionId === sessionId);
    expect(chat.name).toBe("Renamed");
    expect(chat.starred).toBe(true);
    expect(chat.archived).toBe(true);
  });

  // Scoped usage (#537) has to work through the root mount too, and it is exactly
  // the shape the empty-string root key breaks: the scope filter reads the archive
  // sidecar under `keeperAgentName(slug)`, so anything that treats the root's `""`
  // as absent rather than as a key would look under the wrong keeper and quietly
  // return the wrong set — with no error to notice. By now the tests above have
  // left the root with one archived chat and one active one, which is the split
  // this needs.
  it("scopes root usage by archived state, not by whether the slug is truthy (#537)", async () => {
    const usage = async (scope?: string) =>
      (
        await t.app.inject({
          method: "GET",
          url: `/api/root/chats/usage${scope ? `?scope=${scope}` : ""}`,
        })
      ).json().usage as Record<string, { contextTokens: number }>;

    const chats = (await t.app.inject({ method: "GET", url: "/api/root/chats" })).json()
      .chats as Array<{ sessionId: string; archived: boolean }>;
    const ids = (archived: boolean) =>
      chats
        .filter((c) => c.archived === archived)
        .map((c) => c.sessionId)
        .sort();
    // Both populations are non-empty, or the split proves nothing.
    expect(ids(true).length).toBeGreaterThan(0);
    expect(ids(false).length).toBeGreaterThan(0);

    expect(Object.keys(await usage()).sort()).toEqual(ids(false));
    expect(Object.keys(await usage("archived")).sort()).toEqual(ids(true));
    expect(Object.keys(await usage("all")).sort()).toEqual(
      [...ids(false), ...ids(true)].sort(),
    );
    // Scoping picks which transcripts get streamed; it never changes the figures.
    const all = await usage("all");
    expect({ ...(await usage()), ...(await usage("archived")) }).toEqual(all);
  });
});
