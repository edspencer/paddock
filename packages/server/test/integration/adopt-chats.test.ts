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
 * that has nothing to do with the project's directory; what ties the two
 * together is the checkout's name PLUS its git remote (#659 — the name alone
 * used to be enough, and reached into unrelated directories that happened to
 * share it).
 */
describe("integration: import native Claude Code chats (#588)", () => {
  let t: TestApp;
  /** The Claude home the app resolved (startTestApp pins it to $HOME/.claude). */
  let claudeHome: string;
  /** The user's own clone of `acme-api`, nothing to do with the project dir. */
  let laptopCheckout: string;

  /** Write a transcript for `cwd`, optionally back-dating it. */
  async function transcript(
    cwd: string,
    sessionId: string,
    opts: { firstUserText?: string; mtime?: Date; lines?: number } = {},
  ): Promise<string> {
    const dir = path.join(claudeHome, "projects", encodePathForCli(cwd));
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
    claudeHome = t.cfg.claudeHome;
    expect(claudeHome).toBe(path.join(t.home, ".claude"));

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

    // The user's own clone, elsewhere on the "laptop". A REAL clone, not a bare
    // directory with the right name: since #659 a same-named directory has to
    // prove it is a checkout of this repo, and its `.git/config` is the proof.
    // Cloning for real also means the remote URL under test is one git wrote.
    laptopCheckout = path.join(t.tmp, "laptop", "code", "acme-api");
    await fs.mkdir(path.dirname(laptopCheckout), { recursive: true });
    await run("git", ["clone", "-q", src, laptopCheckout]);
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
        claudeHome,
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
    const destDir = path.join(claudeHome, "projects", encodePathForCli(project.workingDir));
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
      claudeHome,
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
      claudeHome,
      "projects",
      encodePathForCli(project.workingDir),
      "aaaaaaaa-1111-4111-8111-111111111111.jsonl",
    );
    expect(Math.abs((await fs.stat(copy)).mtime.getTime() - old.getTime())).toBeLessThan(2000);

    // A withheld session left NO trace in the project: no copy placed, and the
    // user's own file untouched where it always was.
    const destDir = path.join(claudeHome, "projects", encodePathForCli(project.workingDir));
    expect((await fs.readdir(destDir)).sort()).toEqual([
      "aaaaaaaa-1111-4111-8111-111111111111.jsonl",
      "bbbbbbbb-2222-4222-8222-222222222222.jsonl",
    ]);
    const junk = path.join(
      claudeHome,
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
    const dir = path.join(claudeHome, "projects", encodePathForCli(laptopCheckout));
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

  it("serves the ROOT workspace too, whose working dir is projectsRoot", async () => {
    await transcript(t.projectsRoot, "eeeeeeee-5555-4555-8555-555555555555");
    const body = await adoptable("/api/root");
    expect(body.count).toBe(1);
    expect(body.sources[0].sourceCwd).toBe(t.projectsRoot);

    const res = await t.app.inject({ method: "POST", url: "/api/root/adopt-chats", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().adopted).toEqual(["eeeeeeee-5555-4555-8555-555555555555"]);
    expect((await adoptable("/api/root")).count).toBe(0);
  });

  // --- choosing a subset, and undoing (#660) --------------------------------

  it("describes each candidate well enough for a dialog to show it", async () => {
    await transcript(laptopCheckout, "f1111111-6666-4666-8666-666666666661", {
      firstUserText: "port the billing job to the new queue",
    });
    const body = (await t.app.inject({
      method: "GET",
      url: "/api/projects/acme-api/adoptable-chats",
    })).json() as {
      sources: Array<{
        sourceCwd: string;
        sessionIds: string[];
        sessions: Array<{ sessionId: string; mtime: string; preview?: string; sizeBytes: number }>;
      }>;
    };
    const session = body.sources[0].sessions.find(
      (s) => s.sessionId === "f1111111-6666-4666-8666-666666666661",
    );
    expect(session?.preview).toContain("port the billing job");
    expect(session?.sizeBytes).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(session?.mtime ?? ""))).toBe(false);
    // The id-only projection stays in lockstep with the detailed one.
    expect(body.sources[0].sessionIds).toEqual(body.sources[0].sessions.map((s) => s.sessionId));
  });

  it("imports ONLY the chosen sessions, leaving the rest exactly as they were", async () => {
    await transcript(laptopCheckout, "f2222222-6666-4666-8666-666666666662");
    const chosen = "f1111111-6666-4666-8666-666666666661";
    const spurned = "f2222222-6666-4666-8666-666666666662";
    expect((await adoptable("/api/projects/acme-api")).count).toBe(2);

    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/acme-api/adopt-chats",
      payload: { sessionIds: [chosen] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().adopted).toEqual([chosen]);
    // A session the user did not tick is NOT reported as a skip — it was never
    // part of this import, and listing it would read as a half-failed one.
    expect(
      (res.json().skipped as Array<{ sessionId: string }>).map((s) => s.sessionId),
    ).not.toContain(spurned);

    const project = (await t.app.inject({ method: "GET", url: "/api/projects/acme-api" })).json()
      .project as { workingDir: string };
    const destDir = path.join(claudeHome, "projects", encodePathForCli(project.workingDir));
    const placed = await fs.readdir(destDir);
    expect(placed).toContain(`${chosen}.jsonl`);
    // The engine adopts a whole SOURCE, so the deselected one was adopted and
    // then released again — no copy may survive that round trip.
    expect(placed).not.toContain(`${spurned}.jsonl`);
    // …and it is still on offer, untouched.
    expect((await adoptable("/api/projects/acme-api")).count).toBe(1);
  });

  it("undoes the import: the chat goes away and the offer comes back", async () => {
    const chosen = "f1111111-6666-4666-8666-666666666661";
    const project = (await t.app.inject({ method: "GET", url: "/api/projects/acme-api" })).json()
      .project as { workingDir: string };
    const copy = path.join(
      claudeHome,
      "projects",
      encodePathForCli(project.workingDir),
      `${chosen}.jsonl`,
    );
    expect((await fs.stat(copy)).isFile()).toBe(true);

    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/acme-api/unadopt-chats",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().released).toEqual([chosen]);

    // The copy the import placed is gone…
    expect(await fs.stat(copy).catch(() => null)).toBeNull();
    // …the user's own transcript is NOT…
    const origin = path.join(
      claudeHome,
      "projects",
      encodePathForCli(laptopCheckout),
      `${chosen}.jsonl`,
    );
    expect((await fs.stat(origin)).isFile()).toBe(true);
    // …the chat no longer lists…
    const chats = (await t.app.inject({ method: "GET", url: "/api/projects/acme-api/chats" }))
      .json().chats as Array<{ sessionId: string }>;
    expect(chats.map((c) => c.sessionId)).not.toContain(chosen);
    // …and it is back on offer, which is the state that existed before.
    expect((await adoptable("/api/projects/acme-api")).count).toBe(2);
  });

  it("a second undo is a harmless no-op, not a repeat deletion", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/acme-api/unadopt-chats",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    // Nothing left to undo — reported as an empty release rather than an error.
    expect(res.json().released).toEqual([]);
    // The user's history is still all there.
    expect((await adoptable("/api/projects/acme-api")).count).toBe(2);
  });

  it("undo only ever touches the import it remembers", async () => {
    // Import one session, then ask to undo a DIFFERENT one that this process
    // never imported. Nothing should happen to either.
    const a = "f1111111-6666-4666-8666-666666666661";
    const b = "f2222222-6666-4666-8666-666666666662";
    await t.app.inject({
      method: "POST",
      url: "/api/projects/acme-api/adopt-chats",
      payload: { sessionIds: [a] },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects/acme-api/unadopt-chats",
      payload: { sessionIds: [b] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().released).toEqual([]);

    // `a` is still imported: an undo aimed at something else did not take it out.
    const chats = (await t.app.inject({ method: "GET", url: "/api/projects/acme-api/chats" }))
      .json().chats as Array<{ sessionId: string }>;
    expect(chats.map((c) => c.sessionId)).toContain(a);
  });
});
