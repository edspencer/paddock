import { describe, it, expect } from "vitest";
import { makeProject } from "../test/factories";
import {
  currentProjectOrders,
  orderProjects,
  projectReplyAt,
  projectSections,
} from "./projectOrder";
import type { ListOrder, Project } from "./types";

const turn = (lastTurnCompletedAt: string) => ({
  sessionId: lastTurnCompletedAt,
  lastTurnCompletedAt,
});
const slugs = (ps: readonly Project[]) => ps.map((p) => p.slug);
const order = (mode: ListOrder["mode"], orders: ListOrder["orders"] = {}): ListOrder => ({
  mode,
  orders,
});

describe("project ordering", () => {
  it("most recent reply: the newest chat turn wins, falling back to `updated`", () => {
    const ps = [
      makeProject({ slug: "stale", name: "S", updated: "2026-06-01" }),
      makeProject({
        slug: "replied",
        name: "R",
        updated: "2026-01-01",
        chatTurns: [turn("2026-06-10T09:00:00Z"), turn("2026-06-20T09:00:00Z")],
      }),
      makeProject({ slug: "touched", name: "T", updated: "2026-06-15" }),
    ];
    expect(projectReplyAt(ps[1])).toBe(Date.parse("2026-06-20T09:00:00Z"));
    expect(slugs(orderProjects(ps, "", order("recent")))).toEqual(["replied", "touched", "stale"]);
  });

  it("most recent reply: breaks ties by name", () => {
    const ps = [
      makeProject({ slug: "b", name: "Beta" }),
      makeProject({ slug: "a", name: "Alpha" }),
    ];
    expect(slugs(orderProjects(ps, "", order("recent")))).toEqual(["a", "b"]);
  });

  it("created: newest `started` first, then name, with undated projects last", () => {
    const ps = [
      makeProject({ slug: "old", name: "Old", started: "2025-01-01" }),
      makeProject({ slug: "undated", name: "Undated", started: "" }),
      makeProject({ slug: "new-b", name: "B", started: "2026-03-01" }),
      makeProject({ slug: "new-a", name: "A", started: "2026-03-01" }),
    ];
    expect(slugs(orderProjects(ps, "", order("created")))).toEqual([
      "new-a",
      "new-b",
      "old",
      "undated",
    ]);
  });

  it("manual: follows the area's order, with unplaced projects on top", () => {
    const ps = [
      makeProject({ slug: "a", name: "A" }),
      makeProject({ slug: "b", name: "B" }),
      makeProject({ slug: "fresh", name: "Fresh", chatTurns: [turn("2026-06-30T00:00:00Z")] }),
    ];
    const o = order("manual", { homelab: ["b", "a"] });
    expect(slugs(orderProjects(ps, "homelab", o))).toEqual(["fresh", "b", "a"]);
    // Another area's order does not apply.
    expect(slugs(orderProjects(ps, "house", o))).toEqual(["fresh", "a", "b"]);
  });

  it("keeps the areas in their fixed order whatever the mode", () => {
    const ps = [
      makeProject({ slug: "u", name: "U", group: "" }),
      makeProject({ slug: "h", name: "H", group: "house" }),
      makeProject({ slug: "l", name: "L", group: "homelab" }),
    ];
    for (const mode of ["recent", "created", "manual"] as const) {
      const areas = projectSections(ps, order(mode)).map(([area]) => area);
      expect(areas).toEqual(["homelab", "house", ""]);
    }
  });

  it("currentProjectOrders seeds Manual without moving anything", () => {
    const ps = [
      makeProject({ slug: "a", name: "A", group: "homelab", started: "2026-01-01" }),
      makeProject({ slug: "b", name: "B", group: "homelab", started: "2026-02-01" }),
      makeProject({ slug: "c", name: "C", group: "", started: "2026-03-01" }),
    ];
    const created = projectSections(ps, order("created"));
    const seed = currentProjectOrders(created);
    expect(seed).toEqual({ homelab: ["b", "a"], "": ["c"] });
    expect(projectSections(ps, order("manual", seed))).toEqual(created);
  });
});
