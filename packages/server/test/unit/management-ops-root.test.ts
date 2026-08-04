/**
 * #560 — the READ ops enumerate and address the ROOT workspace.
 *
 * `ProjectStore.list()` returns the root's CHILDREN only, and that exclusion is
 * deliberate (pinned in root-workspace.test.ts). So the ops layer has to reach the
 * root the way REST does — explicitly, by key — rather than by widening
 * enumeration. Two things regressed here and are pinned below:
 *
 *   - `listChats("")` collapsed to `list()` under a truthiness test, so an
 *     explicitly-named target silently got EVERY project's chats;
 *   - nothing on the surface told a caller the root existed at all.
 *
 * Stubs the store rather than booting a fleet: what is under test is which
 * workspaces the ops ask about, which is exactly what a recording stub shows.
 */
import { describe, it, expect } from "vitest";
import { buildManagementOps } from "../../src/management-ops.js";
import { HUMAN_ROOT } from "../../src/run-provenance.js";
import type { ChatHandlerContext } from "../../src/ws-context.js";

const ROOT = { slug: "", name: "projects", dir: "/p", workingDir: "/p", status: "active" };
const ALPHA = { slug: "alpha", name: "Alpha", dir: "/p/alpha", workingDir: "/p/alpha", status: "active", group: "homelab" };

/**
 * A store holding the root workspace + one project, wired the way the real one
 * is: `list()` yields CHILDREN only, and `get("")` resolves the root (the root
 * always exists, record or not).
 */
function ctxWithRoot() {
  const gets: string[] = [];
  const sessionsFor: Record<string, string[]> = { "": ["root-chat"], alpha: ["alpha-chat"] };
  const ctx = {
    deps: {
      projects: {
        list: async () => [ALPHA],
        get: async (key: string) => {
          gets.push(key);
          if (key === "") return ROOT;
          if (key === "alpha") return ALPHA;
          throw new Error(`Project not found: ${key}`);
        },
      },
      herdctl: {
        listSessions: async (p: { slug: string }) =>
          (sessionsFor[p.slug] ?? []).map((sessionId) => ({
            sessionId,
            customName: sessionId,
            autoName: null,
            mtime: "2026-07-29T00:00:00Z",
          })),
        sessionMessages: async (agent: string, sessionId: string) => [
          { role: "assistant", content: `${agent}/${sessionId}`, timestamp: "t" },
        ],
      },
      archive: { isArchived: async () => false },
      cfg: { keeperDriveMode: "session", maxSpawnDepth: 1 },
    },
    hub: { isRunning: () => false },
    startAgentTurn: async () => "unused",
    composePreloadedPrompt: async (_s: string, m: string) => m,
    fireTrigger: async () => null,
  } as unknown as ChatHandlerContext;
  return { ctx, gets };
}

const params = {
  currentProjectSlug: "alpha",
  currentSessionId: () => null,
  parentProvenance: HUMAN_ROOT,
  includeWrite: false,
  includeTriggers: false,
  includeProjects: false,
};

describe("#560: read ops reach the root workspace", () => {
  it('listChats("") lists the ROOT\'s chats only', async () => {
    const { ctx, gets } = ctxWithRoot();
    const chats = await buildManagementOps(ctx, params).read.listChats("");
    expect(chats.map((c) => c.sessionId)).toEqual(["root-chat"]);
    expect(chats[0].project).toBe("");
    // The empty key was ADDRESSED, not treated as "nothing was passed".
    expect(gets).toEqual([""]);
  });

  it("listChats(undefined) covers the root as well as every project", async () => {
    const { ctx } = ctxWithRoot();
    const chats = await buildManagementOps(ctx, params).read.listChats(undefined);
    expect(chats.map((c) => c.sessionId)).toEqual(["root-chat", "alpha-chat"]);
  });

  it("listProjects carries the root so the handler (and policy filter) can see it", async () => {
    const { ctx } = ctxWithRoot();
    const projects = await buildManagementOps(ctx, params).read.listProjects();
    // Root FIRST, then children — and as an ordinary member, which is what makes
    // `isProjectAllowed(scope, "")` in the policy wrapper cover it for free.
    expect(projects.map((p) => p.slug)).toEqual(["", "alpha"]);
    expect(projects[0].name).toBe("projects");
    expect(projects[1].area).toBe("homelab");
  });

  it("tolerates an unreadable root rather than failing the whole enumeration", async () => {
    const { ctx } = ctxWithRoot();
    // The root always exists on disk, but its record may not parse; a listing that
    // 500s on that is strictly worse than one missing the root.
    (ctx.deps.projects as unknown as { get: (k: string) => Promise<unknown> }).get = async (k) => {
      if (k === "") throw new Error("unparseable project.yaml");
      return ALPHA;
    };
    const ops = buildManagementOps(ctx, params);
    expect((await ops.read.listProjects()).map((p) => p.slug)).toEqual(["alpha"]);
    expect((await ops.read.listChats(undefined)).map((c) => c.sessionId)).toEqual(["alpha-chat"]);
  });

  it("readChat resolves the root's keeper agent (keeper-_root, the one sentinel)", async () => {
    const { ctx } = ctxWithRoot();
    const messages = await buildManagementOps(ctx, params).read.readChat("", "root-chat");
    // The empty key cannot be a herdctl agent name, so it is encoded at exactly
    // that boundary — and nowhere else.
    expect(messages[0].text).toBe("keeper-_root/root-chat");
  });
});
