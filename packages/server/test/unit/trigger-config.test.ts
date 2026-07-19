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
  triggerRunsOnOwnAgent,
  triggersToHerdctlSchedules,
  scheduleTriggerToHerdctl,
  triggerPromptFileAbsPath,
  isCuratorTrigger,
  curatorTriggerOf,
  CURATE_TRIGGER_NAME,
  mergeTriggerUpdate,
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

  // T2 (#307): which triggers run on their OWN scoped `trigger-<slug>-<name>` agent
  // (tool config = capability) vs. as the keeper (project-agent default toolset).
  it("triggerRunsOnOwnAgent: event ALWAYS; schedule iff a non-empty tools allow-list", () => {
    const mk = (raw: unknown) => sanitizeTrigger(raw)!;
    // Event triggers ALWAYS run on their own agent — even a tool-less curator ([]),
    // whose empty allow-list is a deliberate deny-all (unchanged from Epic G).
    expect(
      triggerRunsOnOwnAgent(mk({ trigger: { type: "event", on: "onArchive" }, run: run() })),
    ).toBe(true);
    expect(
      triggerRunsOnOwnAgent(
        mk({ trigger: { type: "event", on: "onArchive" }, run: run({ tools: [] }) }),
      ),
    ).toBe(true);
    // A SCHEDULE with a non-empty tools allow-list is scoped (T2)…
    expect(
      triggerRunsOnOwnAgent(
        mk({ trigger: { type: "schedule", cron: "0 9 * * *" }, run: run({ tools: ["Read"] }) }),
      ),
    ).toBe(true);
    // …but a schedule with NO tools (default []) runs as the keeper — behaviour
    // unchanged from pre-T2, when schedules ran with the keeper's full tools.
    expect(
      triggerRunsOnOwnAgent(
        mk({ trigger: { type: "schedule", interval: "1h" }, run: run() }),
      ),
    ).toBe(false);
    expect(
      triggerRunsOnOwnAgent(
        mk({ trigger: { type: "schedule", interval: "1h" }, run: run({ tools: [] }) }),
      ),
    ).toBe(false);
    // Webhook is reserved (never fired) → registers no agent.
    expect(
      triggerRunsOnOwnAgent(
        mk({ trigger: { type: "webhook", path: "/x" }, run: run({ tools: ["Bash"] }) }),
      ),
    ).toBe(false);
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

describe("trigger-config: curator (afterTurn) — the folded-in sweeper (T5)", () => {
  const mk = (t: Partial<PaddockTrigger> & { trigger: PaddockTrigger["trigger"] }): PaddockTrigger =>
    sanitizeTrigger({ enabled: true, run: run(), ...t }) as PaddockTrigger;

  it("isCuratorTrigger is true ONLY for event/afterTurn triggers", () => {
    expect(isCuratorTrigger(mk({ trigger: { type: "event", on: "afterTurn" } }))).toBe(true);
    // Any other event, or any schedule/webhook, is NOT the curator.
    expect(isCuratorTrigger(mk({ trigger: { type: "event", on: "onArchive" } }))).toBe(false);
    expect(isCuratorTrigger(mk({ trigger: { type: "schedule", cron: "0 9 * * *" } }))).toBe(false);
    expect(isCuratorTrigger(mk({ trigger: { type: "webhook", path: "/x" } }))).toBe(false);
  });

  it("curatorTriggerOf resolves the canonical curate-overview trigger", () => {
    const curate = mk({ trigger: { type: "event", on: "afterTurn" } });
    const other = mk({ trigger: { type: "event", on: "onArchive" } });
    const map = { [CURATE_TRIGGER_NAME]: curate, "archive-cleanup": other };
    expect(curatorTriggerOf(map)).toBe(curate);
  });

  it("curatorTriggerOf falls back to the first structural curator under a different name", () => {
    const curate = mk({ trigger: { type: "event", on: "afterTurn" } });
    expect(curatorTriggerOf({ "my-curator": curate })).toBe(curate);
  });

  it("curatorTriggerOf returns null when the project declares no curator (implicit default)", () => {
    expect(curatorTriggerOf(undefined)).toBeNull();
    expect(curatorTriggerOf({})).toBeNull();
    expect(
      curatorTriggerOf({ "archive-cleanup": mk({ trigger: { type: "event", on: "onArchive" } }) }),
    ).toBeNull();
  });

  it("ignores a non-curator trigger that happens to be NAMED curate-overview", () => {
    // A schedule named `curate-overview` is NOT the curator (structural check wins).
    const sched = mk({ trigger: { type: "schedule", cron: "0 9 * * *" } });
    expect(curatorTriggerOf({ [CURATE_TRIGGER_NAME]: sched })).toBeNull();
  });
});

// mergeTriggerUpdate — the partial-update overlay the T3 self-MCP `set_trigger` uses.
describe("trigger-config: mergeTriggerUpdate (partial patch semantics)", () => {
  const existing = (): PaddockTrigger =>
    sanitizeTrigger({
      trigger: { type: "schedule", cron: "0 9 * * *" },
      run: { promptFile: "daily.md", session: "resume", tools: ["Bash", "Read"], model: "claude-opus-4-8" },
      enabled: true,
    })!;

  it("an enabled-only patch inherits the whole trigger + run (GG-3 toggle)", () => {
    const merged = mergeTriggerUpdate(existing(), { enabled: false });
    // Re-sanitises cleanly (proving trigger + run were inherited intact) with only enabled flipped.
    const clean = sanitizeTrigger(merged)!;
    expect(clean.enabled).toBe(false);
    expect(clean.trigger).toEqual({ type: "schedule", cron: "0 9 * * *" });
    expect(clean.run.promptFile).toBe("daily.md");
    expect(clean.run.tools).toEqual(["Bash", "Read"]);
  });

  it("a run-field patch overlays but preserves omitted run fields", () => {
    const merged = mergeTriggerUpdate(existing(), { run: { tools: ["Read"] } });
    const clean = sanitizeTrigger(merged)!;
    expect(clean.run.tools).toEqual(["Read"]);
    expect(clean.run.promptFile).toBe("daily.md"); // preserved
    expect(clean.run.model).toBe("claude-opus-4-8"); // preserved
  });

  it("supplying a prompt clears the inherited promptFile (mode switch)", () => {
    const merged = mergeTriggerUpdate(existing(), { run: { prompt: "inline now" } });
    const clean = sanitizeTrigger(merged)!; // would be null if BOTH survived (xor)
    expect(clean.run.prompt).toBe("inline now");
    expect(clean.run.promptFile).toBeUndefined();
  });

  it("supplying a promptFile clears the inherited prompt (mode switch)", () => {
    const inline = sanitizeTrigger({
      trigger: { type: "event", on: "onArchive" },
      run: { prompt: "think" },
      enabled: false,
    })!;
    const merged = mergeTriggerUpdate(inline, { run: { promptFile: "cleanup.md" } });
    const clean = sanitizeTrigger(merged)!;
    expect(clean.run.promptFile).toBe("cleanup.md");
    expect(clean.run.prompt).toBeUndefined();
  });

  it("supplying `trigger` replaces the discriminant wholesale (re-specify)", () => {
    const merged = mergeTriggerUpdate(existing(), {
      trigger: { type: "event", on: "onArchive" },
    });
    const clean = sanitizeTrigger(merged)!;
    expect(clean.trigger).toEqual({ type: "event", on: "onArchive" });
    expect(clean.run.promptFile).toBe("daily.md"); // run inherited
  });

  it("a brand-new trigger (null existing) takes the incoming verbatim + defaults enabled false", () => {
    const merged = mergeTriggerUpdate(null, {
      trigger: { type: "event", on: "onArchive" },
      run: { prompt: "hi", tools: ["Bash"] },
    });
    const clean = sanitizeTrigger(merged)!;
    expect(clean.enabled).toBe(false);
    expect(clean.trigger).toEqual({ type: "event", on: "onArchive" });
    expect(clean.run.prompt).toBe("hi");
  });
});
