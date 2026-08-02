/**
 * The Home tab's attention feed — `GET <workspace>/chats/attention` (#599).
 *
 * The route is a workspace-scoped one, so it is mounted TWICE (see
 * `workspace-mount.ts`) and the whole point of its design is that ONE handler
 * serves both mounts: the root's key is `""`, whose subtree prefix is `""`, so
 * the root sweeps the WHOLE FLEET while a project sweeps only itself — with no
 * branch on the key beyond the single explicit `=== ROOT_KEY` that picks the
 * prefix. Two things follow that are worth pinning hard:
 *
 *   1. a falsy guard anywhere on that path (`if (!slug)`, `slug ? … : …`)
 *      silently DROPS the root's own chats from its own feed, and
 *   2. root and project must return byte-identical rows for the same chat,
 *      because they are literally the same code.
 *
 * These are unit tests rather than integration ones because the `running` half
 * is read from the live session hub — in-memory state a real fake-CLI turn can
 * only produce for the few hundred milliseconds it is mid-flight. Mounting the
 * REAL route plugin over a stubbed dep bag (the `management-ops-parent.test.ts`
 * "cast rather than fully built" convention) lets every classification input —
 * hub, archive flag, read watermark, manual override — be set exactly.
 * `home-attention.test.ts` covers the same route over the real app.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import type { DiscoveredSession } from "@herdctl/core";
import { ProjectStore, ROOT_KEY, type Project } from "../../src/projects.js";
import { keeperAgentName } from "../../src/herdctl.js";
import { ArchiveStore } from "../../src/archive.js";
import { StarStore } from "../../src/star.js";
import { ReadStateStore } from "../../src/read-state.js";
import { UnreadStore } from "../../src/unread.js";
import { ParentDetachStore } from "../../src/parent-detach.js";
import { RunProvenanceStore } from "../../src/run-provenance.js";
import { MessageProvenanceStore } from "../../src/message-provenance.js";
import { buildRouteContext, type RouteDeps } from "../../src/route-context.js";
import { registerChatWorkspaceRoutes } from "../../src/routes/chats.js";
import { mountWorkspaceRoutes } from "../../src/routes/workspace-mount.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/** The fixture clock. Everything is expressed relative to this instant. */
const T = Date.parse("2026-07-01T12:00:00.000Z");
const TURN_AT = new Date(T).toISOString();
/** A watermark AFTER the last turn ⇒ the chat has been read. */
const SEEN_AFTER = T + 60_000;

interface AttentionRow {
  sessionId: string;
  name: string;
  projectSlug: string;
  projectName: string;
  archived: boolean;
  starred: boolean;
  updatedAt: string;
  lastTurnCompletedAt?: string;
  lastSeen?: number;
  unread?: boolean;
}
interface Attention {
  running: AttentionRow[];
  unread: AttentionRow[];
}

/** A discovered session, minus the fields the attention feed never reads. */
function session(sessionId: string, agentName: string): DiscoveredSession {
  return {
    sessionId,
    workingDirectory: "/does-not-matter",
    mtime: TURN_AT,
    origin: "web" as DiscoveredSession["origin"],
    agentName,
    resumable: true,
    customName: sessionId,
    autoName: undefined,
    preview: undefined,
  };
}

let tmp: string;
let projectsRoot: string;
let dataDir: string;
let projects: ProjectStore;
let root: Project;
/** Session ids the (stubbed) hub reports as mid-turn. Mutable per test. */
let running: Set<string>;
/** Per-workspace-key session lists the stubbed herdctl hands back. */
let sessionsBySlug: Map<string, DiscoveredSession[]>;
/** The job-record derived "last turn finished at" index. */
let lastTurnAt: Map<string, string>;

/** The sidecar stores — ONE instance each, shared by both apps and the fixture. */
let archive: ArchiveStore;
let readState: ReadStateStore;
let unreadStore: UnreadStore;

let app: FastifyInstance;
/** A second app built with NO managementOpsContext (the degraded server). */
let hubless: FastifyInstance;

