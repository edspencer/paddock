import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { encodeProjectDir } from "../../src/transcripts.js";
import { resetMigrationProbeCache } from "../../src/transcripts-migration.js";
import { resetMigrationSingleFlight } from "../../src/routes/transcripts.js";

/**
 * `POST /api/transcripts/migration` over the REAL app (#882).
 *
 * The unit suite drives `executeMigration` directly and owns the survivor
 * table. This drives the HTTP route, which is where the things a unit test
 * cannot see live: the response schema (`additionalProperties: false` STRIPS
 * anything undeclared, so a field in the DTO and not in the schema silently
 * disappears here), the refusals and their ORDERING — every one of which must
 * leave the filesystem byte-identical — the single-flight latch, and the config
 * file actually being written.
 *
 * `startTestApp` gives each app a throwaway `HOME`, which is what makes it safe
 * to have "the user's own `~/.claude`" at all: this endpoint MOVES FILES INTO
 * that directory, and on a real machine it holds the user's actual history.
 */
describe("integration: own → host migration execute (#882)", () => {
  let t: TestApp;
  let userHome: string;
  let acmeDir: string;

  const hostStoreFor = (workingDir: string) =>
    path.join(userHome, "projects", encodeProjectDir(workingDir));

  function lines(sessionId: string, count: number, tag = "a", from = 0): string[] {
    const out: string[] = [];
    for (let i = from; i < from + count; i++) {
      out.push(
        JSON.stringify({
          type: i % 2 === 0 ? "user" : "assistant",
          uuid: `${tag}-${sessionId}-${i}`,
          parentUuid: i === 0 ? null : `${tag}-${sessionId}-${i - 1}`,
          sessionId,
          cwd: "/tmp",
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
          message: {
            role: i % 2 === 0 ? "user" : "assistant",
            content: i === 0 ? "the first user message" : `turn ${i} ${"x".repeat(64)}`,
          },
        }),
      );
    }
    return out;
  }

  async function write(file: string, body: string[]): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body.join("\n") + "\n", "utf8");
  }

  /** Every regular file under the app's temp root, for an untouched-assertion. */
  async function snapshot(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(full);
      }
    };
    await walk(t.tmp);
    return out.sort();
  }

  const post = (payload: unknown) =>
    t.app.inject({ method: "POST", url: "/api/transcripts/migration", payload });

  const plan = async () =>
    (await t.app.inject({ method: "GET", url: "/api/transcripts/migration/chats" })).json();

  beforeEach(async () => {
    // OpenAPI is off by default; on, so the published-contract test can read
    // the same document `scripts/dump-openapi.mjs` writes.
    t = await startTestApp({ env: { PADDOCK_OPENAPI_ENABLED: "1" } });
    userHome = path.join(t.home, ".claude");
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Acme" } });
    acmeDir = path.join(t.projectsRoot, "acme");

    // A net-new chat, a chat the user also has and Paddock has added to, and a
    // chat both sides advanced independently.
    await write(path.join(acmeDir, ".chats", "new-1.jsonl"), lines("new-1", 6));
    const base = lines("ff-1", 4);
    await write(path.join(acmeDir, ".chats", "ff-1.jsonl"), [...base, ...lines("ff-1", 4, "a", 4)]);
    await write(path.join(hostStoreFor(acmeDir), "ff-1.jsonl"), base);
    const shared = lines("div-1", 4);
    await write(path.join(acmeDir, ".chats", "div-1.jsonl"), [
      ...shared,
      ...lines("div-1", 2, "own", 4),
    ]);
    await write(path.join(hostStoreFor(acmeDir), "div-1.jsonl"), [
      ...shared,
      ...lines("div-1", 5, "host", 4),
    ]);
    // The root workspace, whose slug is the EMPTY STRING and therefore falsy.
    await write(path.join(t.projectsRoot, ".chats", "root-1.jsonl"), lines("root-1", 4));

    resetMigrationProbeCache();
    resetMigrationSingleFlight();
    delete process.env.PADDOCK_CLAUDE_TRANSCRIPTS;
  });

  afterEach(async () => {
    delete process.env.PADDOCK_CLAUDE_TRANSCRIPTS;
    await t.teardown();
  });

  /* ---------------------------------------------------------------------- */

  it("migrates, empties every `.chats/`, and writes the config LAST", async () => {
    const before = await plan();
    const res = await post({
      sessionIds: ["new-1", "ff-1", "div-1", "root-1"],
      expectedVersion: before.configVersion,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.ok).toBe(true);
    expect(body.configWritten).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(body.migrated.sort()).toEqual(["div-1", "ff-1", "new-1", "root-1"]);

    // The postcondition, for every project — including the root workspace,
    // whose empty-string slug is falsy and is the one a `if (!slug)` drops.
    for (const p of body.projects) expect(p.chatsDirEmpty).toBe(true);
    expect(await fs.readdir(path.join(acmeDir, ".chats"))).toEqual([]);
    expect(await fs.readdir(path.join(t.projectsRoot, ".chats"))).toEqual([]);

    // The survivors are in the host stores…
    expect(
      await fs.readFile(path.join(hostStoreFor(acmeDir), "new-1.jsonl"), "utf8"),
    ).toContain("the first user message");
    // …and the copy `div-1` superseded is intact in the preserve dir, a SIBLING
    // of `.chats/` rather than a child of it (a child would leave `.chats/`
    // non-empty and make `pointChatsDirAt` decline the redirect — #708's own
    // symptom, shipped by the migration built to fix it).
    const preserved = path.join(acmeDir, ".chats-pre-migration", "div-1.jsonl");
    expect(await fs.readFile(preserved, "utf8")).toContain("host-div-1-8");
    expect(body.preserved).toContainEqual(
      expect.objectContaining({ sessionId: "div-1", side: "host", reason: "superseded" }),
    );

    // The commit point actually landed in the file, not just in the response.
    const cfgFile = await fs.readFile(
      path.join(t.tmp, "data", "paddock.config.yaml"),
      "utf8",
    );
    expect(cfgFile).toMatch(/transcripts:\s*host/);
    expect(body.configVersion).toBeTruthy();
  });

  it("is idempotent: a second POST is alreadyMigrated and moves nothing", async () => {
    expect((await post({ sessionIds: ["new-1", "ff-1", "div-1", "root-1"] })).statusCode).toBe(200);
    const after = await snapshot();

    const second = (await post({ sessionIds: ["new-1", "ff-1", "div-1", "root-1"] })).json();
    expect(second.alreadyMigrated).toBe(true);
    expect(second.migrated).toEqual([]);
    expect(second.preserved).toEqual([]);
    expect(second.configWritten).toBe(false);
    // The process is still resolving `own` against a `.chats/` the first call
    // emptied, so the restart the first call earned is still outstanding.
    expect(second.restartRequired).toBe(true);
    expect(await snapshot()).toEqual(after);
  });

  it("409 config_conflict on a stale expectedVersion, with nothing moved", async () => {
    const before = await snapshot();
    const res = await post({ sessionIds: ["new-1"], expectedVersion: "not-the-version" });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "config_conflict" });
    expect(await snapshot()).toEqual(before);
  });

  it("400 env_shadowed when the env beats the config file, with nothing moved", async () => {
    process.env.PADDOCK_CLAUDE_TRANSCRIPTS = "own";
    const before = await snapshot();

    const res = await post({ sessionIds: ["new-1"] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "env_shadowed",
      envVar: "PADDOCK_CLAUDE_TRANSCRIPTS",
    });
    // The point of refusing rather than moving: the write would be inert, so the
    // instance would come back on `own` with an empty `.chats/` — every chat
    // moved for nothing.
    expect(await snapshot()).toEqual(before);
  });

  it("400 on a session id that could escape `.chats/`, with nothing moved", async () => {
    const before = await snapshot();
    const res = await post({ sessionIds: ["../../etc/passwd"] });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid" });
    expect(await snapshot()).toEqual(before);
  });

  it(
    "409 turn_running with NOTHING moved, and a concurrent POST gets migration_in_progress",
    { timeout: 30_000 },
    async () => {
      // A turn that will not die. `quiesceSession` polls until its 10 s deadline
      // and reports `stuck`, which is the state the refusal exists for — the
      // #731 resurrection is what happens if a transcript is moved out from
      // under a live `claude`.
      const active = {
        sessionId: "new-1",
        projectSlug: "acme",
        jobId: null,
        running: true,
        startedAt: Date.now(),
      };
      t.hub.runningSessions = () => [active];
      t.hub.isRunning = (id: string) => id === "new-1";
      t.hub.activeInfo = () => active;
      t.hub.noteCancel = () => undefined;

      const before = await snapshot();
      const refusal = post({ sessionIds: ["new-1", "ff-1", "div-1", "root-1"] });

      // While that one is parked in the quiesce, a second request — the browser
      // resending, or a second tab. The client-side guard survives neither.
      await new Promise((r) => setTimeout(r, 100));
      const concurrent = await post({ sessionIds: ["new-1"] });
      expect(concurrent.statusCode).toBe(409);
      expect(concurrent.json()).toMatchObject({ code: "migration_in_progress" });

      const res = await refusal;
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "turn_running", sessionIds: ["new-1"] });

      // The whole migration refused rather than pushing the busy chat into a
      // `failed` bucket: one chat left behind leaves `.chats/` non-empty, which
      // breaks the flip for its entire project (§4.4).
      expect(await snapshot()).toEqual(before);
    },
  );

  it("a dry run reports the plan and touches nothing", async () => {
    const before = await snapshot();
    const body = (await post({ sessionIds: ["new-1", "ff-1"], dryRun: true })).json();

    expect(body.dryRun).toBe(true);
    expect(body.configWritten).toBe(false);
    expect(body.restartRequired).toBe(false);
    expect(body.migrated.sort()).toEqual(["ff-1", "new-1"]);
    expect(await snapshot()).toEqual(before);
  });

  it("publishes the declared fields and strips nothing the client needs", async () => {
    // `additionalProperties: false` means Fastify's serializer DROPS any key the
    // schema does not declare. A field added to the DTO and forgotten in the
    // schema disappears at runtime — this is where that gets caught.
    const body = (await post({ sessionIds: ["new-1"], dryRun: true })).json();
    for (const key of [
      "ok",
      "alreadyMigrated",
      "dryRun",
      "projects",
      "migrated",
      "preserved",
      "unplanned",
      "ignoredSessionIds",
      "failed",
      "sweepers",
      "warnings",
      "configWritten",
      "configPath",
      "restartRequired",
    ]) {
      expect(body, `missing ${key}`).toHaveProperty(key);
    }
    expect(Object.keys(body.projects[0]).sort()).toEqual(
      ["chatsDirEmpty", "migrated", "outcome", "preserved", "slug"].sort(),
    );
  });

  it("recovers a STRANDED `host` instance: files move, no config write, restart still required", async () => {
    // #708's other half, over the real route (#882 §2). The instance already
    // resolves `host`; its `.chats/` is a non-empty REAL directory because
    // `pointChatsDirAt` declined the redirect, so none of these chats is
    // visible anywhere in the UI. The recovery has no config write to make —
    // the file already says `host` — so its success has to be measured by the
    // postcondition instead.
    const stranded = await startTestApp({
      configFile: { claude: { transcripts: "host" } },
    });
    try {
      const dir = path.join(stranded.projectsRoot, "stranded");
      await fs.mkdir(path.join(dir, ".chats"), { recursive: true });
      await fs.writeFile(
        path.join(dir, "project.yaml"),
        "name: Stranded\nstatus: active\n",
        "utf8",
      );
      const ids = ["left-behind-1", "left-behind-2"];
      for (const id of ids) {
        await write(path.join(dir, ".chats", `${id}.jsonl`), lines(id, 4));
      }
      resetMigrationProbeCache();
      resetMigrationSingleFlight();

      // The offer is made at all — this is the half #899 refused.
      const probe = (
        await stranded.app.inject({ method: "GET", url: "/api/transcripts/migration" })
      ).json();
      expect(probe).toMatchObject({ mode: "host", eligible: true });

      const res = await stranded.app.inject({
        method: "POST",
        url: "/api/transcripts/migration",
        payload: { sessionIds: ids },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.ok).toBe(true);
      expect(body.migrated.sort()).toEqual(ids);
      expect(body.configWritten).toBe(false); // nothing to write: already `host`
      expect(body.alreadyMigrated).toBe(false); // real work happened
      expect(body.restartRequired).toBe(true); // the redirect is planted at boot

      // The postcondition — the ONLY thing standing between these chats and
      // being visible again. On the next boot `pointChatsDirAt` finds this
      // empty, plants the redirect, and they reappear.
      expect(await fs.readdir(path.join(dir, ".chats"))).toEqual([]);
      const hostStore = path.join(stranded.home, ".claude", "projects", encodeProjectDir(dir));
      expect((await fs.readdir(hostStore)).sort()).toEqual(ids.map((id) => `${id}.jsonl`));
    } finally {
      await stranded.teardown();
    }
  });

  it("is described in the published OpenAPI document", async () => {
    // The same document `scripts/dump-openapi.mjs` publishes.
    const doc = (t.app as unknown as { swagger: () => { paths: Record<string, never> } }).swagger();
    const op = doc.paths["/api/transcripts/migration"] as unknown as {
      post: { tags: string[]; responses: Record<string, { content: Record<string, { schema: { properties: Record<string, unknown> } }> }> };
    };
    expect(op.post).toBeTruthy();
    expect(op.post.tags).toEqual(["System"]);
    // Not `additionalProperties: true` with the shape in prose — #822's point.
    expect(
      op.post.responses["200"].content["application/json"].schema.properties.configWritten,
    ).toBeTruthy();
    expect(op.post.responses["409"]).toBeTruthy();
  });
});
