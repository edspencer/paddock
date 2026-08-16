/**
 * The pure half of #882's migration modal: what is selected, what that means,
 * and exactly what gets POSTed.
 *
 * Split out of the component for the same reason `discoverSelection.ts` is —
 * the selection rules are the part with real consequences (a mis-built request
 * body moves the wrong files) and they are much easier to pin down in a unit
 * test than through a rendered table.
 */
import type {
  TranscriptsMigrationChat,
  TranscriptsMigrationPlan,
  TranscriptsMigrationPreserved,
  TranscriptsMigrationProject,
  TranscriptsMigrationRequest,
  TranscriptsMigrationResult,
  TranscriptsMigrationState,
} from "./types";

/** Every row in the plan, flattened, in the order the table renders them. */
export function allRows(plan: TranscriptsMigrationPlan | null): TranscriptsMigrationChat[] {
  return (plan?.projects ?? []).flatMap((p) => p.chats);
}

/**
 * The initial tick state: whatever the server said.
 *
 * Deliberately `defaultSelected` rather than a client-side rule over `state`.
 * The server owns the policy (new + fast-forward checked, diverged + unknown
 * unchecked, because a diverged row is a real choice and must be made
 * deliberately), and re-deriving it here would mean an `unknown` state from a
 * newer server silently landing on the wrong — unsafe — default.
 */
export function initialSelection(plan: TranscriptsMigrationPlan | null): Set<string> {
  return new Set(allRows(plan).filter((c) => c.defaultSelected).map((c) => c.sessionId));
}

/** How many of a project's rows are ticked. Drives its header checkbox. */
export function projectTally(
  project: TranscriptsMigrationProject,
  selected: ReadonlySet<string>,
): { selected: number; total: number; all: boolean; some: boolean } {
  const total = project.chats.length;
  const n = project.chats.reduce((acc, c) => acc + (selected.has(c.sessionId) ? 1 : 0), 0);
  return { selected: n, total, all: total > 0 && n === total, some: n > 0 && n < total };
}

/** Add or remove every row of one project. */
export function setProjectSelection(
  selected: ReadonlySet<string>,
  project: TranscriptsMigrationProject,
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const c of project.chats) {
    if (on) next.add(c.sessionId);
    else next.delete(c.sessionId);
  }
  return next;
}

/** Add or remove every row in the plan. */
export function setAllSelection(
  plan: TranscriptsMigrationPlan | null,
  on: boolean,
): Set<string> {
  return on ? new Set(allRows(plan).map((c) => c.sessionId)) : new Set();
}

export function toggleRow(selected: ReadonlySet<string>, sessionId: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(sessionId)) next.add(sessionId);
  return next;
}

/**
 * The request body.
 *
 * Two fields here are the difference between this working and quietly not:
 *
 * **`plannedSessionIds`** — every id the user was *shown*, ticked or not.
 * Without it the server cannot tell "a chat created between preview and submit"
 * from "a chat the user deliberately unticked": both are on disk and absent
 * from `sessionIds`. Omit it and `unplanned[]` comes back empty every time, so
 * the completion screen's promise that nothing moved unannounced quietly stops
 * being true rather than visibly breaking. (#901 added the field for exactly
 * this; it is optional server-side, which is what makes forgetting it silent.)
 *
 * **`expectedVersion`** — always sent, *including* when it is `null`. The
 * server tests `hasOwnProperty`, so a present-and-null property means "the
 * config file did not exist when I built this plan, and it still must not" —
 * a genuinely different request from omitting the key, which writes
 * unconditionally. `JSON.stringify` drops `undefined` and keeps `null`, so
 * this distinction survives the wire only if the value is never `undefined`.
 */
export function buildMigrationRequest(
  plan: TranscriptsMigrationPlan,
  selected: ReadonlySet<string>,
): TranscriptsMigrationRequest {
  const planned = allRows(plan).map((c) => c.sessionId);
  return {
    // Intersected with the plan rather than sent raw: a stale id left in the
    // set by a re-fetch would come back in `ignoredSessionIds` and read as an
    // error the user cannot act on.
    sessionIds: planned.filter((id) => selected.has(id)),
    plannedSessionIds: planned,
    expectedVersion: plan.configVersion,
  };
}

