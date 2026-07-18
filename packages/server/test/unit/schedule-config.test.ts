/**
 * Scheduled-chat config helpers (issue #265 / DD-2).
 *
 * These pure functions are the seam between Paddock's `project.yaml` schedules and
 * herdctl's `ScheduleSchema`: sanitise a hand-edited map (dropping malformed
 * entries so one bad edit can't brick `addAgent`), project onto the exact fields
 * herdctl accepts (STRIPPING the Paddock-only `promptFile`), and resolve a
 * `promptFile` to a safe absolute path under `.paddock/schedules/`.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  sanitizeSchedule,
  sanitizeSchedules,
  scheduleToHerdctl,
  schedulesToHerdctl,
  schedulePromptFileAbsPath,
  isValidScheduleName,
  SCHEDULE_PROMPT_DIR,
} from "../../src/schedule-config.js";

describe("sanitizeSchedule", () => {
  it("accepts a well-formed cron schedule and trims", () => {
    expect(
      sanitizeSchedule({
        type: "cron",
        cron: "  0 9 * * *  ",
        prompt: "triage",
        enabled: true,
        resume_session: false,
      }),
    ).toEqual({ type: "cron", cron: "0 9 * * *", prompt: "triage", enabled: true, resume_session: false });
  });

  it("accepts a well-formed interval schedule", () => {
    expect(sanitizeSchedule({ type: "interval", interval: "30m", resume_session: true })).toEqual({
      type: "interval",
      interval: "30m",
      resume_session: true,
    });
  });

  it("carries the Paddock-only promptFile", () => {
    expect(sanitizeSchedule({ type: "cron", cron: "@daily", promptFile: "daily.md" })).toEqual({
      type: "cron",
      cron: "@daily",
      promptFile: "daily.md",
    });
  });

  it("drops a cron schedule with no cron expression", () => {
    expect(sanitizeSchedule({ type: "cron", prompt: "x" })).toBeNull();
    expect(sanitizeSchedule({ type: "cron", cron: "   " })).toBeNull();
  });

  it("drops an interval schedule with no interval", () => {
    expect(sanitizeSchedule({ type: "interval", prompt: "x" })).toBeNull();
  });

  it("drops unknown/unsupported types and non-objects", () => {
    expect(sanitizeSchedule({ type: "webhook", cron: "0 9 * * *" })).toBeNull();
    expect(sanitizeSchedule({ type: "chat" })).toBeNull();
    expect(sanitizeSchedule(null)).toBeNull();
    expect(sanitizeSchedule("nope")).toBeNull();
    expect(sanitizeSchedule([])).toBeNull();
  });

  it("preserves an explicit empty inline prompt (a valid prompt)", () => {
    expect(sanitizeSchedule({ type: "interval", interval: "1h", prompt: "" })).toEqual({
      type: "interval",
      interval: "1h",
      prompt: "",
    });
  });
});

describe("sanitizeSchedules", () => {
  it("keeps good entries and drops malformed ones + bad names", () => {
    const out = sanitizeSchedules({
      good: { type: "cron", cron: "0 9 * * *", prompt: "a" },
      broken: { type: "cron" }, // no cron → dropped
      "bad name": { type: "interval", interval: "5m" }, // invalid name → dropped
      alsoGood: { type: "interval", interval: "5m" },
    });
    expect(Object.keys(out ?? {}).sort()).toEqual(["alsoGood", "good"]);
  });

  it("returns undefined when nothing survives / not a map", () => {
    expect(sanitizeSchedules(undefined)).toBeUndefined();
    expect(sanitizeSchedules({})).toBeUndefined();
    expect(sanitizeSchedules({ broken: { type: "cron" } })).toBeUndefined();
    expect(sanitizeSchedules([])).toBeUndefined();
  });
});

describe("isValidScheduleName", () => {
  it("accepts safe names, rejects spaces / traversal / overlong", () => {
    expect(isValidScheduleName("daily-manager")).toBe(true);
    expect(isValidScheduleName("tick_2")).toBe(true);
    expect(isValidScheduleName("has space")).toBe(false);
    expect(isValidScheduleName("../evil")).toBe(false);
    expect(isValidScheduleName("x".repeat(65))).toBe(false);
    expect(isValidScheduleName("")).toBe(false);
  });
});

describe("scheduleToHerdctl / schedulesToHerdctl", () => {
  it("projects onto herdctl fields and STRIPS promptFile", () => {
    const out = scheduleToHerdctl({
      type: "cron",
      cron: "0 9 * * *",
      prompt: "inline",
      enabled: true,
      resume_session: true,
      promptFile: "daily.md",
    });
    expect(out).toEqual({
      type: "cron",
      cron: "0 9 * * *",
      prompt: "inline",
      enabled: true,
      resume_session: true,
    });
    expect(out).not.toHaveProperty("promptFile");
  });

  it("omits prompt entirely when only a promptFile drives the schedule (keeps config pure)", () => {
    const out = scheduleToHerdctl({ type: "interval", interval: "1h", promptFile: "x.md" });
    expect(out).toEqual({ type: "interval", interval: "1h" });
  });

  it("maps a whole block, undefined when empty", () => {
    expect(
      schedulesToHerdctl({ a: { type: "cron", cron: "@daily", promptFile: "a.md" } }),
    ).toEqual({ a: { type: "cron", cron: "@daily" } });
    expect(schedulesToHerdctl(undefined)).toBeUndefined();
  });
});

describe("schedulePromptFileAbsPath", () => {
  const wd = "/tmp/proj";
  const base = path.join(wd, SCHEDULE_PROMPT_DIR);

  it("resolves a bare .md name under .paddock/schedules/", () => {
    expect(schedulePromptFileAbsPath(wd, "daily.md")).toBe(path.join(base, "daily.md"));
    expect(schedulePromptFileAbsPath(wd, "sub/deep.md")).toBe(path.join(base, "sub/deep.md"));
  });

  it("rejects traversal, absolute paths, and non-.md files", () => {
    expect(schedulePromptFileAbsPath(wd, "../../etc/passwd")).toBeNull();
    expect(schedulePromptFileAbsPath(wd, "../secret.md")).toBeNull();
    expect(schedulePromptFileAbsPath(wd, "/etc/passwd.md")).toBeNull();
    expect(schedulePromptFileAbsPath(wd, "daily.txt")).toBeNull();
    expect(schedulePromptFileAbsPath(wd, "")).toBeNull();
  });
});
