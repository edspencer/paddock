import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { encodePathForCli } from "@herdctl/core";
import { startTestApp, type TestApp } from "../helpers/app.js";

/**
 * Instance-level Discovery over the REAL app (#745).
 *
 * The situation the feature exists for: someone who has been using terminal
 * `claude` for months, on a machine with no Paddock projects on it yet. Their
 * history is in their OWN `~/.claude` — a different home from paddock's own
 * (#620) — and it is a mixture of two real repositories, a scratch directory
 * they `cd`'d into once, a folder for a directory they have since deleted, and
 * a download folder that is not a repo at all.
 *
 * The second half is the claim issue #745 makes about the flow: that Discovery
 * needs a new endpoint for steps 1–2 but that steps 3–4 work with `POST
 * /api/projects` and `POST …/adopt-chats` UNCHANGED. That is asserted here end
 * to end, because if it were false the whole shape of the feature would be
 * wrong.
 */
describe("integration: discover directories to import (#745)", () => {
  let t: TestApp;
  /** The USER's own Claude home — where terminal history lives. */
  let userHome: string;
  let acme: string;
  let widgets: string;
  let downloads: string;

  /** Write a transcript for `cwd` into the user's own Claude home. */
  async function transcript(
    cwd: string,
    sessionId: string,
    opts: { firstUserText?: string; mtime?: Date; lines?: number } = {},
  ): Promise<void> {
    const dir = path.join(userHome, "projects", encodePathForCli(cwd));
    await fs.mkdir(dir, { recursive: true });
    const body: string[] = [
      JSON.stringify({
        type: "user",
        cwd,
        sessionId,
        timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
        message: { role: "user", content: opts.firstUserText ?? `real work in ${cwd}` },
      }),
    ];
    for (let i = 0; i < (opts.lines ?? 3); i++) {
      body.push(
        JSON.stringify({
          type: "assistant",
          cwd,
          sessionId,
          message: { role: "assistant", content: [{ type: "text", text: "x".repeat(200) }] },
        }),
      );
    }
    const file = path.join(dir, `${sessionId}.jsonl`);
    await fs.writeFile(file, body.join("\n") + "\n", "utf8");
    if (opts.mtime) await fs.utimes(file, opts.mtime, opts.mtime);
  }

  /** A directory that looks like a git checkout, without shelling out to git. */
  async function checkout(dir: string): Promise<string> {
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:acme/${path.basename(dir)}.git\n`,
      "utf8",
    );
    return dir;
  }

  const discover = async (query = "") =>
    (await t.app.inject({ method: "GET", url: `/api/discover${query}` })).json() as {
      claudeHome: string;
      homeDir: string;
      scanned: number;
      candidates: Array<{
        path: string;
        name: string;
        suggestedSlug: string;
        hasGit: boolean;
        gitRemote?: string;
        sessionCount: number;
        filteredCount: number;
        lastSessionAt?: string;
      }>;
      excluded: Record<string, number>;
    };

  beforeAll(async () => {
    t = await startTestApp();
    userHome = t.cfg.legacyClaudeHome;
    // A real discriminator: if these coincided, every cross-home assertion below
    // would pass vacuously.
    expect(userHome).not.toBe(t.cfg.claudeHome);

    acme = await checkout(path.join(t.home, "Code", "acme-api"));
    widgets = await checkout(path.join(t.home, "Code", "widgets"));
    downloads = path.join(t.home, "Downloads");
    await fs.mkdir(downloads, { recursive: true });

    // Two real repositories, one busier than the other.
    await transcript(acme, "acme-1", { mtime: new Date("2026-05-01T00:00:00Z") });
    await transcript(acme, "acme-2", { mtime: new Date("2026-06-01T00:00:00Z") });
    // …plus one session in `acme` that is pure noise and must not be counted.
    // Big enough to clear MIN_TRANSCRIPT_BYTES, so it is withheld for what it
    // IS (a slash command that went nowhere) rather than for being a stub.
    await transcript(acme, "acme-noise", { firstUserText: "/mcp", lines: 1 });
    await transcript(widgets, "widgets-1", { mtime: new Date("2026-04-01T00:00:00Z") });

    // The junk the heuristic exists to remove.
    await transcript("/", "root-dir");
    await transcript("/etc", "etc-dir");
    await transcript(path.join(t.home, "Downloads"), "downloads-1");
    const scratch = path.join(t.tmp, "elsewhere", "scratch");
    await fs.mkdir(scratch, { recursive: true });
    await transcript(scratch, "scratch-1");
    await transcript(path.join(t.home, "Code", "deleted-months-ago"), "gone-1");
    await transcript(t.home, "home-itself");
  });

  afterAll(async () => {
    await t.teardown();
  });

  it("offers only the real repositories, ranked by session count", async () => {
    const res = await discover();
    expect(res.candidates.map((c) => c.path)).toEqual([acme, widgets]);
    expect(res.candidates[0]).toMatchObject({
      name: "acme-api",
      suggestedSlug: "acme-api",
      hasGit: true,
      gitRemote: "github.com/acme/acme-api",
      sessionCount: 2,
      // The `/mcp` session is withheld and reported, never silently dropped.
      filteredCount: 1,
      lastSessionAt: "2026-06-01T00:00:00.000Z",
    });
    expect(res.claudeHome).toBe(t.cfg.claudeHome);
    expect(res.homeDir).toBe(t.home);
  });

  it("names a rule for every folder it threw away", async () => {
    const res = await discover();
    // EIGHT folders were planted — `acme` is one folder holding 3 sessions — and
    // `scanned` is now exactly that. This was `>= 9`, and the ninth was
    // paddock's OWN `.chats` bridge for the root workspace: planted at boot and
    // counted as if it were the user's history. That is #865 — on an instance
    // with nothing else those bridges made `scanned` non-zero, so the "no Claude
    // Code history on this machine" branch was unreachable and a first-time user
    // was told their history had already been imported or filtered out.
    expect(res.scanned).toBe(8);
    expect(res.excluded["system-path"]).toBe(2); // `/` and `/etc`
    expect(res.excluded["no-git"]).toBe(1); // ~/Downloads
    expect(res.excluded["missing"]).toBe(1); // deleted months ago
    expect(res.excluded["home-root"]).toBe(1);
    // The scratch dir is outside $HOME and under the box's temp root; either
    // rule is a correct verdict, and both are hard-or-default exclusions.
    expect((res.excluded["temp-root"] ?? 0) + (res.excluded["outside-home"] ?? 0)).toBe(1);
  });

  it("includeNonGit reveals the non-repo directory, and only that", async () => {
    const res = await discover("?includeNonGit=1");
    expect(res.candidates.map((c) => c.path)).toContain(downloads);
    expect(res.candidates.find((c) => c.path === downloads)).toMatchObject({
      hasGit: false,
      sessionCount: 1,
    });
    expect(res.excluded["no-git"]).toBeUndefined();
    // Relaxing the soft rule does not reach the hard ones.
    expect(res.candidates.map((c) => c.path)).not.toContain("/etc");
  });

  it("lists one directory's sessions for lazy expansion", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/discover/sessions?dir=${encodeURIComponent(acme)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      path: string;
      sessions: Array<{ sessionId: string; mtime: string; sizeBytes: number; preview?: string }>;
      filtered: Array<{ sessionId: string; reason: string }>;
    };
    expect(body.path).toBe(acme);
    expect(body.sessions.map((s) => s.sessionId)).toEqual(["acme-2", "acme-1"]);
    expect(body.sessions[0].sizeBytes).toBeGreaterThan(0);
    expect(body.filtered).toEqual([{ sessionId: "acme-noise", reason: "slash-command-only" }]);
  });

  it("400s a directory it did not discover, rather than reading it", async () => {
    const secret = path.join(t.home, "Private");
    await fs.mkdir(secret, { recursive: true });
    for (const dir of [secret, "/etc", t.tmp]) {
      const res = await t.app.inject({
        method: "GET",
        url: `/api/discover/sessions?dir=${encodeURIComponent(dir)}`,
      });
      expect(res.statusCode, dir).toBe(400);
      expect(res.json()).toMatchObject({ code: "invalid" });
    }
  });

  it("400s a missing dir parameter", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/discover/sessions" });
    expect(res.statusCode).toBe(400);
  });

  /**
   * The claim #745 makes about the flow, asserted rather than assumed: only
   * steps 1–2 are new. Creating the project and importing a SUBSET of its
   * sessions both go through endpoints that already exist, unchanged.
   */
  it("hands off to POST /api/projects + POST …/adopt-chats unchanged", async () => {
    const before = await discover();
    const candidate = before.candidates.find((c) => c.path === widgets);
    expect(candidate).toBeDefined();

    const created = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: candidate!.name, slug: candidate!.suggestedSlug, path: candidate!.path },
    });
    expect(created.statusCode).toBe(201);
    const slug = (created.json() as { project: { slug: string; workingDir: string } }).project;
    // The value Discovery reported IS what the project's working directory
    // becomes — which is what makes it a legal `sourceCwd` at the next step.
    expect(slug.workingDir).toBe(widgets);

    const sessions = (
      await t.app.inject({
        method: "GET",
        url: `/api/discover/sessions?dir=${encodeURIComponent(widgets)}`,
      })
    ).json() as { sessions: Array<{ sessionId: string }> };

    const adopted = await t.app.inject({
      method: "POST",
      url: `/api/projects/${slug.slug}/adopt-chats`,
      payload: { sourceCwd: widgets, sessionIds: sessions.sessions.map((s) => s.sessionId) },
    });
    expect(adopted.statusCode).toBe(200);
    expect((adopted.json() as { adopted: string[] }).adopted).toEqual(["widgets-1"]);

    // Expansion still works once the directory IS a project: `already-managed`
    // is about what can be CREATED, not about what may be read.
    const reexpanded = await t.app.inject({
      method: "GET",
      url: `/api/discover/sessions?dir=${encodeURIComponent(widgets)}`,
    });
    expect(reexpanded.statusCode).toBe(200);

    const chats = (
      await t.app.inject({ method: "GET", url: `/api/projects/${slug.slug}/chats` })
    ).json() as { chats: Array<{ sessionId: string }> };
    expect(chats.chats.map((c) => c.sessionId)).toContain("widgets-1");

    // …and the imported directory drops out of the next scan, because it is now
    // a project. That is what makes Discovery idempotent to run twice.
    const after = await discover();
    expect(after.candidates.map((c) => c.path)).not.toContain(widgets);
    expect(after.excluded["already-managed"]).toBe(1);
  });
});
