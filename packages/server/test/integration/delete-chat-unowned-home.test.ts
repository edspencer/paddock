/**
 * #689 — deleting a chat must not destroy a transcript paddock does not own.
 *
 * The failure this pins down was reproduced against a live instance: with the
 * Claude home pointed at the user's own `~/.claude`, `DELETE /chats/:id` came
 * back `{"ok":true,"removed":true}` and the user's terminal `claude` history for
 * that directory was gone from disk.
 *
 * There is no copy to fall back on, which is the part that makes it data loss
 * rather than an inconvenience: `ensureProjectChats` deliberately plants no
 * symlink in a home paddock does not own (#682), so the file the agent reads and
 * writes IS the user's. It is #682 pointed the other way — that one claimed
 * where future sessions get written, this one deleted the past ones.
 *
 * Both directions are asserted here. A test that only covered the unowned case
 * could be satisfied by never deleting anything.
 *
 * Scope: this fixes the DATA LOSS only. The released chat is still listed, which
 * is a known gap with its own test below — see there for why the tombstone that
 * closes it is deferred rather than forgotten.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";
import { encodeProjectDir } from "../../src/transcripts.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" &&
  e.payload?.projectSlug === slug &&
  typeof e.payload?.sessionId === "string";

/** Drive one real turn through the fake `claude` to mint a real session id. */
async function oneTurn(ws: WsClient, slug: string, message: string): Promise<string> {
  const mark = ws.mark();
  ws.send({ type: "chat:send", payload: { projectSlug: slug, sessionId: null, message } });
  const complete = await ws.waitFor(isComplete(slug), { from: mark });
  return complete.payload?.sessionId as string;
}

describe("integration: deleting a chat in a Claude home paddock does NOT own (#689)", () => {
  let t: TestApp;
  let ws: WsClient;
  let sessionId: string;
  let transcript: string;

  const SLUG = "unowned-del";

  let userHome: string;

  beforeAll(async () => {
    // `ownsClaudeHome` is DERIVED — `resolve(claudeHome) !== resolve(homedir()/.claude)`
    // — so making it false means those two must be the same path, and the
    // harness picks its own HOME after we would have to name it. Hence both vars
    // here, pointing at a home of our own: `opts.env` is applied last, so this
    // wins over the harness's HOME, and `os.homedir()` reads it at build time.
    //
    // With the two equal, herdctl also (correctly) declines to inject
    // CLAUDE_CONFIG_DIR, so the fake `claude` resolves the same tree. Nothing in
    // the fixture is fighting the harness; it is the laptop shape exactly.
    userHome = await makeTmpDir("paddock-userhome-");
    t = await startTestApp({
      env: { HOME: userHome, CLAUDE_HOME: path.join(userHome, ".claude") },
    });
    const { port } = await listen(t.app);
    ws = await connectWs(port);
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: SLUG } });
    sessionId = await oneTurn(ws, SLUG, "history worth keeping");

    // Where the engine actually put it — the user's home, with no `.chats/`
    // symlink in front of it.
    transcript = path.join(
      userHome,
      ".claude",
      "projects",
      encodeProjectDir(path.join(t.projectsRoot, SLUG)),
      `${sessionId}.jsonl`,
    );
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    await t?.teardown();
    await rmTmpDir(userHome);
  });

  it("puts the transcript in the user's home, with no .chats/ symlink in front", async () => {
    // Guards the fixture itself. If this stops holding, the assertions below
    // would be deleting a paddock-owned copy and would pass for the wrong reason.
    expect(await fs.stat(transcript).then((s) => s.isFile())).toBe(true);
    const encoded = path.dirname(transcript);
    expect((await fs.lstat(encoded)).isSymbolicLink()).toBe(false);
  });

  it("releases the chat instead of removing it, leaving the transcript on disk", async () => {
    const before = await fs.readFile(transcript, "utf8");

    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${SLUG}/chats/${sessionId}`,
    });

    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, removed: false, retained: true });

    // The assertion the bug was: byte-identical, still there.
    expect(await fs.readFile(transcript, "utf8")).toBe(before);
  });

  // KNOWN GAP, asserted so it cannot change silently: the chat is still listed.
  //
  // `unadoptSession` only drops an adoption record, and a chat paddock CREATED
  // in an unowned home is discovered structurally — the engine scans
  // `<claudeHome>/projects/<enc-cwd>/`, finds the file, and lists it again. So
  // the transcript is safe (the assertions above) but the user's actual intent,
  // "take this out of my chat list", is not yet honoured.
  //
  // Closing it needs a tombstone: paddock filtering a session it must not
  // delete. That is deliberately NOT built here — see #689. This delete branch
  // keys off `ownsClaudeHome`, which #691 removes (paddock will always own its
  // home, and `transcripts: own|host` becomes the discriminator), so the
  // tombstone belongs with that mode rather than to a flag about to disappear.
  it("does NOT yet remove it from the list (the tombstone is still owed)", async () => {
    t.herdctl.invalidateSessions(`keeper-${SLUG}`);
    const chats = (await t.app.inject({ method: "GET", url: `/api/projects/${SLUG}/chats` })).json()
      .chats;
    expect(chats.map((c: { sessionId: string }) => c.sessionId)).toContain(sessionId);
  });
});

describe("integration: deleting a chat in a Claude home paddock DOES own", () => {
  let t: TestApp;
  let ws: WsClient;

  const SLUG = "owned-del";

  beforeAll(async () => {
    t = await startTestApp(); // default: <dataDir>/claude-home, owned
    const { port } = await listen(t.app);
    ws = await connectWs(port);
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: SLUG } });
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    await t?.teardown();
  });

  // The other half of the invariant. Releasing everywhere would be "safe" and
  // useless — in a home paddock owns, the transcript is its own copy in the
  // project's `.chats/`, and delete has to mean delete.
  it("removes the transcript, because the copy is paddock's own", async () => {
    const sessionId = await oneTurn(ws, SLUG, "delete me for real");
    const transcript = path.join(t.projectsRoot, SLUG, ".chats", `${sessionId}.jsonl`);
    expect(await fs.stat(transcript).then((s) => s.isFile())).toBe(true);

    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${SLUG}/chats/${sessionId}`,
    });

    expect(del.json()).toMatchObject({ ok: true, removed: true, retained: false });
    await expect(fs.stat(transcript)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});
