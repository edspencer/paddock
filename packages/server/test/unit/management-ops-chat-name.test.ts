/**
 * #614 — `list_chats` must name a chat the way the web UI names it.
 *
 * The MCP projection used `customName ?? autoName ?? sessionId.slice(0, 8)`,
 * omitting the `preview` step the REST DTO has (`chat-dto.ts`). Claude writes
 * `ai-title` records rather than the `summary` records `autoName` is derived
 * from, so `autoName` is almost never set in practice and the chain fell
 * straight through to the slice: 39 of 96 chats (41%) on the live instance came
 * back named after their own sessionId.
 *
 * That is worse than ugly. The stub LOOKS like an id, and feeding it back to
 * `read_chat` returns a successful empty result rather than an error, so a
 * caller can conclude "empty chat" about a conversation it never opened.
 */
import { describe, it, expect } from "vitest";
import { buildManagementOps } from "../../src/management-ops.js";
import { wrapPreload } from "../../src/preload.js";
import type { ChatHandlerContext } from "../../src/ws-context.js";

type StubSession = {
  sessionId: string;
  customName?: string | null;
  autoName?: string | null;
  preview?: string;
  mtime?: string;
};

/** A context stubbed down to just what `listChats` touches. */
function ctxWith(sessions: StubSession[]) {
  const project = { slug: "alpha", name: "Alpha", dir: "/p/alpha", workingDir: "/p/alpha" };
  return {
    deps: {
      projects: { get: async () => project, list: async () => [project] },
      herdctl: { listSessions: async () => sessions },
      archive: { isArchived: async () => false },
    },
    hub: { isRunning: () => false },
  } as unknown as ChatHandlerContext;
}

const listChats = async (sessions: StubSession[]) => {
  const ops = buildManagementOps(ctxWith(sessions), {
    currentProjectSlug: "alpha",
    currentSessionId: () => null,
    includeWrite: false,
    includeTriggers: false,
    includeProjects: false,
  } as Parameters<typeof buildManagementOps>[1]);
  return ops.read.listChats(undefined);
};

describe("#614: list_chats names chats the way the UI does", () => {
  it("prefers a user-set customName", async () => {
    const [chat] = await listChats([
      { sessionId: "aaaaaaaa-1111-2222-3333-444444444444", customName: "Manager", preview: "hi" },
    ]);
    expect(chat.name).toBe("Manager");
  });

  it("falls back to autoName before the preview", async () => {
    const [chat] = await listChats([
      {
        sessionId: "bbbbbbbb-1111-2222-3333-444444444444",
        autoName: "Fix the flaky suite",
        preview: "some first message",
      },
    ]);
    expect(chat.name).toBe("Fix the flaky suite");
  });

  // The regression this issue is about: an untitled chat used to become an
  // 8-hex stub even though its first message was right there.
  it("uses the preview when there is no stored title, NOT a sessionId slice", async () => {
    const [chat] = await listChats([
      {
        sessionId: "cccccccc-1111-2222-3333-444444444444",
        preview: "Audit the Night-Watch run against the JSONL",
      },
    ]);
    expect(chat.name).toBe("Audit the Night-Watch run against the JSONL");
    expect(chat.name).not.toBe("cccccccc");
  });

  it("still slices the sessionId when there is genuinely nothing to show", async () => {
    const [chat] = await listChats([{ sessionId: "dddddddd-1111-2222-3333-444444444444" }]);
    expect(chat.name).toBe("dddddddd");
  });

  // A preload-wrapped first message would otherwise name the chat after the
  // injected OVERVIEW/CHANGELOG block (#62). Both surfaces run the same
  // recovery, so the name is the user's actual request.
  it("recovers the real request from a preload-wrapped preview", async () => {
    const [chat] = await listChats([
      {
        sessionId: "eeeeeeee-1111-2222-3333-444444444444",
        preview: wrapPreload("# OVERVIEW\n\nproject state", "please bump the deps"),
      },
    ]);
    expect(chat.name).toBe("please bump the deps");
  });

  // Parity check, warts included: when the wrapper is truncated before the
  // `My request:` marker and the untruncated message can't be read from disk,
  // there is nothing to recover and `chat-dto` also falls through to the raw
  // preview. Matching that is the point of #614 — the two surfaces must not
  // disagree — so this pins the shared behaviour rather than quietly diverging.
  it("matches the DTO's fallback when a truncated wrapper can't be recovered", async () => {
    const truncated = "<project-context>\n# OVERVIEW\n\nproject state that got cut off";
    const [chat] = await listChats([
      { sessionId: "99999999-1111-2222-3333-444444444444", preview: truncated },
    ]);
    expect(chat.name).toBe(truncated);
  });

  it("returns the FULL sessionId regardless of what the name resolved to", async () => {
    const [chat] = await listChats([{ sessionId: "ffffffff-1111-2222-3333-444444444444" }]);
    expect(chat.sessionId).toBe("ffffffff-1111-2222-3333-444444444444");
  });
});