/**
 * How many chats move into `~/.claude`, counting the ones with no row.
 *
 * `totals.chats` counts *rows*, and rows are only the chats with a decision
 * attached: chats identical on both sides are omitted entirely, and
 * `projectExtras` (agent `memory/`, flat `agent-<hex>.jsonl`) never had one.
 * They all still move, because the postcondition is that `.chats/` ends up
 * empty. A footer reading "3 of 3 selected" next to a completion screen that
 * moved 40 things would look like a bug in exactly the place the user is
 * deciding whether to trust this.
 */
export function silentlyMoving(plan: TranscriptsMigrationPlan | null): {
  identical: number;
  projectExtras: number;
  sweeperChats: number;
  total: number;
} {
  const identical = plan?.totals.identical ?? 0;
  const projectExtras = (plan?.projects ?? []).reduce((n, p) => n + p.projectExtras.length, 0);
  const sweeperChats = plan?.sweepers.chats ?? 0;
  return {
    identical,
    projectExtras,
    sweeperChats,
    total: identical + projectExtras + sweeperChats,
  };
}

/**
 * Whether the plan has anything at all to do.
 *
 * Note this is NOT `totals.chats === 0`: a project whose `.chats/` holds only
 * an agent `memory/` directory has zero rows and real work, and it is the case
 * the probe's own contract calls out (`eligible: true`, `pendingChats: 0`).
 * Treating it as "nothing to migrate" would dead-end the one user whose
 * instance most needs the flip.
 */
export function planIsEmpty(plan: TranscriptsMigrationPlan | null): boolean {
  if (!plan) return false;
  return plan.projects.length === 0 && plan.sweepers.stores === 0;
}

/**
 * Did this actually finish?
 *
 * `ok` is the server's own answer and is the one to render, but it is worth
 * saying out loud what makes it false, because a 200 with `failed[]` is a
 * PARTIAL migration: the config was not written, the instance is still on
 * `own`, and the completion screen must not say "done".
 */
export function migrationOutcome(
  result: TranscriptsMigrationResult,
): "done" | "already" | "partial" | "nothing" {
  if (result.failed.length > 0 || !result.ok) return "partial";
  if (result.alreadyMigrated) return "already";
  if (result.migrated.length === 0 && result.preserved.length === 0) return "nothing";
  return "done";
}

/** Preserved copies grouped by project, for the completion screen's recovery list. */
export function groupPreserved(
  items: TranscriptsMigrationPreserved[],
): Array<{ slug: string; items: TranscriptsMigrationPreserved[] }> {
  const by = new Map<string, TranscriptsMigrationPreserved[]>();
  for (const item of items) {
    const bucket = by.get(item.slug);
    if (bucket) bucket.push(item);
    else by.set(item.slug, [item]);
  }
  return [...by.entries()].map(([slug, list]) => ({ slug, items: list }));
}

/**
 * The one-line explanation of what a row's state means for the user's files.
 *
 * Phrased as an outcome ("both copies are kept") rather than as a
 * classification, and never as a loss. Nothing here is deleted, so no wording
 * may imply it — an unchecked row is preserved on disk, which is a different
 * thing from discarded and is the single most important thing this dialog has
 * to get across.
 */
export const STATE_COPY: Record<
  "new" | "fast-forward" | "diverged" | "unknown",
  { label: string; hint: string }
> = {
  new: {
    label: "New",
    hint: "Not in ~/.claude yet. Moving it in loses nothing.",
  },
  "fast-forward": {
    label: "Fast-forward",
    hint: "One copy is just a longer version of the other. Lossless either way.",
  },
  diverged: {
    label: "Diverged",
    hint: "Both copies have messages the other does not. Ticking keeps Paddock's copy in ~/.claude; the other is kept too, in the preserve folder.",
  },
  unknown: {
    // NOT "Unchecked". That was the first label, and driving the real dialog
    // showed why it is wrong: the summary strip renders it beside the tick
    // counts, where "3 unchecked" reads as "3 rows you have not ticked" — a
    // statement about the checkbox rather than about the comparison. It means
    // Paddock could not compare the two copies at all.
    label: "Not compared",
    hint: "Paddock ran out of scan budget before it could compare these two copies, so it has not assumed they are safe to merge.",
  },
};

/** Copy for a state, falling back sanely for a value this build has not heard of. */
export function stateCopy(state: TranscriptsMigrationState): { label: string; hint: string } {
  return (
    STATE_COPY[state as keyof typeof STATE_COPY] ?? {
      // Rendered verbatim rather than swallowed — the same rule the failure
      // reasons follow. A row Paddock cannot describe is still a row the user
      // must be able to see and decide about.
      label: String(state),
      hint: "This Paddock build does not recognise this state, so it is shown as the server described it.",
    }
  );
}
