import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { encodePathForCli, PathTraversalError } from "@herdctl/core";
import { startTestApp, type TestApp } from "../helpers/app.js";

const run = promisify(execFile);

/**
 * Importing native Claude Code chats (#588), end to end over the REAL app.
 *
 * The setup mirrors the situation the feature exists for: a user with terminal
 * `claude` history in their OWN checkout of a repo, who then makes a paddock
 * project backed by that repo. Their transcripts live in a Claude home folder
 * that has nothing to do with the project's directory, and the only thing tying
 * the two together is the checkout's name.
 */
describe("integration: import native Claude Code chats (#588)", () => {
  let t: TestApp;
  /**
   * The USER's own Claude home (`$HOME/.claude`) — where their terminal history
   * lives, and the read-only SOURCE adoption imports out of (#620).
   */
  let userHome: string;
  /**
   * Paddock's OWN Claude home (`<dataDir>/claude-home`) — the DESTINATION a copy
   * is placed in, which resolves through the project's `.chats/` symlink.
   *
   * These being two different directories is the point: post-#620 an import has
   * to cross from one home into the other, and it can only do that because
   * `mirrorLegacyTranscriptFolders` makes the user's folders readable through
   * paddock's home. If that mirror regresses, every count here goes to zero.
   */
  let ownHome: string;
  /** The user's own clone of `acme-api`, nothing to do with the project dir. */
  let laptopCheckout: string;

  /** Write a transcript for `cwd`, optionally back-dating it. */
  async function transcript(
    cwd: string,
    sessionId: string,
    opts: { firstUserText?: string; mtime?: Date; lines?: number } = {},
  ): Promise<string> {
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
    return file;
  }

  const adoptable = async (base: string) =>
    (await t.app.inject({ method: "GET", url: `${base}/adoptable-chats` })).json() as {
      count: number;
      sources: Array<{ sourceCwd: string; sessionIds: string[] }>;
      filtered: Array<{ sessionId: string; reason: string }>;
    };

  beforeAll(async () => {
    t = await startTestApp();
    userHome = t.cfg.legacyClaudeHome;
    ownHome = t.cfg.claudeHome;
    expect(userHome).toBe(path.join(t.home, ".claude"));
    // A real discriminator: without this the two homes coincide and every
    // cross-home assertion below passes vacuously.
    expect(ownHome).not.toBe(userHome);
    expect(t.cfg.ownsClaudeHome).toBe(true);

    // A local git repo to back the project (no network).
    const src = path.join(t.tmp, "_src", "acme-api");
    await fs.mkdir(src, { recursive: true });
    await run("git", ["init", "-q", "-b", "main", src]);
    await fs.writeFile(path.join(src, "README.md"), "# acme-api\n");
    await run("git", ["-C", src, "add", "-A"]);
    await run("git", [
      "-C", src,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-q", "-m", "init",
    ]);

    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Acme Api" } });
    const promoted = await t.app.inject({
      method: "POST",
      url: "/api/projects/acme-api/promote",
      payload: { repo: src },
    });
    expect(promoted.statusCode).toBe(200);

    // The user's own clone, elsewhere on the "laptop" — same basename, and that
    // is the ONLY thing linking it to the project.
    laptopCheckout = path.join(t.tmp, "laptop", "code", "acme-api");
    await fs.mkdir(laptopCheckout, { recursive: true });
  });
  afterAll(async () => {
    await t.teardown();
  });

  it("reports count 0 for a project with no terminal history", async () => {
    const body = await adoptable("/api/projects/acme-api");
    expect(body).toEqual({ count: 0, sources: [], filtered: [] });
  });

  it("finds the user's own checkout by name, and withholds the junk", async () => {
    await transcript(laptopCheckout, "aaaaaaaa-1111-4111-8111-111111111111");
    await transcript(laptopCheckout, "bbbbbbbb-2222-4222-8222-222222222222");
    // Noise: a `/mcp` session and a zero-byte stub.
    await transcript(laptopCheckout, "cccccccc-3333-4333-8333-333333333333", {
      firstUserText: "/mcp",
    });
    await fs.writeFile(
      path.join(
        userHome,
        "projects",
        encodePathForCli(laptopCheckout),
        "dddddddd-4444-4444-8444-444444444444.jsonl",
      ),
      "",
      "utf8",
    );

    const body = await adoptable("/api/projects/acme-api");
    expect(body.count).toBe(2);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0].sourceCwd).toBe(laptopCheckout);
    expect(body.sources[0].sessionIds.sort()).toEqual([
      "aaaaaaaa-1111-4111-8111-111111111111",
      "bbbbbbbb-2222-4222-8222-222222222222",
    ]);
    // Nothing was dropped silently — both exclusions are named.
    expect(body.filtered.map((f) => [f.sessionId, f.reason]).sort()).toEqual([
      ["cccccccc-3333-4333-8333-333333333333", "slash-command-only"],
      ["dddddddd-4444-4444-8444-444444444444", "too-small"],
    ]);
  });

  it("offers each session ONCE, even though the project's own dir is also scanned", async () => {
    const body = await adoptable("/api/projects/acme-api");
    const ids = body.sources.flatMap((s) => s.sessionIds);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects a sourceCwd the project does not actually offer (400, not a scan)", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/acme-api/adopt-chats",
      payload: { sourceCwd: "/etc" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid");
  });

  it("--dry-run writes NOTHING: no adoption records, no placed copies", async () => {
    const project = (await t.app.inject({ method: "GET", url: "/api/projects/acme-api" })).json()
      .project;
    const stateDir = t.cfg.stateDir;
    const before = await fs.readdir(path.join(stateDir, "adopted-sessions")).catch(() => []);

    const { adopted } = await t.herdctl.adoptChats(project, { dryRun: true });
    expect(adopted.sort()).toEqual([
      "aaaaaaaa-1111-4111-8111-111111111111",
      "bbbbbbbb-2222-4222-8222-222222222222",
    ]);

    // Not one byte of state moved.
    expect(await fs.readdir(path.join(stateDir, "adopted-sessions")).catch(() => [])).toEqual(
      before,
    );
    const destDir = path.join(ownHome, "projects", encodePathForCli(project.workingDir));
    expect(await fs.readdir(destDir).catch(() => [])).toEqual([]);
    // …and the project still offers exactly what it did before.
    expect((await adoptable("/api/projects/acme-api")).count).toBe(2);
  });

  it("imports, listing the chats and preserving their real timestamps", async () => {
    // Back-date one transcript by months. mtime is the chat-list sort key AND the
    // title/preview cache key, so an import that stamps "now" silently rewrites
    // the user's history into a single day.
    const old = new Date("2026-01-31T09:00:00Z");
    const source = path.join(
      userHome,
      "projects",
      encodePathForCli(laptopCheckout),
      "aaaaaaaa-1111-4111-8111-111111111111.jsonl",
    );
    await fs.utimes(source, old, old);

    const res = await t.app.inject({
      // The web client posts an EMPTY OBJECT, not null, when importing everything.
      method: "POST",
      url: "/api/projects/acme-api/adopt-chats",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { adopted, skipped } = res.json() as {
      adopted: string[];
      skipped: Array<{ sessionId: string; reason: string }>;
    };
    expect(adopted.sort()).toEqual([
      "aaaaaaaa-1111-4111-8111-111111111111",
      "bbbbbbbb-2222-4222-8222-222222222222",
    ]);
    // The import brings in exactly what the count offered — the noise the header
    // withheld is withheld here too, and says why rather than arriving silently.
    expect(
      skipped
        .filter((s) => s.reason === "too-small" || s.reason === "slash-command-only")
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual([
      "cccccccc-3333-4333-8333-333333333333",
      "dddddddd-4444-4444-8444-444444444444",
    ]);

    // They list under the project — no restart, caches dropped by the import.
    const chats = (await t.app.inject({ method: "GET", url: "/api/projects/acme-api/chats" }))
      .json().chats as Array<{ sessionId: string; provenance?: { origin: string } }>;
    const listed = chats.filter((c) => adopted.includes(c.sessionId));
    expect(listed).toHaveLength(2);

    // Badged as imported, not as an ordinary human chat.
    expect(listed.every((c) => c.provenance?.origin === "adopted")).toBe(true);

    // COPY, not move: the user's own transcript is still there…
    expect((await fs.stat(source)).isFile()).toBe(true);
    // …and the copy kept its months-old mtime.
    const project = (await t.app.inject({ method: "GET", url: "/api/projects/acme-api" })).json()
      .project as { workingDir: string };
    const copy = path.join(
      ownHome,
      "projects",
      encodePathForCli(project.workingDir),
      "aaaaaaaa-1111-4111-8111-111111111111.jsonl",
    );
    expect(Math.abs((await fs.stat(copy)).mtime.getTime() - old.getTime())).toBeLessThan(2000);

    // A withheld session left NO trace in the project: no copy placed, and the
    // user's own file untouched where it always was.
    const destDir = path.join(ownHome, "projects", encodePathForCli(project.workingDir));
    expect((await fs.readdir(destDir)).sort()).toEqual([
      "aaaaaaaa-1111-4111-8111-111111111111.jsonl",
      "bbbbbbbb-2222-4222-8222-222222222222.jsonl",
    ]);
    const junk = path.join(
      userHome,
      "projects",
      encodePathForCli(laptopCheckout),
      "cccccccc-3333-4333-8333-333333333333.jsonl",
    );
    expect((await fs.stat(junk)).isFile()).toBe(true);
  });

  it("drops the cached count after the import (the button must go away)", async () => {
    // The same request that returned 2 a moment ago now returns 0, without any
    // directory having changed since — which only works if the import
    // invalidated the detection cache rather than waiting out an mtime.
    const body = await adoptable("/api/projects/acme-api");
    expect(body.count).toBe(0);
    expect(body.sources).toEqual([]);
  });

  it("is a no-op the second time — everything is already adopted", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/acme-api/adopt-chats",
      payload: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().adopted).toEqual([]);
  });

  it("never even offers a transcript whose filename is not a safe session id", async () => {
    // Defence in depth, from the outside in: the engine's own listing refuses to
    // treat `..evil.jsonl` as a session at all, so a traversal-shaped id cannot
    // reach the adoption record that would throw on it. Asserted so that a future
    // change loosening that filter shows up here rather than as a 500.
    const dir = path.join(userHome, "projects", encodePathForCli(laptopCheckout));
    for (const name of ["..evil", "..", "a..b"]) {
      await fs.writeFile(
        path.join(dir, `${name}.jsonl`),
        JSON.stringify({
          type: "user",
          cwd: laptopCheckout,
          message: { role: "user", content: "x".repeat(400) },
        }) + "\n",
        "utf8",
      );
    }
    const body = await adoptable("/api/projects/acme-api");
    expect(body.count).toBe(0);
    // Not offered, and not even reported as filtered — the engine never saw them
    // as sessions, so they are outside this feature's world entirely.
    const seen = [
      ...body.sources.flatMap((s) => s.sessionIds),
      ...body.filtered.map((f) => f.sessionId),
    ];
    expect(seen.some((id) => id.includes(".."))).toBe(false);

    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/acme-api/adopt-chats",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().adopted).toEqual([]);
  });

  it("maps a PathTraversalError to 400, not 500 — bad input, not a server fault", async () => {
    const spy = vi
      .spyOn(t.herdctl, "adoptChats")
      .mockRejectedValueOnce(new PathTraversalError("/state/adopted-sessions", "../../etc", "/etc"));
    try {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/projects/acme-api/adopt-chats",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * The headline case, and the one #620 had to build new machinery for: the user
   * already has terminal history for the very directory the workspace is backed
   * by. The root workspace IS that case by construction — its working dir is
   * `projectsRoot`, whose encoded folder name paddock's own `.chats/` symlink
   * already occupies.
   *
   * Pre-#620 this "worked" only because `ensureProjectChats` had already moved
   * those transcripts out of `~/.claude` and deleted the originals at
   * registration. With that gone the import has to genuinely COPY between two
   * different Claude homes, which is what the mirror's synthetic naming exists
   * to make possible.
   */
  it("serves the ROOT workspace too, whose working dir is projectsRoot", async () => {
    const sessionId = "eeeeeeee-5555-4555-8555-555555555555";
    const source = await transcript(t.projectsRoot, sessionId);
    const body = await adoptable("/api/root");
    expect(body.count).toBe(1);
    // Displayed as the directory the user recognises, never as the synthetic
    // path the engine was actually handed.
    expect(body.sources[0].sourceCwd).toBe(t.projectsRoot);

    const res = await t.app.inject({ method: "POST", url: "/api/root/adopt-chats", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().adopted).toEqual([sessionId]);
    expect((await adoptable("/api/root")).count).toBe(0);

    // COPY, across two homes: the user's original is exactly where it was, and a
    // copy now sits in the workspace's own transcript folder.
    expect((await fs.stat(source)).isFile()).toBe(true);
    const placed = path.join(
      ownHome,
      "projects",
      encodePathForCli(t.projectsRoot),
      `${sessionId}.jsonl`,
    );
    expect((await fs.stat(placed)).isFile()).toBe(true);
  });

  /**
   * The regression #620 exists to prevent. `ensureProjectChats` used to `fs.cp`
   * the user's transcripts into `.chats/` and then `fs.rm` the originals — on
   * every agent registration, unprompted, inside a bare `catch {}`. It fired in
   * exactly this situation: a project pointed at a directory the user already had
   * terminal `claude` history for.
   */
  it("registering an agent never moves anything out of the user's home", async () => {
    const cwd = path.join(t.tmp, "laptop", "code", "untouched-repo");
    await fs.mkdir(cwd, { recursive: true });
    const source = await transcript(cwd, "ffffffff-6666-4666-8666-666666666666");
    const folder = path.dirname(source);
    const before = await fs.stat(source);

    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Untouched" } });
    const project = (await t.app.inject({ method: "GET", url: "/api/projects/untouched" })).json()
      .project as Record<string, unknown>;
    // Re-register with the user's directory as the working dir — the exact moment
    // the old code destroyed the originals.
    await t.herdctl.ensureProjectAgent({ ...project, workingDir: cwd } as never);

    // Still a REAL directory in the user's home, still holding the transcript,
    // with mtime and size intact (mtime is the chat-list sort key AND the cache
    // key for auto-name / preview / sidechain detection).
    expect((await fs.lstat(folder)).isDirectory()).toBe(true);
    expect((await fs.lstat(folder)).isSymbolicLink()).toBe(false);
    expect((await fs.stat(source)).mtimeMs).toBe(before.mtimeMs);
    expect((await fs.stat(source)).size).toBe(before.size);
  });
});
