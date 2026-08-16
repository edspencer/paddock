/**
 * The selection rules behind #882's migration modal.
 *
 * The two tests that earn their keep here are the ones about the REQUEST BODY.
 * Both fields it carries fail silently when they are wrong: omit
 * `plannedSessionIds` and the server cannot tell an unticked chat from one
 * created while the dialog was open, so `unplanned[]` comes back empty forever
 * and the completion screen's honesty guarantee quietly stops being true; send
 * `expectedVersion` as `undefined` instead of `null` and `JSON.stringify` drops
 * the key, which turns a conditional write into an unconditional one. Neither
 * shows up as an error anywhere — only as a wrong answer much later.
 */
import { describe, it, expect } from "vitest";
import {
  allRows,
  buildMigrationRequest,
  groupPreserved,
  initialSelection,
  migrationOutcome,
  planIsEmpty,
  projectTally,
  setAllSelection,
  setProjectSelection,
  silentlyMoving,
  stateCopy,
  toggleRow,
} from "./migrationPlan";
import type {
  TranscriptsMigrationChat,
  TranscriptsMigrationPlan,
  TranscriptsMigrationProject,
  TranscriptsMigrationResult,
  TranscriptsMigrationState,
} from "./types";

function row(
  sessionId: string,
  state: TranscriptsMigrationState,
  defaultSelected: boolean,
): TranscriptsMigrationChat {
  return {
    sessionId,
    state,
    defaultSelected,
    own: { path: `/p/.chats/${sessionId}.jsonl`, sizeBytes: 100, mtime: "2026-08-01T00:00:00.000Z" },
    extras: [],
  };
}

function project(
  slug: string,
  chats: TranscriptsMigrationChat[],
  projectExtras: string[] = [],
): TranscriptsMigrationProject {
  return {
    slug,
    name: slug || "Root",
    chatsDir: `/p/${slug}/.chats`,
    hostStore: `/home/u/.claude/projects/-p-${slug}`,
    preserveDir: `/p/${slug}/.chats-pre-migration`,
    chats,
    projectExtras,
  };
}

function plan(over: Partial<TranscriptsMigrationPlan> = {}): TranscriptsMigrationPlan {
  return {
    mode: "own",
    configPath: "/etc/paddock.config.yaml",
    configVersion: "abc123",
    projects: [
      project("alpha", [
        row("s-new", "new", true),
        row("s-ff", "fast-forward", true),
        row("s-div", "diverged", false),
      ]),
      project("beta", [row("s-unknown", "unknown", false)]),
    ],
    sweepers: { stores: 0, chats: 0 },
    totals: {
      chats: 4,
      new: 1,
      fastForward: 1,
      diverged: 1,
      unknown: 1,
      identical: 0,
      defaultSelected: 2,
    },
    scanBudgetExhausted: false,
    warnings: [],
    ...over,
  };
}

describe("initialSelection", () => {
  it("takes the server's defaultSelected verbatim, so diverged rows start unticked", () => {
    // #882's rule: new and fast-forward are lossless and start checked;
    // diverged and unknown are a real choice and must be made deliberately.
    expect([...initialSelection(plan())].sort()).toEqual(["s-ff", "s-new"]);
  });

  it("trusts defaultSelected even for a state this build does not recognise", () => {
    // The safety property. If a future server adds a state and the client
    // re-derived the rule from `state` instead, the unknown value would fall
    // through whatever the default branch is — and the unsafe direction here is
    // "ticked", which merges a chat nobody chose to merge.
    const p = plan({ projects: [project("alpha", [row("s-weird", "hyper-diverged", false)])] });
    expect([...initialSelection(p)]).toEqual([]);
  });
});

describe("buildMigrationRequest", () => {
  it("sends plannedSessionIds covering every row, ticked or not", () => {
    const p = plan();
    const req = buildMigrationRequest(p, new Set(["s-new"]));
    expect(req.sessionIds).toEqual(["s-new"]);
    // Without this the server cannot distinguish "unticked" from "created after
    // the plan was rendered", and `unplanned[]` is silently always empty.
    expect(req.plannedSessionIds).toEqual(["s-new", "s-ff", "s-div", "s-unknown"]);
  });

  it("echoes configVersion as expectedVersion so a concurrent edit is a 409", () => {
    expect(buildMigrationRequest(plan(), new Set()).expectedVersion).toBe("abc123");
  });

  it("keeps expectedVersion as null rather than dropping the key", () => {
    // The server tests `hasOwnProperty`: a present-and-null value means "there
    // was no config file when I built this plan and there still must not be",
    // while an ABSENT key means "write unconditionally". `JSON.stringify` drops
    // `undefined` and keeps `null`, so this must never become undefined.
    const req = buildMigrationRequest(plan({ configVersion: null }), new Set());
    expect(req.expectedVersion).toBeNull();
    expect(JSON.parse(JSON.stringify(req))).toHaveProperty("expectedVersion", null);
  });

  it("drops a selected id that is no longer in the plan", () => {
    // Otherwise it comes back in `ignoredSessionIds` and the completion screen
    // reports a skipped chat the user never had.
    const req = buildMigrationRequest(plan(), new Set(["s-new", "s-ghost"]));
    expect(req.sessionIds).toEqual(["s-new"]);
  });

  it("an empty selection is a legal request, not an empty-plan special case", () => {
    const req = buildMigrationRequest(plan(), new Set());
    expect(req.sessionIds).toEqual([]);
    expect(req.plannedSessionIds).toHaveLength(4);
  });
});

