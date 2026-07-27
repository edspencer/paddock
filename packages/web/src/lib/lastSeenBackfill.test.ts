import { describe, it, expect, vi, beforeEach } from "vitest";
import { backfillLegacyLastSeen, resetBackfillForTests } from "./lastSeenBackfill";
import { lastSeenKey, readLastSeen } from "./lastSeen";
import type { Project } from "./types";

const markChatSeen = vi.fn(async () => undefined);
vi.mock("./api", () => ({ api: { markChatSeen: (...a: unknown[]) => markChatSeen(...(a as [])) } }));

function project(slug: string, turns: { sessionId: string; lastSeen?: number }[]): Project {
  return {
    slug,
    name: slug,
    chatTurns: turns.map((t) => ({
      sessionId: t.sessionId,
      lastTurnCompletedAt: new Date(1000).toISOString(),
      ...(t.lastSeen ? { lastSeen: t.lastSeen } : {}),
    })),
  } as unknown as Project;
}

beforeEach(() => {
  localStorage.clear();
  markChatSeen.mockClear();
  resetBackfillForTests();
});

describe("legacy lastSeen backfill (#488)", () => {
  it("pushes a legacy value the server is behind on, then drops the key", async () => {
    localStorage.setItem(lastSeenKey("s1"), "9000");
    await backfillLegacyLastSeen([project("alpha", [{ sessionId: "s1", lastSeen: 1000 }])]);

    expect(markChatSeen).toHaveBeenCalledTimes(1);
    expect(markChatSeen).toHaveBeenCalledWith("alpha", "s1", 9000);
    expect(localStorage.getItem(lastSeenKey("s1"))).toBeNull();
    // Reflected locally so the cue doesn't flicker before the next refetch.
    expect(readLastSeen("s1")).toBe(9000);
  });

  it("skips a chat the server already covers, but still drops the stale key", async () => {
    localStorage.setItem(lastSeenKey("s2"), "1000");
    await backfillLegacyLastSeen([project("alpha", [{ sessionId: "s2", lastSeen: 5000 }])]);

    expect(markChatSeen).not.toHaveBeenCalled();
    expect(localStorage.getItem(lastSeenKey("s2"))).toBeNull();
  });

  it("resolves the project slug from chatTurns (legacy keys carry no project)", async () => {
    localStorage.setItem(lastSeenKey("s3"), "9000");
    await backfillLegacyLastSeen([
      project("alpha", [{ sessionId: "other" }]),
      project("beta", [{ sessionId: "s3" }]),
    ]);
    expect(markChatSeen).toHaveBeenCalledWith("beta", "s3", 9000);
  });

  it("keeps an unmatched key — the payload may be partial, and keeping it is harmless", async () => {
    localStorage.setItem(lastSeenKey("ghost"), "9000");
    localStorage.setItem(lastSeenKey("s4"), "9000");
    await backfillLegacyLastSeen([project("alpha", [{ sessionId: "s4" }])]);

    expect(localStorage.getItem(lastSeenKey("s4"))).toBeNull(); // migrated
    expect(localStorage.getItem(lastSeenKey("ghost"))).toBe("9000"); // untouched
  });

  it("keeps the key when the POST fails, so a later load retries", async () => {
    markChatSeen.mockRejectedValueOnce(new Error("offline"));
    localStorage.setItem(lastSeenKey("s5"), "9000");
    await backfillLegacyLastSeen([project("alpha", [{ sessionId: "s5" }])]);

    expect(localStorage.getItem(lastSeenKey("s5"))).toBe("9000");
  });

  it("runs at most once per page load", async () => {
    localStorage.setItem(lastSeenKey("s6"), "9000");
    const projects = [project("alpha", [{ sessionId: "s6" }])];
    await backfillLegacyLastSeen(projects);
    localStorage.setItem(lastSeenKey("s6"), "9999"); // would otherwise re-migrate
    await backfillLegacyLastSeen(projects);
    expect(markChatSeen).toHaveBeenCalledTimes(1);
  });

  it("does not consume its single attempt on an empty/early payload", async () => {
    localStorage.setItem(lastSeenKey("s7"), "9000");
    await backfillLegacyLastSeen([]); // projects not loaded yet
    expect(markChatSeen).not.toHaveBeenCalled();
    await backfillLegacyLastSeen([project("alpha", [{ sessionId: "s7" }])]);
    expect(markChatSeen).toHaveBeenCalledWith("alpha", "s7", 9000);
  });

  it("no-ops when there is no legacy state at all", async () => {
    await backfillLegacyLastSeen([project("alpha", [{ sessionId: "s8" }])]);
    expect(markChatSeen).not.toHaveBeenCalled();
  });
});