/** Build one app over the shared fixture, optionally without the ops context. */
async function buildRoutes(opts: { withOps: boolean }): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  const deps = {
    projects,
    herdctl: {
      listSessions: async (p: Project) => sessionsBySlug.get(p.slug) ?? [],
      lastTurnCompletedAt: async () => lastTurnAt,
    },
    archive,
    star: new StarStore(dataDir),
    readState,
    unread: unreadStore,
    parentDetach: new ParentDetachStore(dataDir),
    runProvenance: new RunProvenanceStore(dataDir),
    messageProvenance: new MessageProvenanceStore(dataDir),
    attachments: {},
    cfg: {},
    ...(opts.withOps
      ? { managementOpsContext: { hub: { isRunning: (id: string) => running.has(id) } } }
      : {}),
  } as unknown as RouteDeps;
  const ctx = buildRouteContext(deps);
  await mountWorkspaceRoutes(instance, (scoped) => registerChatWorkspaceRoutes(scoped, ctx));
  await instance.ready();
  return instance;
}

async function attention(instance: FastifyInstance, url: string): Promise<Attention> {
  const res = await instance.inject({ method: "GET", url });
  expect(res.statusCode, url).toBe(200);
  return res.json() as Attention;
}

const ids = (rows: AttentionRow[]) => rows.map((r) => r.sessionId).sort();

