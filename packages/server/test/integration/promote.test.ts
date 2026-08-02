import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

/**
 * Promote a chat into a NEW project (#20). Exercises the real
 * `promoteSession` → `reattributeSession`/`writeAdoptionJob` machinery: after
 * promotion the chat must list + resume UNDER THE NEW PROJECT (and be gone from
 * the old one), with its history intact — the exact saga the design doc calls
 * out.
 *
 * The operation is workspace → workspace, so this test promotes an ordinary
 * project chat. The UI only offers it at the ROOT, but nothing in the server is
 * root-specific, and testing the generic path is what actually covers it.
 */
describe("integration: promote a chat → new project (real fleet, fake claude)", () => {
  let t: TestApp;
  let port: number;
  let ws: WsClient;
  const SOURCE = "source-proj";

  const completeFor = (slug: string) => (e: WsEvent) =>
    e.type === "chat:complete" &&
    e.payload?.projectSlug === slug &&
    typeof e.payload?.sessionId === "string";

  beforeAll(async () => {
    t = await startTestApp();
    ({ port } = await listen(t.app));
    ws = await connectWs(port);
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Source Proj" } });
  });
  afterAll(async () => {
    ws?.close();
    await t.teardown();
  });

  it("promotes the chat: it lists under the new project, history hydrates, re-attributes the job, and resumes with continuity", async () => {
    // 1) Start a chat in the source project that sets a codeword.
    const m1 = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: SOURCE, sessionId: null, message: "the codeword is artichoke" },
    });
    const c1 = await ws.waitFor(completeFor(SOURCE), { from: m1 });
    const sessionId = c1.payload?.sessionId as string;
    expect(sessionId).toBeTruthy();

    // It currently lives in the source project.
    let sourceChats = (
      await t.app.inject({ method: "GET", url: `/api/projects/${SOURCE}/chats` })
    ).json().chats;
    expect(sourceChats.map((c: { sessionId: string }) => c.sessionId)).toContain(sessionId);

    // 2) Promote it into a new project.
    const promote = await t.app.inject({
      method: "POST",
      url: `/api/projects/${SOURCE}/chats/${sessionId}/promote`,
      payload: { name: "Artichoke Project", group: "house" },
    });
    expect(promote.statusCode).toBe(201);
    const body = promote.json();
    expect(body.promoted).toBe(true);
    const slug = body.project.slug as string;
    expect(slug).toBe("artichoke-project");

    // 3) It now lists UNDER the new project…
    const projectChats = (
      await t.app.inject({ method: "GET", url: `/api/projects/${slug}/chats` })
    ).json().chats;
    expect(projectChats.map((c: { sessionId: string }) => c.sessionId)).toContain(sessionId);

    // …and is GONE from the source project.
    sourceChats = (
      await t.app.inject({ method: "GET", url: `/api/projects/${SOURCE}/chats` })
    ).json().chats;
    expect(sourceChats.map((c: { sessionId: string }) => c.sessionId)).not.toContain(sessionId);

    // 4) History hydrates under the new project's keeper.
    const messages = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/${slug}/chats/${sessionId}/messages`,
      })
    ).json().messages;
    expect(messages.some((m: { role: string }) => m.role === "user")).toBe(true);

    // 5) A job record now attributes the session to the NEW keeper
    //    (writeAdoptionJob / reattributeSession), and the transcript's embedded
    //    cwd was rewritten from the source project's dir to the new one.
    const jobsDir = path.join(t.cfg.stateDir, "jobs");
    const jobFiles = await fs.readdir(jobsDir);
    let attributed = false;
    for (const f of jobFiles) {
      if (!f.endsWith(".yaml")) continue;
      const rec = YAML.parse(await fs.readFile(path.join(jobsDir, f), "utf8"));
      if (rec?.session_id === sessionId && rec?.agent === `keeper-${slug}`) attributed = true;
    }
    expect(attributed).toBe(true);

    const transcript = await fs.readFile(
      path.join(body.project.dir, ".chats", `${sessionId}.jsonl`),
      "utf8",
    );
    expect(transcript).toContain(`"cwd":"${body.project.dir}"`);
    expect(transcript).not.toContain(`"cwd":"${path.join(t.cfg.projectsRoot, SOURCE)}"`);

    // 6) Resume the promoted chat under the new project — and CONTINUE it.
    //
    // This was a known gap (herdctl's JobExecutor dropped an explicit `--resume`
    // when the agent had no stored session-info, so a promoted chat forked a
    // fresh session under the keeper). Fixed upstream in @herdctl/core 5.13.1
    // (herdctl#263): the executor now adopts a caller-provided resume when the
    // transcript exists in the agent's working dir. So the resumed turn must now
    // continue the SAME session and recall the codeword.
    const m2 = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: slug, sessionId, message: "what was the codeword?" },
    });
    const c2 = await ws.waitFor(
      (e) => e.type === "chat:complete" && e.payload?.projectSlug === slug,
      { from: m2 },
    );
    expect(c2.payload?.success).toBe(true);
    // Continuity: same session id (not a fork) and the prior turn's codeword is
    // recalled from the moved transcript.
    expect(c2.payload?.sessionId).toBe(sessionId);
    expect(ws.responseText(m2).toLowerCase()).toContain("artichoke");
  });

  it("returns the project but promoted:false for an unknown session id", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/projects/${SOURCE}/chats/does-not-exist/promote`,
      payload: { name: "Orphan Project" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.project.slug).toBe("orphan-project");
    expect(body.promoted).toBe(false);
  });

  it("rejects promotion with no name (400)", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/projects/${SOURCE}/chats/whatever/promote`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * The source project is resolved BEFORE the destination is created, so an
   * unknown source is a 404 that leaves no half-made project behind. Worth
   * pinning: the pre-Phase-6 route had no source at all, so this failure mode
   * is new with the generalisation.
   */
  it("404s when the SOURCE project doesn't exist, and creates nothing", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/projects/no-such-project/chats/whatever/promote`,
      payload: { name: "Ghost Project" },
    });
    expect(res.statusCode).toBe(404);
    const listed = (await t.app.inject({ method: "GET", url: "/api/projects" })).json().projects;
    expect(listed.map((p: { slug: string }) => p.slug)).not.toContain("ghost-project");
  });
});
