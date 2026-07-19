/**
 * trigger-config — the unified trigger model (Epic T "Unify Triggers" / T1).
 *
 * Covers the FROZEN discriminated-union validation (the ticket's acceptance:
 * cron-xor-interval; unknown `on` rejected; prompt-xor-promptFile), the safe-create
 * `enabled: false` default, the map-level drop-malformed sanitizer, and the three
 * projection helpers T2–T5 build on (run→agent-config, schedule→herdctl, promptFile
 * path guard).
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeTrigger,
  sanitizeTriggers,
  isValidTriggerName,
  triggerToAgentToolConfig,
  triggersToHerdctlSchedules,
  scheduleTriggerToHerdctl,
  triggerPromptFileAbsPath,
  TRIGGER_DEFAULT_MAX_TURNS,
  type PaddockTrigger,
} from "../../src/trigger-config.js";

const run = (extra: Record<string, unknown> = {}) => ({ prompt: "do the thing", ...extra });

describe("trigger-config: discriminant validation", () => {
  it("accepts a schedule trigger with cron XOR interval", () => {
    const cron = sanitizeTrigger({ trigger: { type: "schedule", cron: "0 9 * * *" }, run: run() });
    expect(cron?.trigger).toEqual({ type: "schedule", cron: "0 9 * * *" });
    const interval = sanitizeTrigger({
      trigger: { type: "schedule", interval: "30m" },
      run: run(),
    });
    expect(interval?.trigger).toEqual({ type: "schedule", interval: "30m" });
  });

  it("rejects a schedule trigger with BOTH cron and interval (xor)", () => {
    expect(
      sanitizeTrigger({
        trigger: { type: "schedule", cron: "0 9 * * *", interval: "30m" },
        run: run(),
      }),
    ).toBeNull();
  });

  it("rejects a schedule trigger with NEITHER cron nor interval (xor)", () => {
    expect(sanitizeTrigger({ trigger: { type: "schedule" }, run: run() })).toBeNull();
  });

  it("accepts an event trigger with a KNOWN `on` value", () => {
    expect(
      sanitizeTrigger({ trigger: { type: "event", on: "onArchive" }, run: run() })?.trigger,
    ).toEqual({ type: "event", on: "onArchive" });
    // afterTurn is a KNOWN (reserved for the sweeper fold-in) value — validates now.
    expect(
      sanitizeTrigger({ trigger: { type: "event", on: "afterTurn" }, run: run() })?.trigger,
    ).toEqual({ type: "event", on: "afterTurn" });
  });

  it("rejects an event trigger with an UNKNOWN `on` value", () => {
    expect(sanitizeTrigger({ trigger: { type: "event", on: "onWeekend" }, run: run() })).toBeNull();
  });

  it("accepts a webhook trigger (shape reserved) with a path", () => {
    expect(
      sanitizeTrigger({ trigger: { type: "webhook", path: "/gh/issues" }, run: run() })?.trigger,
    ).toEqual({ type: "webhook", path: "/gh/issues" });
  });

  it("rejects an unknown trigger type", () => {
    expect(sanitizeTrigger({ trigger: { type: "carrier-pigeon" }, run: run() })).toBeNull();
  });
});

describe("trigger-config: run (prompt xor promptFile)", () => {
  it("accepts exactly one of prompt / promptFile", () => {
    expect(
      sanitizeTrigger({ trigger: { type: "event", on: "onArchive" }, run: { prompt: "hi" } }),
    ).not.toBeNull();
    expect(
      sanitizeTrigger({
        trigger: { type: "event", on: "onArchive" },
        run: { promptFile: "cleanup.md" },
      }),
    ).not.toBeNull();
  });

  it("rejects BOTH prompt and promptFile (xor)", () => {
    expect(
      sanitizeTrigger({
        trigger: { type: "event", on: "onArchive" },
        run: { prompt: "hi", promptFile: "cleanup.md" },
      }),
    ).toBeNull();
  });

  it("rejects NEITHER prompt nor promptFile (xor)", () => {
    expect(
      sanitizeTrigger({ trigger: { type: "event", on: "onArchive" }, run: {} }),
    ).toBeNull();
  });

  it("defaults session=new and tools=[] on the run", () => {
    const t = sanitizeTrigger({ trigger: { type: "event", on: "onArchive" }, run: run() });
    expect(t?.run.session).toBe("new");
    expect(t?.run.tools).toEqual([]);
  });

  it("preserves an explicit run capability", () => {
    const t = sanitizeTrigger({
      trigger: { type: "schedule", cron: "0 3 * * *" },
      run: {
        promptFile: "dreamer.md",
        session: "resume",
        model: "claude-haiku-4-5-20251001",
        tools: ["Read", "Grep"],
        maxSpawnDepth: 1,
        permissionMode: "acceptEdits",
        maxTurns: 12,
      },
    });
    expect(t?.run).toEqual({
      promptFile: "dreamer.md",
      session: "resume",
      model: "claude-haiku-4-5-20251001",
      tools: ["Read", "Grep"],
      maxSpawnDepth: 1,
      permissionMode: "acceptEdits",
      maxTurns: 12,
    });
  });
});

describe("trigger-config: enabled default (safe-create)", () => {
  it("defaults enabled=false when omitted (programmatic create)", () => {
    const t = sanitizeTrigger({ trigger: { type: "event", on: "onArchive" }, run: run() });
    expect(t?.enabled).toBe(false);
  });

  it("honors an explicit enabled:true", () => {
    const t = sanitizeTrigger({
      trigger: { type: "event", on: "onArchive" },
      run: run(),
      enabled: true,
    });
    expect(t?.enabled).toBe(true);
  });
});

describe("trigger-config: sanitizeTriggers (drop malformed, keep going)", () => {
  it("drops malformed + unsafe-named entries but keeps valid ones", () => {
    const map = sanitizeTriggers({
      good: { trigger: { type: "event", on: "onArchive" }, run: run() },
      "bad name!": { trigger: { type: "event", on: "onArchive" }, run: run() },
      brokenXor: { trigger: { type: "schedule", cron: "0 9 * * *", interval: "1h" }, run: run() },
      alsoGood: { trigger: { type: "schedule", interval: "1h" }, run: run() },
    });
    expect(Object.keys(map ?? {}).sort()).toEqual(["alsoGood", "good"]);
  });

  it("returns undefined when nothing survives", () => {
    expect(sanitizeTriggers({ bad: { trigger: { type: "nope" } } })).toBeUndefined();
    expect(sanitizeTriggers(undefined)).toBeUndefined();
    expect(sanitizeTriggers([])).toBeUndefined();
  });

  it("validates trigger names", () => {
    expect(isValidTriggerName("daily-manager")).toBe(true);
    expect(isValidTriggerName("bad name")).toBe(false);
    expect(isValidTriggerName("x".repeat(65))).toBe(false);
  });
});

describe("trigger-config: projection helpers", () => {
  const evTrigger = (run: Record<string, unknown>): PaddockTrigger =>
    sanitizeTrigger({ trigger: { type: "event", on: "onArchive" }, run })!;

  it("triggerToAgentToolConfig projects run.tools onto herdctl agent fields", () => {
    const cfg = triggerToAgentToolConfig(
      evTrigger({ prompt: "x", tools: ["Bash", "Read"], permissionMode: "acceptEdits", model: "claude-opus-4-8", maxTurns: 7 }).run,
    );
    expect(cfg).toEqual({
      allowed_tools: ["Bash", "Read"],
      max_turns: 7,
      permission_mode: "acceptEdits",
      model: "claude-opus-4-8",
    });
  });

  it("triggerToAgentToolConfig defaults a tool-less trigger to allowed_tools:[] + default max_turns", () => {
    const cfg = triggerToAgentToolConfig(evTrigger({ prompt: "x" }).run);
    expect(cfg).toEqual({ allowed_tools: [], max_turns: TRIGGER_DEFAULT_MAX_TURNS });
  });

  it("scheduleTriggerToHerdctl projects cron/interval + resume_session + enabled", () => {
    const cron = sanitizeTrigger({
      trigger: { type: "schedule", cron: "0 9 * * *" },
      run: { prompt: "manage", session: "resume" },
      enabled: true,
    })!;
    expect(scheduleTriggerToHerdctl(cron.trigger as never, cron.run, true)).toEqual({
      type: "cron",
      cron: "0 9 * * *",
      prompt: "manage",
      resume_session: true,
      enabled: true,
    });
    // promptFile-driven schedule forwards NO prompt (resolved at fire time) and
    // resume_session:false for a session:new run.
    const file = sanitizeTrigger({
      trigger: { type: "schedule", interval: "1h" },
      run: { promptFile: "x.md", session: "new" },
    })!;
    expect(scheduleTriggerToHerdctl(file.trigger as never, file.run, false)).toEqual({
      type: "interval",
      interval: "1h",
      resume_session: false,
      enabled: false,
    });
  });

  it("triggersToHerdctlSchedules forwards ONLY schedule-type triggers", () => {
    const map = sanitizeTriggers({
      sched: { trigger: { type: "schedule", cron: "0 9 * * *" }, run: run(), enabled: true },
      ev: { trigger: { type: "event", on: "onArchive" }, run: run(), enabled: true },
      wh: { trigger: { type: "webhook", path: "/x" }, run: run(), enabled: true },
    })!;
    const forwarded = triggersToHerdctlSchedules(map);
    expect(Object.keys(forwarded ?? {})).toEqual(["sched"]);
    expect(forwarded?.sched?.type).toBe("cron");
  });

  it("triggerPromptFileAbsPath resolves under .paddock/triggers, rejects traversal/non-md", () => {
    const wd = "/work/proj";
    expect(triggerPromptFileAbsPath(wd, "daily.md")).toBe("/work/proj/.paddock/triggers/daily.md");
    expect(triggerPromptFileAbsPath(wd, "../secret.md")).toBeNull();
    expect(triggerPromptFileAbsPath(wd, "/abs/x.md")).toBeNull();
    expect(triggerPromptFileAbsPath(wd, "notes.txt")).toBeNull();
    expect(triggerPromptFileAbsPath(wd, "")).toBeNull();
  });
});