describe("GET <workspace>/chats/attention (#599)", () => {
  beforeAll(async () => {
    tmp = await makeTmpDir("paddock-attention-");
    projectsRoot = path.join(tmp, "projects");
    dataDir = path.join(tmp, "data");
    await fs.mkdir(dataDir, { recursive: true });
    projects = new ProjectStore(projectsRoot);
    await projects.init();
    await projects.create({ name: "Alpha" });
    await projects.create({ name: "Beta" });
    root = await projects.get(ROOT_KEY);

    const rootKeeper = keeperAgentName(ROOT_KEY);
    const alphaKeeper = keeperAgentName("alpha");
    const betaKeeper = keeperAgentName("beta");

    sessionsBySlug = new Map([
      [
        ROOT_KEY,
        ["root-unread", "root-running", "root-read"].map((id) => session(id, rootKeeper)),
      ],
      [
        "alpha",
        [
          "alpha-unread",
          "alpha-manual",
          "alpha-quiet",
          "alpha-noturn",
          "alpha-running",
          "alpha-arch-unread",
          "alpha-arch-running",
        ].map((id) => session(id, alphaKeeper)),
      ],
      ["beta", [session("beta-unread", betaKeeper)]],
    ]);

    // Every chat has a completed turn EXCEPT `alpha-noturn` — a brand-new chat
    // with no job record yet, which must land in neither list.
    lastTurnAt = new Map(
      [...sessionsBySlug.values()]
        .flat()
        .map((s) => s.sessionId)
        .filter((id) => id !== "alpha-noturn")
        .map((id) => [id, TURN_AT] as const),
    );

    // Read watermarks: `*-read`/`*-quiet` were seen AFTER their last turn, and so
    // was `alpha-manual` (whose unread cue can then only come from the override).
    readState = new ReadStateStore(dataDir);
    await readState.setLastSeen(null, rootKeeper, "root-read", SEEN_AFTER);
    await readState.setLastSeen(null, alphaKeeper, "alpha-quiet", SEEN_AFTER);
    await readState.setLastSeen(null, alphaKeeper, "alpha-manual", SEEN_AFTER);

    // #458 manual override — set on an otherwise-read chat.
    unreadStore = new UnreadStore(dataDir);
    await unreadStore.setUnread(null, alphaKeeper, "alpha-manual", true);

    archive = new ArchiveStore(dataDir);
    await archive.setArchived(alphaKeeper, "alpha-arch-unread", true);
    await archive.setArchived(alphaKeeper, "alpha-arch-running", true);

    app = await buildRoutes({ withOps: true });
    hubless = await buildRoutes({ withOps: false });
  });

  afterAll(async () => {
    await app?.close();
    await hubless?.close();
    await rmTmpDir(tmp);
  });

  beforeEach(() => {
    running = new Set(["root-running", "alpha-running", "alpha-arch-running"]);
  });

  // ── the root sweeps the whole fleet, INCLUDING its own chats ───────────────

  it("returns the WHOLE FLEET on the root mount, root's own chats included", async () => {
    const { running: run, unread } = await attention(app, "/api/root/chats/attention");

    // Rows from three different workspaces — the root, and both projects.
    expect(ids(unread)).toEqual([
      "alpha-manual",
      "alpha-unread",
      "beta-unread",
      "root-unread",
    ]);
    expect(ids(run)).toEqual(["alpha-arch-running", "alpha-running", "root-running"]);
  });

  it("attributes every row to the workspace it came from, the ROOT by its empty key", async () => {
    const { running: run, unread } = await attention(app, "/api/root/chats/attention");
    const bySession = new Map([...run, ...unread].map((r) => [r.sessionId, r]));

    // THE load-bearing assertion of the whole route. The root's key is `""`, so
    // any falsy guard on the subtree/attribution path drops these two rows
    // without a trace. Asserted by VALUE — `toBeFalsy()` would pass on a bug.
    expect(bySession.get("root-unread")).toBeDefined();
    expect(bySession.get("root-running")).toBeDefined();
    expect(bySession.get("root-unread")!.projectSlug).toBe("");
    expect(bySession.get("root-running")!.projectSlug).toBe("");
    expect(bySession.get("root-unread")!.projectName).toBe(root.name);
    expect(bySession.get("root-unread")!.projectName).not.toBe("");

    expect(bySession.get("alpha-unread")!.projectSlug).toBe("alpha");
    expect(bySession.get("alpha-unread")!.projectName).toBe("Alpha");
    expect(bySession.get("beta-unread")!.projectSlug).toBe("beta");
    expect(bySession.get("beta-unread")!.projectName).toBe("Beta");
  });

  it("carries a FULL chat DTO on each row, not just an id", async () => {
    const { unread } = await attention(app, "/api/root/chats/attention");
    const row = unread.find((r) => r.sessionId === "alpha-unread")!;
    expect(row).toMatchObject({
      sessionId: "alpha-unread",
      name: "alpha-unread", // the DiscoveredSession's customName
      updatedAt: TURN_AT,
      lastTurnCompletedAt: TURN_AT,
      archived: false,
      starred: false,
    });
  });

  // ── a project sweeps only itself ──────────────────────────────────────────

  it("scopes a PROJECT mount to that project alone", async () => {
    const { running: run, unread } = await attention(app, "/api/projects/alpha/chats/attention");
    expect(ids(unread)).toEqual(["alpha-manual", "alpha-unread"]);
    expect(ids(run)).toEqual(["alpha-arch-running", "alpha-running"]);

    // Neither the sibling project's chats nor the root's leak in.
    for (const row of [...run, ...unread]) expect(row.projectSlug).toBe("alpha");

    const beta = await attention(app, "/api/projects/beta/chats/attention");
    expect(ids(beta.unread)).toEqual(["beta-unread"]);
    expect(beta.running).toEqual([]);
  });

  it("is the SAME handler at both mounts — identical shape and identical rows", async () => {
    const viaRoot = await attention(app, "/api/root/chats/attention");
    const viaProject = await attention(app, "/api/projects/alpha/chats/attention");

    expect(Object.keys(viaRoot).sort()).toEqual(["running", "unread"]);
    expect(Object.keys(viaProject).sort()).toEqual(["running", "unread"]);

    // Alpha's rows are byte-identical whichever mount produced them.
    const alphaOf = (a: Attention) =>
      [...a.running, ...a.unread]
        .filter((r) => r.projectSlug === "alpha")
        .sort((x, y) => x.sessionId.localeCompare(y.sessionId));
    expect(alphaOf(viaRoot)).toEqual(alphaOf(viaProject));
    expect(alphaOf(viaRoot).length).toBeGreaterThan(0);
  });

  // ── running comes from the hub, and beats unread ──────────────────────────

  it("takes `running` from the live hub, not from timestamps", async () => {
    // `alpha-running` and `alpha-unread` are IDENTICAL on disk — same last turn,
    // same (absent) watermark. Only the hub separates them…
    const before = await attention(app, "/api/projects/alpha/chats/attention");
    expect(ids(before.running)).toContain("alpha-running");
    expect(ids(before.unread)).not.toContain("alpha-running");

    // …so when the hub goes quiet, the very same chat reclassifies as unread.
    running.clear();
    const after = await attention(app, "/api/projects/alpha/chats/attention");
    expect(after.running).toEqual([]);
    expect(ids(after.unread)).toEqual(["alpha-manual", "alpha-running", "alpha-unread"]);
  });

  it("puts a chat in ONE list only — running wins over unread", async () => {
    const { running: run, unread } = await attention(app, "/api/root/chats/attention");
    const runIds = new Set(ids(run));
    for (const row of unread) expect(runIds.has(row.sessionId)).toBe(false);
    // `root-running` would otherwise qualify as unread (turn newer than its
    // absent watermark), so this is a genuine overlap, not a vacuous check.
    expect(runIds.has("root-running")).toBe(true);
    expect(lastTurnAt.get("root-running")).toBe(TURN_AT);
  });

  // ── unread classification ─────────────────────────────────────────────────

  it("counts a chat unread when its last turn is NEWER than the watermark", async () => {
    const { unread } = await attention(app, "/api/projects/alpha/chats/attention");
    const row = unread.find((r) => r.sessionId === "alpha-unread")!;
    expect(row.lastTurnCompletedAt).toBe(TURN_AT);
    expect(row.lastSeen).toBeUndefined(); // never seen ⇒ 0
  });

  it("honors the MANUAL unread override on an already-read chat (#458)", async () => {
    const { unread } = await attention(app, "/api/projects/alpha/chats/attention");
    const row = unread.find((r) => r.sessionId === "alpha-manual")!;
    // Read after its last turn — the derived signal says "read"; only the
    // override puts it here.
    expect(row.lastSeen).toBe(SEEN_AFTER);
    expect(Date.parse(row.lastTurnCompletedAt!)).toBeLessThan(row.lastSeen!);
    expect(row.unread).toBe(true);
  });

  it("omits a chat whose last turn is OLDER than the watermark, from BOTH lists", async () => {
    const { running: run, unread } = await attention(app, "/api/root/chats/attention");
    const all = new Set(ids([...run, ...unread]));
    expect(all.has("alpha-quiet")).toBe(false);
    expect(all.has("root-read")).toBe(false);
    // …and so is a chat with no completed turn at all (a brand-new chat).
    expect(all.has("alpha-noturn")).toBe(false);
  });

  // ── archived ──────────────────────────────────────────────────────────────

  it("excludes an ARCHIVED chat from unread, but still lists a RUNNING archived one", async () => {
    const { running: run, unread } = await attention(app, "/api/projects/alpha/chats/attention");
    // Archiving is how you silence a chat: it stays out of the unread feed even
    // though its last turn is newer than its (absent) watermark.
    expect(ids(unread)).not.toContain("alpha-arch-unread");
    // Live work shows regardless of where it is filed.
    const archivedRun = run.find((r) => r.sessionId === "alpha-arch-running")!;
    expect(archivedRun).toBeDefined();
    expect(archivedRun.archived).toBe(true);

    // Stop the turn and the archived chat vanishes entirely — the exclusion is
    // about the UNREAD half only.
    running.clear();
    const after = await attention(app, "/api/projects/alpha/chats/attention");
    expect(ids([...after.running, ...after.unread])).not.toContain("alpha-arch-running");
  });

  // ── degradation + errors ──────────────────────────────────────────────────

  it("degrades to the unread half (200, nothing running) with NO managementOpsContext", async () => {
    const { running: run, unread } = await attention(hubless, "/api/root/chats/attention");
    expect(run).toEqual([]);
    // The unread half is untouched, and the chats the hub WOULD have claimed as
    // running fall through to it (they qualify on timestamps).
    expect(ids(unread)).toEqual([
      "alpha-manual",
      "alpha-running",
      "alpha-unread",
      "beta-unread",
      "root-running",
      "root-unread",
    ]);

    // The project mount degrades the same way.
    const alpha = await attention(hubless, "/api/projects/alpha/chats/attention");
    expect(alpha.running).toEqual([]);
    expect(ids(alpha.unread)).toEqual(["alpha-manual", "alpha-running", "alpha-unread"]);
  });

  it("404s an unknown project slug, the way every sibling chat route does", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/ghost/chats/attention" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "not_found" });
  });

  it("never 404s the ROOT mount — the root workspace always resolves", async () => {
    const res = await app.inject({ method: "GET", url: "/api/root/chats/attention" });
    expect(res.statusCode).toBe(200);
  });

  it("is a STATIC route, not swallowed by /chats/:sessionId", async () => {
    // `attention` is a legal session-id-shaped path segment, so if find-my-way
    // ever preferred the parametric sibling this would come back as a chat
    // payload (or a 500) instead of the feed.
    const body = await attention(app, "/api/projects/alpha/chats/attention");
    expect(Array.isArray(body.running)).toBe(true);
    expect(Array.isArray(body.unread)).toBe(true);
  });
});
