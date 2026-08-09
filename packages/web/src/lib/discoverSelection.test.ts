import { describe, it, expect } from "vitest";
import {
  applySessions,
  importPlan,
  initialRows,
  patchRow,
  rowSelectedCount,
  rowTick,
  selectedCandidates,
  setRowChecked,
  toggleSession,
  totalSelected,
} from "./discoverSelection";
import type { AdoptableCandidate, DiscoverCandidate, DiscoverSessions } from "./types";

function candidate(over: Partial<DiscoverCandidate> = {}): DiscoverCandidate {
  return {
    path: "/home/ed/code/paddock",
    name: "paddock",
    suggestedSlug: "paddock",
    hasGit: true,
    insideHome: true,
    sessionCount: 3,
    filteredCount: 0,
    ...over,
  };
}

function session(id: string): AdoptableCandidate {
  return { sessionId: id, mtime: "2026-08-01T00:00:00.000Z", sizeBytes: 4096 };
}

function sessions(path: string, ids: string[]): DiscoverSessions {
  return { path, sessions: ids.map(session), filtered: [] };
}

describe("discoverSelection", () => {
  it("starts with every candidate ticked", () => {
    const rows = initialRows([candidate(), candidate({ path: "/b", suggestedSlug: "b" })]);
    expect(Object.keys(rows)).toEqual(["/home/ed/code/paddock", "/b"]);
    expect(rowTick(rows["/b"])).toBe("on");
  });

  it("never reports mixed for a row whose sessions have not been loaded", () => {
    // The distinction the whole model rests on: an unopened row has no
    // per-session opinion, so "partly ticked" is not a state it can be in.
    const rows = initialRows([candidate()]);
    expect(rowTick(rows["/home/ed/code/paddock"])).toBe("on");
    const off = setRowChecked(rows, "/home/ed/code/paddock", false);
    expect(rowTick(off["/home/ed/code/paddock"])).toBe("off");
  });

  it("goes indeterminate once a loaded row is partly ticked", () => {
    const c = candidate();
    let rows = initialRows([c]);
    rows = applySessions(rows, c.path, sessions(c.path, ["a", "b", "c"]));
    expect(rowTick(rows[c.path])).toBe("on");

    rows = toggleSession(rows, c.path, "b");
    expect(rowTick(rows[c.path])).toBe("mixed");
    expect(rowSelectedCount(rows[c.path], c)).toBe(2);

    rows = toggleSession(rows, c.path, "a");
    rows = toggleSession(rows, c.path, "c");
    expect(rowTick(rows[c.path])).toBe("off");
    expect(rows[c.path].checked).toBe(false);
  });

  it("cascades a row toggle onto its loaded sessions", () => {
    const c = candidate();
    let rows = applySessions(initialRows([c]), c.path, sessions(c.path, ["a", "b"]));
    rows = setRowChecked(rows, c.path, false);
    expect(rows[c.path].selected?.size).toBe(0);
    rows = setRowChecked(rows, c.path, true);
    expect([...(rows[c.path].selected ?? [])]).toEqual(["a", "b"]);
  });

  it("does not re-tick an unticked row just because it was expanded", () => {
    // Opening something to look at it is not consent to import it.
    const c = candidate();
    let rows = setRowChecked(initialRows([c]), c.path, false);
    rows = applySessions(rows, c.path, sessions(c.path, ["a", "b"]));
    expect(rows[c.path].selected?.size).toBe(0);
    expect(rowTick(rows[c.path])).toBe("off");
  });

  it("counts an unloaded ticked row by the scan's own session count", () => {
    const c = candidate({ sessionCount: 7 });
    const rows = initialRows([c]);
    expect(rowSelectedCount(rows[c.path], c)).toBe(7);
    expect(totalSelected(rows, [c])).toBe(7);
  });

  it("omits sessionIds for an unloaded row and sends them for a loaded one", () => {
    // Omitted means "everything on offer" on the wire, which is exactly what a
    // ticked-but-never-opened row means — including anything that appeared
    // between the scan and the submit.
    const c = candidate();
    let rows = initialRows([c]);
    expect(importPlan(rows[c.path], c)).toEqual({});

    rows = applySessions(rows, c.path, sessions(c.path, ["a", "b"]));
    rows = toggleSession(rows, c.path, "b");
    expect(importPlan(rows[c.path], c)).toEqual({ sessionIds: ["a"] });
  });

  it("excludes a row with nothing ticked from the run", () => {
    const a = candidate();
    const b = candidate({ path: "/b", suggestedSlug: "b", sessionCount: 2 });
    const rows = setRowChecked(initialRows([a, b]), a.path, false);
    expect(importPlan(rows[a.path], a)).toBeNull();
    expect(selectedCandidates(rows, [a, b]).map((c) => c.path)).toEqual(["/b"]);
    expect(totalSelected(rows, [a, b])).toBe(2);
  });

  it("treats a loaded-but-fully-unticked row as a no, not as a default yes", () => {
    // The trap this model exists to avoid: `sessions` present with an empty
    // selection is a decision, whereas `sessions` absent is the absence of one.
    const c = candidate();
    let rows = applySessions(initialRows([c]), c.path, sessions(c.path, ["a"]));
    rows = toggleSession(rows, c.path, "a");
    expect(importPlan(rows[c.path], c)).toBeNull();
  });

  it("survives a candidate the state map does not know about", () => {
    const c = candidate();
    expect(importPlan(undefined, c)).toBeNull();
    expect(totalSelected({}, [c])).toBe(0);
  });

  it("patches expansion / loading / error without touching the selection", () => {
    const c = candidate();
    let rows = applySessions(initialRows([c]), c.path, sessions(c.path, ["a", "b"]));
    rows = patchRow(rows, c.path, { expanded: true, error: "boom" });
    expect(rows[c.path].expanded).toBe(true);
    expect(rows[c.path].error).toBe("boom");
    expect(rows[c.path].selected?.size).toBe(2);
  });

  it("reports a loaded row with zero sessions as off, not on", () => {
    const c = candidate();
    const rows = applySessions(initialRows([c]), c.path, sessions(c.path, []));
    expect(rowTick(rows[c.path])).toBe("off");
    expect(importPlan(rows[c.path], c)).toBeNull();
  });
});