describe("selection mechanics", () => {
  it("toggles one row on and off", () => {
    expect([...toggleRow(new Set(), "a")]).toEqual(["a"]);
    expect([...toggleRow(new Set(["a"]), "a")]).toEqual([]);
  });

  it("selects and clears a whole project without touching its siblings", () => {
    const p = plan();
    const all = setProjectSelection(new Set(["s-unknown"]), p.projects[0], true);
    expect([...all].sort()).toEqual(["s-div", "s-ff", "s-new", "s-unknown"]);
    const cleared = setProjectSelection(all, p.projects[0], false);
    expect([...cleared]).toEqual(["s-unknown"]);
  });

  it("reports a project as indeterminate when only some rows are ticked", () => {
    const p = plan();
    expect(projectTally(p.projects[0], new Set(["s-new"]))).toMatchObject({
      selected: 1,
      total: 3,
      all: false,
      some: true,
    });
    expect(projectTally(p.projects[1], new Set())).toMatchObject({ all: false, some: false });
  });

  it("select-all covers every project", () => {
    expect(setAllSelection(plan(), true).size).toBe(4);
    expect(setAllSelection(plan(), false).size).toBe(0);
  });
});

describe("what moves with no row attached", () => {
  it("counts identical chats, project extras and sweeper transcripts", () => {
    // All three move regardless of the ticks, because the postcondition is that
    // `.chats/` ends up empty. A footer reading "2 of 4" beside a completion
    // screen reporting 20 moved things would look like a bug.
    const p = plan({
      projects: [project("alpha", [row("s-new", "new", true)], ["memory/", "agent-ab12.jsonl"])],
      sweepers: { stores: 2, chats: 9 },
      totals: { ...plan().totals, identical: 5 },
    });
    expect(silentlyMoving(p)).toEqual({
      identical: 5,
      projectExtras: 2,
      sweeperChats: 9,
      total: 16,
    });
  });
});

describe("planIsEmpty", () => {
  it("is false for a project whose .chats/ holds only agent memory", () => {
    // The case the probe's own contract calls out: eligible with zero chats.
    // Treating it as "nothing to migrate" dead-ends the user whose instance
    // most needs the flip.
    const p = plan({
      projects: [project("alpha", [], ["memory/"])],
      totals: { ...plan().totals, chats: 0 },
    });
    expect(planIsEmpty(p)).toBe(false);
  });

  it("is true only when there are no projects and no sweeper stores", () => {
    expect(planIsEmpty(plan({ projects: [], sweepers: { stores: 0, chats: 0 } }))).toBe(true);
    expect(planIsEmpty(plan({ projects: [], sweepers: { stores: 1, chats: 3 } }))).toBe(false);
  });
});

describe("migrationOutcome", () => {
  const base: TranscriptsMigrationResult = {
    ok: true,
    alreadyMigrated: false,
    dryRun: false,
    projects: [],
    migrated: ["a"],
    preserved: [],
    unplanned: [],
    ignoredSessionIds: [],
    failed: [],
    sweepers: { stores: 0, chats: 0 },
    warnings: [],
    configWritten: true,
    configPath: "/etc/paddock.config.yaml",
    restartRequired: true,
  };

  it("calls a 200 with a non-empty failed[] a PARTIAL, never done", () => {
    // The config was not written and the instance is still on `own`. A green
    // tick here is how someone restarts into a half-empty `.chats/` and
    // concludes Paddock lost their chats.
    const partial = {
      ...base,
      ok: false,
      configWritten: false,
      failed: [{ sessionId: "x", slug: "alpha", reason: "move-failed" }],
    };
    expect(migrationOutcome(partial)).toBe("partial");
  });

  it("treats ok:false as partial even with an empty failed[]", () => {
    expect(migrationOutcome({ ...base, ok: false })).toBe("partial");
  });

  it("recognises the idempotent repeat", () => {
    expect(
      migrationOutcome({ ...base, alreadyMigrated: true, migrated: [], configWritten: false }),
    ).toBe("already");
  });

  it("is done for a clean run", () => {
    expect(migrationOutcome(base)).toBe("done");
  });
});

describe("groupPreserved", () => {
  it("groups by project and keeps every entry", () => {
    const groups = groupPreserved([
      { sessionId: "a", slug: "alpha", side: "own", path: "/p/a", reason: "unchecked" },
      { sessionId: "b", slug: "beta", side: "host", path: "/p/b", reason: "superseded" },
      { sessionId: "c", slug: "alpha", side: "own", path: "/p/c", reason: "identical" },
    ]);
    expect(groups.map((g) => g.slug)).toEqual(["alpha", "beta"]);
    expect(groups[0].items).toHaveLength(2);
    // Nothing is collapsed or truncated: this array IS the recovery path.
    expect(groups.flatMap((g) => g.items)).toHaveLength(3);
  });
});

describe("stateCopy", () => {
  it("never describes an unticked row as a loss", () => {
    for (const state of ["new", "fast-forward", "diverged", "unknown"] as const) {
      const { hint } = stateCopy(state);
      expect(hint).not.toMatch(/delete|discard|remove|lost|erase/i);
    }
  });

  it("renders an unrecognised state verbatim instead of swallowing it", () => {
    expect(stateCopy("time-travelled").label).toBe("time-travelled");
  });
});

describe("allRows", () => {
  it("flattens in render order and tolerates a null plan", () => {
    expect(allRows(plan()).map((r) => r.sessionId)).toEqual([
      "s-new",
      "s-ff",
      "s-div",
      "s-unknown",
    ]);
    expect(allRows(null)).toEqual([]);
  });
});
