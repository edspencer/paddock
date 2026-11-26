import { describe, it, expect } from "vitest";
import { withVerdict } from "./chatVerdict";
import type { ChatVerdict } from "./types";

const verdict = (turnCompletedAt: string): ChatVerdict => ({
  verdict: "could-continue",
  reason: "Offered next steps.",
  turnCompletedAt,
  judgedAt: "2026-11-05T10:00:10.000Z",
});

describe("withVerdict", () => {
  const rows: { sessionId: string; projectSlug: string; updatedAt: string; verdict?: ChatVerdict }[] = [
    { sessionId: "s1", projectSlug: "a", updatedAt: "2026-11-05T10:00:00.000Z" },
    { sessionId: "s2", projectSlug: "a", updatedAt: "2026-11-05T10:00:00.000Z" },
  ];

  it("applies a frame that judged the row's last message", () => {
    const v = verdict("2026-11-05T10:00:00.000Z");
    const out = withVerdict(rows, "s1", v, "a");
    expect(out[0]).toMatchObject({ verdict: v });
    expect(out[1]).toBe(rows[1]);
  });

  it("ignores a frame that judged an older message than the row shows", () => {
    expect(withVerdict(rows, "s1", verdict("2026-11-05T09:59:00.000Z"), "a")).toBe(rows);
  });

  it("applies a frame newer than the row (the list has not refetched yet)", () => {
    const out = withVerdict(rows, "s1", verdict("2026-11-05T10:01:00.000Z"));
    expect(out[0].verdict?.turnCompletedAt).toBe("2026-11-05T10:01:00.000Z");
  });

  it("carries the frame's goal, keeps the row's when it has none, and drops a stale frame's", () => {
    const withGoal = rows.map((r) => ({ ...r, goal: "Old goal." }));
    const v = verdict("2026-11-05T10:00:00.000Z");
    expect(withVerdict(withGoal, "s1", { ...v, goal: "New goal." })[0].goal).toBe("New goal.");
    expect(withVerdict(withGoal, "s1", v)[0].goal).toBe("Old goal.");
    const stale = { ...verdict("2026-11-05T09:59:00.000Z"), goal: "Stale goal." };
    expect(withVerdict(withGoal, "s1", stale)).toBe(withGoal);
  });

  it("leaves rows of another project, or no matching chat, untouched", () => {
    const v = verdict("2026-11-05T10:00:00.000Z");
    expect(withVerdict(rows, "s1", v, "b")).toBe(rows);
    expect(withVerdict(rows, "nope", v)).toBe(rows);
  });
});
