import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { encodeProjectDir } from "../../src/transcripts.js";
import { resetMigrationProbeCache } from "../../src/transcripts-migration.js";

/**
 * The `own → host` migration preview over the REAL app (#882).
 *
 * The unit suite drives the classifier directly; this drives the two HTTP
 * endpoints, which is where the things a unit test cannot see live: the
 * response schemas (`additionalProperties: false` STRIPS anything undeclared,
 * so a field that exists in the DTO and not in the schema silently disappears
 * here), the root workspace's empty-string slug surviving a querystring, and
 * the refusals — an instance already on `host`, an env var shadowing the config
 * file, a host store that cannot be read.
 *
 * `startTestApp` gives each app a throwaway `HOME`, which is what makes it safe
 * to write "the user's own `~/.claude`" at all: on a real machine that path
 * holds the user's actual Claude Code history.
 */
describe("integration: own → host migration preview (#882)", () => {
  let t: TestApp;
  /** The user's own Claude home, under the throwaway HOME. */
  let userHome: string;

  const probe = async () =>
    (await t.app.inject({ method: "GET", url: "/api/transcripts/migration" })).json();

  const plan = async (query = "") =>
    (await t.app.inject({ method: "GET", url: `/api/transcripts/migration/chats${query}` })).json();

  /** An append-only, uuid-chained transcript. */
  function lines(sessionId: string, count: number, tag = "a"): string[] {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
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

  /** Where the user's own Claude Code would keep this working dir's chats. */
  const hostStoreFor = (workingDir: string) =>
    path.join(userHome, "projects", encodeProjectDir(workingDir));

  beforeAll(async () => {
    t = await startTestApp();
    userHome = path.join(t.home, ".claude");

    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Acme" } });
    const acmeDir = path.join(t.projectsRoot, "acme");

    // A net-new Paddock chat…
    await write(path.join(acmeDir, ".chats", "new-1.jsonl"), lines("new-1", 6));
    // …a chat the user also has, which Paddock has since added to…
    const ff = lines("ff-1", 10);
    await write(path.join(acmeDir, ".chats", "ff-1.jsonl"), ff);
    await write(path.join(hostStoreFor(acmeDir), "ff-1.jsonl"), ff.slice(0, 4));
    // …one both sides advanced independently…
    const shared = lines("div-1", 4);
    await write(path.join(acmeDir, ".chats", "div-1.jsonl"), [
      ...shared,
      ...lines("div-1", 2, "own"),
    ]);
    await write(path.join(hostStoreFor(acmeDir), "div-1.jsonl"), [
      ...shared,
      ...lines("div-1", 5, "host"),
    ]);
    // …and one that is the same file on both sides.
    const same = lines("same-1", 5);
    await write(path.join(acmeDir, ".chats", "same-1.jsonl"), same);
    await write(path.join(hostStoreFor(acmeDir), "same-1.jsonl"), same);
    const when = new Date("2026-03-03T03:03:03Z");
    await fs.utimes(path.join(acmeDir, ".chats", "same-1.jsonl"), when, when);
    await fs.utimes(path.join(hostStoreFor(acmeDir), "same-1.jsonl"), when, when);

    // Sidecars and project-level artifacts, on the shapes a live instance has.
    await write(
      path.join(acmeDir, ".chats", "new-1", "subagents", "agent-99.jsonl"),
      lines("sub", 2),
    );
    await fs.mkdir(path.join(acmeDir, ".chats", "new-1", "tool-results"), { recursive: true });
    await fs.writeFile(
      path.join(acmeDir, ".chats", "new-1", "tool-results", "r.json"),
      "{}",
      "utf8",
    );
    await write(path.join(acmeDir, ".chats", ".reverts", "new-1-1738000000000.jsonl"), ["{}"]);
    await fs.mkdir(path.join(acmeDir, ".chats", "memory"), { recursive: true });
    await fs.writeFile(
      path.join(acmeDir, ".chats", "memory", "MEMORY.md"),
      "# paddock's index\n",
      "utf8",
    );
    // The collision §10.2 is about: the user already has one of these.
    await fs.mkdir(path.join(hostStoreFor(acmeDir), "memory"), { recursive: true });
    await fs.writeFile(
      path.join(hostStoreFor(acmeDir), "memory", "MEMORY.md"),
      "# the user's own index\n",
      "utf8",
    );

    // The ROOT workspace, whose slug is the empty string — and whose directory
    // is `projectsRoot` ITSELF (`path.join(root, "") === root`), not a `_root`
    // subdirectory. `_root` is only the herdctl AGENT-name encoding.
    await write(path.join(t.projectsRoot, ".chats", "root-1.jsonl"), lines("root-1", 4));
  });

  afterAll(async () => {
    await t.teardown();
  });

  beforeEach(() => {
    resetMigrationProbeCache();
    delete process.env.PADDOCK_CLAUDE_TRANSCRIPTS;
  });

  it("offers the migration, and answers the probe without reading a transcript", async () => {
    const body = await probe();
    expect(body).toMatchObject({ mode: "own", eligible: true });
    expect(body.reason).toBeUndefined();
    expect(body.pendingProjects).toBeGreaterThanOrEqual(2); // acme + the root workspace
    expect(body.pendingChats).toBeGreaterThanOrEqual(5);
    expect(typeof body.computedAt).toBe("string");
    // additionalProperties: false — the published contract IS the field list.
    expect(Object.keys(body).sort()).toEqual([
      "computedAt",
      "eligible",
      "mode",
      "pendingChats",
      "pendingProjects",
      "scannedProjects",
    ]);
  });

  it("classifies every chat, and names what moves with it", async () => {
    const body = await plan();
    const acme = body.projects.find((p: { slug: string }) => p.slug === "acme");
    expect(acme).toBeDefined();

    const rows = new Map<string, Record<string, unknown>>(
      acme.chats.map((c: { sessionId: string }) => [c.sessionId, c]),
    );
    expect(rows.get("new-1")).toMatchObject({ state: "new", defaultSelected: true });
    expect(rows.get("ff-1")).toMatchObject({
      state: "fast-forward",
      defaultSelected: true,
      ahead: "own",
    });
    expect(rows.get("div-1")).toMatchObject({ state: "diverged", defaultSelected: false });
    // Identical: no row, but accounted for.
    expect(rows.has("same-1")).toBe(false);
    expect(body.totals.identical).toBeGreaterThanOrEqual(1);

    // The diverged row carries what the choice needs.
    const div = rows.get("div-1") as { own: { messageCount: number }; host: { messageCount: number } };
    expect(div.own.messageCount).toBe(6);
    expect(div.host.messageCount).toBe(9);

    // Sidecars ride with their chat; the shared `.reverts/` is split by prefix.
    const newRow = rows.get("new-1") as { extras: string[] };
    expect(newRow.extras.some((e) => e.endsWith(path.join("new-1", "subagents")))).toBe(true);
    expect(newRow.extras.some((e) => e.endsWith(path.join("new-1", "tool-results")))).toBe(true);
    expect(newRow.extras.some((e) => e.includes("new-1-1738000000000.jsonl"))).toBe(true);

    // Agent memory moves with the PROJECT, and the collision is surfaced rather
    // than silently overwriting a file in the user's own home.
    expect(acme.projectExtras.some((e: string) => e.endsWith(path.join(".chats", "memory")))).toBe(
      true,
    );
    const collision = body.warnings.find(
      (w: { code: string }) => w.code === "memory-collision",
    );
    expect(collision).toBeDefined();
    expect(collision.slug).toBe("acme");

    // The preserve dir is a SIBLING of `.chats/` (§5.1) — a child would leave
    // `.chats/` non-empty and the redirect symlink would never be planted.
    expect(acme.preserveDir).toBe(path.join(t.projectsRoot, "acme", ".chats-pre-migration"));

    expect(body.configPath).toContain("paddock.config.yaml");
    expect(body.scanBudgetExhausted).toBe(false);
  });

  it("includes the ROOT workspace, and `?slug=` selects it rather than meaning 'all'", async () => {
    const all = await plan();
    expect(all.projects.some((p: { slug: string }) => p.slug === "")).toBe(true);

    // The empty string is falsy: `if (!slug)` here reads as "no filter given"
    // and silently returns every project instead of the one that was asked for.
    const root = await plan("?slug=");
    expect(root.projects.map((p: { slug: string }) => p.slug)).toEqual([""]);
    expect(root.projects[0].chats.map((c: { sessionId: string }) => c.sessionId)).toEqual([
      "root-1",
    ]);

    const acme = await plan("?slug=acme");
    expect(acme.projects.map((p: { slug: string }) => p.slug)).toEqual(["acme"]);
  });

  it("refuses with env-shadowed when PADDOCK_CLAUDE_TRANSCRIPTS is set", async () => {
    process.env.PADDOCK_CLAUDE_TRANSCRIPTS = "own";
    const body = await probe();
    expect(body).toMatchObject({
      eligible: false,
      reason: "env-shadowed",
      envVar: "PADDOCK_CLAUDE_TRANSCRIPTS",
    });
    // The plan still renders — the user can see what WOULD move — but it says
    // out loud that the config write would be inert.
    const p = await plan();
    expect(p.warnings.some((w: { code: string }) => w.code === "env-shadowed")).toBe(true);
  });

  it("reports unknown, not new, when the host store cannot be read", async () => {
    // A file where the store should be. Every chat looks absent from the host
    // store, and calling them all `new` would default them all to CHECKED on
    // the strength of a read that failed.
    const dir = path.join(t.projectsRoot, "acme");
    const store = hostStoreFor(dir);
    const stash = `${store}.stash`;
    await fs.rename(store, stash);
    await fs.writeFile(store, "not a directory\n", "utf8");
    try {
      const body = await plan("?slug=acme");
      const acme = body.projects[0];
      expect(acme.chats.every((c: { state: string }) => c.state === "unknown")).toBe(true);
      expect(acme.chats.every((c: { defaultSelected: boolean }) => !c.defaultSelected)).toBe(true);
      expect(
        body.warnings.some((w: { code: string }) => w.code === "host-store-unreadable"),
      ).toBe(true);
    } finally {
      await fs.rm(store, { force: true });
      await fs.rename(stash, store);
    }
  });
});

/**
 * An instance that has already flipped. Separate app because
 * `claude.transcripts` is frozen at boot (`app.ts:128`) — which is also why the
 * migration ends in a restart.
 */
describe("integration: migration preview on an instance already using host transcripts", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ configFile: { claude: { transcripts: "host" } } });
    resetMigrationProbeCache();
  });

  afterAll(async () => {
    await t.teardown();
  });

  it("reports already-host and offers nothing", async () => {
    const body = (
      await t.app.inject({ method: "GET", url: "/api/transcripts/migration" })
    ).json();
    expect(body).toMatchObject({ mode: "host", eligible: false, reason: "already-host" });
    expect(body.pendingChats).toBe(0);

    const p = (
      await t.app.inject({ method: "GET", url: "/api/transcripts/migration/chats" })
    ).json();
    expect(p.mode).toBe("host");
    // `.chats/` is a symlink at the host store under this mode, so there is
    // nothing to move and no rows to show.
    expect(p.projects).toEqual([]);
    expect(p.totals.chats).toBe(0);
  });

  it("still reports chats stranded in `.chats/` — the #708 state the probe cannot offer", async () => {
    // The state #708 documents, reached by flipping to `host` while `.chats/`
    // was non-empty: `pointChatsDirAt` declines the redirect (it will not
    // delete a store), so the old transcripts stay in a real `.chats/` where
    // nothing in the running server can see them.
    //
    // The two endpoints DISAGREE here, and deliberately so pending a design
    // ruling: the probe refuses with `already-host` (the design treats `host`
    // as "already migrated"), while the plan reports what is genuinely still
    // sitting there. The migration is in fact still this instance's fix —
    // minus the config write, which has already happened. Called out in the PR
    // rather than resolved here, because widening `already-host` is a change to
    // the design's contract and not the read half's to make.
    const dir = path.join(t.projectsRoot, "stranded");
    await fs.mkdir(path.join(dir, ".chats"), { recursive: true });
    await fs.writeFile(path.join(dir, ".chats", "left-behind.jsonl"), "{}\n", "utf8");
    await fs.writeFile(
      path.join(dir, "project.yaml"),
      "name: Stranded\nstatus: active\n",
      "utf8",
    );

    const probe = (
      await t.app.inject({ method: "GET", url: "/api/transcripts/migration" })
    ).json();
    expect(probe).toMatchObject({ eligible: false, reason: "already-host" });

    const plan = (
      await t.app.inject({ method: "GET", url: "/api/transcripts/migration/chats?slug=stranded" })
    ).json();
    expect(plan.projects[0]?.chats.map((c: { sessionId: string }) => c.sessionId)).toEqual([
      "left-behind",
    ]);
  });
});
