import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { relativeTime, formatDuration } from "./format";

describe("format: relativeTime", () => {
  beforeEach(() => {
    // Freeze "now" to a fixed local time so both the date-only and ISO branches
    // are deterministic. 2026-06-21T12:00:00 local.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 21, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for missing input", () => {
    expect(relativeTime(undefined)).toBe("");
    expect(relativeTime("")).toBe("");
  });

  // --- date-only (YYYY-MM-DD) branch ---
  it("renders today for the current calendar date", () => {
    expect(relativeTime("2026-06-21")).toBe("today");
  });

  it("renders yesterday for the previous calendar date", () => {
    expect(relativeTime("2026-06-20")).toBe("yesterday");
  });

  it("renders Nd ago within a week", () => {
    expect(relativeTime("2026-06-18")).toBe("3d ago");
  });

  it("renders weeks/months/years for older date-only values", () => {
    expect(relativeTime("2026-06-07")).toBe("2w ago");
    expect(relativeTime("2026-04-21")).toBe("2mo ago");
    expect(relativeTime("2024-06-21")).toBe("2y ago");
  });

  it("does not render an hour-precise label for a date-only today (the bug it guards)", () => {
    // A naive `new Date("2026-06-21")` is midnight UTC; the date-only branch
    // must avoid the misleading "Xh ago".
    expect(relativeTime("2026-06-21")).toBe("today");
    expect(relativeTime("2026-06-21")).not.toMatch(/h ago/);
  });

  // --- ISO timestamp branch ---
  it("renders just now for a very recent timestamp", () => {
    const tenSecAgo = new Date(2026, 5, 21, 11, 59, 50).toISOString();
    expect(relativeTime(tenSecAgo)).toBe("just now");
  });

  it("renders minutes and hours for ISO timestamps", () => {
    expect(relativeTime(new Date(2026, 5, 21, 11, 30, 0).toISOString())).toBe("30m ago");
    expect(relativeTime(new Date(2026, 5, 21, 9, 0, 0).toISOString())).toBe("3h ago");
  });

  it("returns the raw input for an unparseable string", () => {
    expect(relativeTime("not-a-date")).toBe("not-a-date");
  });
});

describe("format: formatDuration", () => {
  it("returns null for nullish/NaN", () => {
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(NaN)).toBeNull();
  });

  it("formats sub-second durations in ms", () => {
    expect(formatDuration(74)).toBe("74ms");
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats seconds with one decimal under 10s", () => {
    expect(formatDuration(1300)).toBe("1.3s");
    expect(formatDuration(9500)).toBe("9.5s");
  });

  it("rounds to whole seconds at/over 10s", () => {
    expect(formatDuration(12000)).toBe("12s");
    expect(formatDuration(12400)).toBe("12s");
  });
});
