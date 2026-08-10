import type { DiscoverCandidate, DiscoverSessions } from "./types";

/**
 * The selection model behind the Discover table (#745) — pure, so the tri-state
 * and lazy-load rules are testable without a DOM.
 *
 * ## Why tri-state, and why it is not just "some children ticked"
 *
 * A row's conversations are loaded LAZILY: the listing carries only a count, and
 * `GET /api/discover/sessions` is issued when the expander opens. So a ticked row
 * has two genuinely different meanings depending on whether it has been opened —
 * "import all of this directory, whatever is in it" before, and "import exactly
 * these ids" after — and the checkbox has to be honest about both without ever
 * showing indeterminate for a row nobody has looked at.
 *
 * That is the whole reason {@link RowState.sessions} being `undefined` is load
 * bearing rather than an implementation detail: it is what separates "no
 * per-session opinion has been expressed" from "every session was unticked".
 * The second is a row the user has said no to; the first is the default yes.
 *
 * ## What that means on the wire
 *
 * `POST …/adopt-chats` takes `sessionIds` for a subset and imports EVERYTHING on
 * offer when it is omitted. Those map exactly onto the two states, which is why
 * {@link importPlan} returns an optional id list rather than always materialising
 * one: an unopened row genuinely means "all of it", including any session that
 * appeared between the scan and the submit.
 */

/** A row's checkbox, including the indeterminate state a native box needs told. */
export type RowTick = "on" | "off" | "mixed";

/** Everything the table knows about one candidate directory. */
export interface RowState {
  /**
   * The row-level tick. Authoritative while {@link sessions} is absent; once the
   * row is loaded it is DERIVED (kept equal to "at least one session ticked") so
   * the two can never disagree.
   */
  checked: boolean;
  expanded: boolean;
  /** A `GET …/discover/sessions` is in flight. */
  loading: boolean;
  /** That fetch failed. The row stays ticked — the failure is about the preview,
   *  not about whether the user wants the directory. */
  error: string | null;
  /** The loaded sessions. `undefined` until the row has been expanded once. */
  sessions?: DiscoverSessions;
  /** Ticked session ids. Only meaningful alongside {@link sessions}. */
  selected?: Set<string>;
}

/** Every row, keyed by {@link DiscoverCandidate.path}. */
export type RowStates = Record<string, RowState>;

/**
 * The initial state for a scan: everything ticked, nothing expanded, nothing
 * loaded.
 *
 * Ticked-by-default is the same call `AdoptChatsModal` made and for the same
 * reason — the common case really is "yes, all of it", and a screen that opens
 * with an empty selection makes the user do clerical work to reach the answer
 * they already had.
 */
export function initialRows(candidates: DiscoverCandidate[]): RowStates {
  const out: RowStates = {};
  for (const c of candidates) {
    out[c.path] = { checked: true, expanded: false, loading: false, error: null };
  }
  return out;
}

/** How a row's checkbox should render. */
export function rowTick(row: RowState): RowTick {
  // Unopened: the row-level tick is the only opinion there is, so it is never
  // indeterminate. Showing "mixed" for a row whose contents nobody has seen
  // would be inventing a distinction the user has not made.
  if (!row.sessions || !row.selected) return row.checked ? "on" : "off";
  const total = row.sessions.sessions.length;
  const n = row.selected.size;
  if (total === 0 || n === 0) return "off";
  return n === total ? "on" : "mixed";
}

/** How many conversations this row would import as currently ticked. */
export function rowSelectedCount(row: RowState, candidate: DiscoverCandidate): number {
  if (row.sessions && row.selected) return row.selected.size;
  return row.checked ? candidate.sessionCount : 0;
}

/** The number across the whole table, for the submit button's label. */
export function totalSelected(rows: RowStates, candidates: DiscoverCandidate[]): number {
  return candidates.reduce((n, c) => n + rowSelectedCount(rows[c.path] ?? blank(), c), 0);
}

/** The rows that would actually be imported, in listing order. */
export function selectedCandidates(
  rows: RowStates,
  candidates: DiscoverCandidate[],
): DiscoverCandidate[] {
  return candidates.filter((c) => rowSelectedCount(rows[c.path] ?? blank(), c) > 0);
}

/**
 * Toggle a whole row.
 *
 * Cascades onto the loaded sessions when there are any — a parent box that ticks
 * without ticking its visible children is the retrofit this model exists to
 * avoid.
 */
export function setRowChecked(rows: RowStates, path: string, on: boolean): RowStates {
  const row = rows[path];
  if (!row) return rows;
  const next: RowState = { ...row, checked: on };
  if (row.sessions) {
    next.selected = on ? new Set(row.sessions.sessions.map((s) => s.sessionId)) : new Set();
  }
  return { ...rows, [path]: next };
}

/** Toggle one conversation inside an expanded row, re-deriving the row's tick. */
export function toggleSession(rows: RowStates, path: string, sessionId: string): RowStates {
  const row = rows[path];
  if (!row || !row.sessions) return rows;
  const selected = new Set(row.selected ?? []);
  if (!selected.delete(sessionId)) selected.add(sessionId);
  return { ...rows, [path]: { ...row, selected, checked: selected.size > 0 } };
}

/**
 * Fold a loaded session list into a row.
 *
 * The rule that matters: a row ticked before it was opened stays "all of it", so
 * the arriving ids are all selected. A row the user had UNticked must not have
 * its answer overwritten by an expansion — opening something to look at it is
 * not consent to import it.
 */
export function applySessions(
  rows: RowStates,
  path: string,
  sessions: DiscoverSessions,
): RowStates {
  const row = rows[path];
  if (!row) return rows;
  const selected = row.checked
    ? new Set(sessions.sessions.map((s) => s.sessionId))
    : new Set<string>();
  return { ...rows, [path]: { ...row, sessions, selected, loading: false, error: null } };
}

/** Patch one row (expansion, in-flight, load failure). */
export function patchRow(rows: RowStates, path: string, patch: Partial<RowState>): RowStates {
  const row = rows[path];
  if (!row) return rows;
  return { ...rows, [path]: { ...row, ...patch } };
}

/**
 * What to send for this row, or `null` for a row that is not being imported.
 *
 * `sessionIds` is present only for a row whose sessions were loaded — see the
 * module docstring: omitting it is the wire's own way of saying "everything on
 * offer", which is precisely what an unopened ticked row means.
 */
export function importPlan(row: RowState | undefined, candidate: DiscoverCandidate):
  | { sessionIds?: string[] }
  | null {
  const state = row ?? blank();
  if (rowSelectedCount(state, candidate) === 0) return null;
  if (state.sessions && state.selected) return { sessionIds: [...state.selected] };
  return {};
}

/** A row for a candidate the state map somehow lacks — unticked, so inert. */
function blank(): RowState {
  return { checked: false, expanded: false, loading: false, error: null };
}
