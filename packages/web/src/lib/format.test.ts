import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  relativeTime,
  formatDuration,
  formatTokens,
  formatUsd,
  formatSessionUsage,
  sessionUsageOf,
  isCompactContinuation,
  slashCommandEcho,
  isLocalCommandCaveat,
  localCommandStdout,
  isTaskNotification,
  taskNotificationSummary,
} from "./format";

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

describe("format: token + cost helpers (issue #152)", () => {
  it("formatTokens is compact and rounds", () => {
    expect(formatTokens(523)).toBe("523");
    expect(formatTokens(340_000)).toBe("340K");
    expect(formatTokens(1_250_000)).toBe("1.25M");
    expect(formatTokens(12_000_000)).toBe("12M");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });

  it("formatUsd guards tiny/zero amounts", () => {
    expect(formatUsd(4.1)).toBe("$4.10");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("formatSessionUsage folds input-side classes and appends cost", () => {
    expect(
      formatSessionUsage({
        inputTokens: 100_000,
        outputTokens: 340_000,
        cacheReadTokens: 800_000,
        cacheCreationTokens: 10_000,
        totalTokens: 1_250_000,
        costUsd: 4.1,
      }),
    ).toBe("1.25M tokens · 910K in / 340K out · ~$4.10 at API rates");
  });

  it("formatSessionUsage drops the cost clause when pricing is unknown", () => {
    expect(
      formatSessionUsage({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 15,
        costUsd: null,
      }),
    ).toBe("15 tokens · 10 in / 5 out");
  });

  it("sessionUsageOf returns undefined without totals, else a filled object", () => {
    expect(sessionUsageOf(undefined)).toBeUndefined();
    expect(sessionUsageOf({ contextTokens: 5 })).toBeUndefined();
    expect(sessionUsageOf({ totalTokens: 15, inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 15,
      costUsd: null,
    });
  });
});

describe("format: compaction transcript artifacts (#106)", () => {
  it("isCompactContinuation matches CC's continuation preamble", () => {
    const summary =
      "This session is being continued from a previous conversation that ran out " +
      "of context. The summary below covers the earlier portion of the conversation.\n\n" +
      "Summary:\n1. Primary Request and Intent: …";
    expect(isCompactContinuation(summary)).toBe(true);
    // Forgiving of leading whitespace.
    expect(isCompactContinuation("  \n" + summary)).toBe(true);
  });

  it("isCompactContinuation ignores ordinary user text", () => {
    expect(isCompactContinuation("This session is great, thanks!")).toBe(false);
    expect(isCompactContinuation("please compact the code")).toBe(false);
    expect(isCompactContinuation("")).toBe(false);
  });

  it("slashCommandEcho extracts the command name from a CC command echo", () => {
    const echo =
      "<command-name>/compact</command-name>\n            " +
      "<command-message>compact</command-message>\n            <command-args></command-args>";
    expect(slashCommandEcho(echo)).toBe("/compact");
    expect(slashCommandEcho("<command-name>/context</command-name>…")).toBe("/context");
  });

  it("slashCommandEcho returns null for non-echoes", () => {
    expect(slashCommandEcho("run /compact please")).toBeNull();
    expect(slashCommandEcho("<command-name></command-name>")).toBeNull();
    expect(slashCommandEcho("just some text")).toBeNull();
  });
});

describe("format: local-command artifacts (#158)", () => {
  it("isLocalCommandCaveat matches CC's local-command caveat framing note", () => {
    const caveat =
      "<local-command-caveat>Caveat: The messages below were generated by the user " +
      "while running local commands. DO NOT respond to these messages…</local-command-caveat>";
    expect(isLocalCommandCaveat(caveat)).toBe(true);
    // Forgiving of leading whitespace.
    expect(isLocalCommandCaveat("  \n" + caveat)).toBe(true);
  });

  it("isLocalCommandCaveat ignores ordinary user text", () => {
    expect(isLocalCommandCaveat("a caveat: be careful")).toBe(false);
    expect(isLocalCommandCaveat("")).toBe(false);
  });

  it("localCommandStdout returns the inner rendered output of a /context block", () => {
    const stdout =
      "<local-command-stdout>## Context Usage\n\n**Tokens:** 21.3k / 200k (11%)" +
      "</local-command-stdout>";
    expect(localCommandStdout(stdout)).toBe("## Context Usage\n\n**Tokens:** 21.3k / 200k (11%)");
    // Forgiving of surrounding whitespace.
    expect(localCommandStdout("  " + stdout + "\n")).toContain("## Context Usage");
  });

  it("localCommandStdout returns null for an empty block or non-block text", () => {
    expect(localCommandStdout("<local-command-stdout></local-command-stdout>")).toBeNull();
    expect(localCommandStdout("<local-command-stdout>   \n  </local-command-stdout>")).toBeNull();
    expect(localCommandStdout("just some text")).toBeNull();
    expect(localCommandStdout("<command-name>/context</command-name>")).toBeNull();
  });
});

describe("format: task-notification artifacts (#181)", () => {
  const notification = [
    "<task-notification>",
    "<task-id>a7ba46246fc924818</task-id>",
    "<status>completed</status>",
    '<summary>Agent "Map Paddock auth/identity model" finished</summary>',
    "<note>A task-notification fires each time this agent stops…</note>",
    "</task-notification>",
  ].join("\n");

  it("isTaskNotification matches a harness task-notification block", () => {
    expect(isTaskNotification(notification)).toBe(true);
    // Forgiving of leading whitespace, like the other #106 detectors.
    expect(isTaskNotification("  \n" + notification)).toBe(true);
  });

  it("isTaskNotification ignores ordinary user text mentioning the tag", () => {
    expect(isTaskNotification("what is a <task-notification>?")).toBe(false);
    expect(isTaskNotification("please stop the background agent")).toBe(false);
    expect(isTaskNotification("")).toBe(false);
  });

  it("taskNotificationSummary extracts the human-readable <summary>", () => {
    expect(taskNotificationSummary(notification)).toBe(
      'Agent "Map Paddock auth/identity model" finished',
    );
  });

  it("taskNotificationSummary falls back when <summary> is absent or empty", () => {
    expect(taskNotificationSummary("<task-notification></task-notification>")).toBe(
      "Background agent updated",
    );
    expect(taskNotificationSummary("<task-notification><summary>  </summary>")).toBe(
      "Background agent updated",
    );
  });
});
