import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import { relativeTime } from "../lib/format";
import { invalidateMigrationProbe } from "../lib/useMigrationOffer";
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
  shortenHome,
  silentlyMoving,
  stateCopy,
  toggleRow,
} from "../lib/migrationPlan";
import type {
  TranscriptsMigrationChat,
  TranscriptsMigrationFailure,
  TranscriptsMigrationPlan,
  TranscriptsMigrationProject,
  TranscriptsMigrationResult,
  TranscriptsMigrationSide,
  TranscriptsMigrationState,
  TranscriptsMigrationWarning,
} from "../lib/types";
import { Button, Callout, Checkbox, Chip, Dialog, type ChipTone } from "./ui";

/**
 * The `own → host` transcript migration, end to end (#882).
 *
 * Replaces #900's placeholder. #900 built the discovery path — the
 * `FleetReadout` chip and the Config card — and stopped at a dialog that
 * explained the migration and admitted it was not built. This is the built one:
 * the per-chat table, the POST, and the completion screen.
 *
 * ## Ed's spec, and what each half of it forced
 *
 * > *"a table with checkboxes and an indication on each row whether the chat is
 * > in conflict with the underlying `~/.claude` chat"*
 *
 * The rows are grouped by project because the *destination* is per project —
 * `~/.claude/projects/<encoded-workingDir>/` — so a flat list would show two
 * chats with the same classification heading for different stores with no way
 * to tell. The group header carries the destination path for that reason.
 *
 * Rows start ticked from the server's `defaultSelected`, never from a rule
 * re-derived here: `new` and `fast-forward` are lossless and start checked,
 * `diverged` and `unknown` start UNCHECKED because a diverged row is a real
 * choice and #882 requires it be made deliberately. Re-deriving that client-side
 * would mean a state a future server adds silently landing on the unsafe
 * default.
 *
 * > *"once the user has clicked the Submit button they should not have to take
 * > any other action except wait."*
 *
 * So there is no per-project confirm, no second "are you sure", and no
 * client-driven fan-out of N requests. One POST, one response. The only thing
 * that can put the user back in the driver's seat is a **refusal** — and those
 * are the states this file spends most of its length on, because all four of
 * them mean *nothing moved*, which is the one fact that makes them recoverable
 * rather than frightening.
 *
 * ## The thing this dialog must never imply
 *
 * **Unchecked means preserved, not deleted.** An unticked chat is moved to
 * `.chats-pre-migration/` and stays on disk, and Ed settled that explicitly. So
 * there is no bin icon, no "discard", no red, and no count phrased as a loss
 * anywhere in here. The completion screen renders `preserved[]` **in full, with
 * absolute paths**, because that array is the recovery path: it is what turns
 * "nothing is deleted" from a claim the user has to trust into a promise they
 * can act on.
 *
 * ## Why it ends by asking for a restart
 *
 * `claude.transcripts` is read once at boot and frozen. The config write is the
 * migration's commit point and lands last, so between the response and the
 * restart the running process is still resolving `own` against a `.chats/` that
 * has just been emptied — and the chat list is **blank**. That is expected, it
 * is transient, and a user who is not told will conclude the migration ate their
 * history. Saying so is not a nicety; it is the difference between a successful
 * migration and a support incident.
 */
export function MigrationDialog({
  open,
  onClose,
  onCompleted,
}: {
  open: boolean;
  onClose: () => void;
  /** Fired once, after a fully successful migration, so the offer can stop
   *  advertising work that is done. Not fired on a partial failure — there is
   *  still a migration pending in that case. */
  onCompleted?: () => void;
}) {
  const [plan, setPlan] = useState<TranscriptsMigrationPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [decisionsOnly, setDecisionsOnly] = useState(false);
  // Guards the double-submit that a fast second click would otherwise send. The
  // server's single-flight latch catches it too and answers 409
  // `migration_in_progress`, but showing the user a scary refusal for their own
  // double-click would be our bug reported as theirs.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const next = await api.transcriptsMigrationChats();
      setPlan(next);
      setSelected(initialSelection(next));
      setPhase({ kind: "plan" });
    } catch (e) {
      setPhase({ kind: "load-failed", message: messageOf(e) });
    }
  }, []);

  // Re-fetched on every OPEN rather than cached. The plan is a snapshot of two
  // directory trees and it is the basis of a file-moving decision; a stale one
  // shown after the user has been away is worse than a second's wait. It is also
  // what makes the `config_conflict` recovery a plain re-open.
  useEffect(() => {
    if (!open) return;
    setDecisionsOnly(false);
    void load();
  }, [open, load]);

  const rows = useMemo(() => allRows(plan), [plan]);
  const alsoMoving = useMemo(() => silentlyMoving(plan), [plan]);
  const selectedCount = useMemo(
    () => rows.reduce((n, r) => n + (selected.has(r.sessionId) ? 1 : 0), 0),
    [rows, selected],
  );
  const decisionCount = useMemo(() => rows.filter(needsDecision).length, [rows]);

  const submit = useCallback(async () => {
    if (!plan || inFlight.current) return;
    inFlight.current = true;
    setPhase({ kind: "running" });
    try {
      const result = await api.runTranscriptsMigration(buildMigrationRequest(plan, selected));
      // The probe is memoised for the lifetime of the page and #900 exported
      // this for exactly one caller: the flow that has just made its answer
      // wrong. Dropped even on a partial failure — the next probe will
      // correctly still report a pending migration, and a cache that survives
      // a *successful* one is a banner offering work that is done.
      invalidateMigrationProbe();
      setPhase({ kind: "result", result });
      if (result.ok) onCompleted?.();
    } catch (e) {
      // Every refusal path lands here, and every one of them means NOTHING
      // MOVED — the server's ordering puts all three 409s and both 400s before
      // the first rename. The plan is kept so "Try again" is one click.
      setPhase({ kind: "refused", error: e });
    } finally {
      inFlight.current = false;
    }
  }, [plan, selected, onCompleted]);

  const running = phase.kind === "running";

  return (
    <Dialogish
      open={open}
      // A backdrop click during the POST would hide a running file migration
      // behind the app. The request keeps going either way — this is a modal
      // over a synchronous server operation, not a cancel button.
      onClose={running ? () => {} : onClose}
      dismissOnBackdrop={!running}
      // Outcome-aware, not merely "did the request come back". The first cut
      // said "— done" for every result, so a PARTIAL migration was headed
      // "done" directly above a body explaining it had not finished — the exact
      // contradiction the completion screen exists to avoid. Found by driving a
      // real partial failure, not by a test.
      title={dialogTitle(phase)}
      footer={
        <MigrationFooter
          phase={phase}
          plan={plan}
          rows={rows}
          selectedCount={selectedCount}
          alsoMoving={alsoMoving.total}
          onClose={onClose}
          onRetry={submit}
          onReload={load}
          onSubmit={submit}
        />
      }
    >
      {phase.kind === "loading" && (
        <p className="py-8 text-center text-sm text-fg-muted">
          Comparing this instance's chats with your <Mono>~/.claude</Mono>…
        </p>
      )}

      {phase.kind === "load-failed" && (
        <Callout tone="danger" className="text-sm">
          <p className="font-semibold">Could not read the migration plan.</p>
          <p className="mt-1">{phase.message}</p>
          <p className="mt-1 text-xs">Nothing has been moved.</p>
        </Callout>
      )}

      {phase.kind === "running" && <RunningPanel plan={plan} count={selectedCount} />}

      {phase.kind === "refused" && (
        <RefusalPanel error={phase.error} plan={plan} rows={rows} selected={selected} />
      )}

      {phase.kind === "result" && <ResultPanel result={phase.result} />}

      {phase.kind === "plan" && plan && (
        <PlanPanel
          plan={plan}
          rows={rows}
          selected={selected}
          setSelected={setSelected}
          decisionsOnly={decisionsOnly}
          setDecisionsOnly={setDecisionsOnly}
          decisionCount={decisionCount}
          alsoMoving={alsoMoving}
        />
      )}
    </Dialogish>
  );
}

/* -------------------------------------------------------------------------- */
/* phases                                                                      */
/* -------------------------------------------------------------------------- */

type Phase =
  | { kind: "loading" }
  | { kind: "load-failed"; message: string }
  | { kind: "plan" }
  | { kind: "running" }
  | { kind: "refused"; error: unknown }
  | { kind: "result"; result: TranscriptsMigrationResult };

/* -------------------------------------------------------------------------- */
/* the plan                                                                    */
/* -------------------------------------------------------------------------- */

function PlanPanel({
  plan,
  rows,
  selected,
  setSelected,
  decisionsOnly,
  setDecisionsOnly,
  decisionCount,
  alsoMoving,
}: {
  plan: TranscriptsMigrationPlan;
  rows: TranscriptsMigrationChat[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  decisionsOnly: boolean;
  setDecisionsOnly: (b: boolean) => void;
  decisionCount: number;
  alsoMoving: ReturnType<typeof silentlyMoving>;
}) {
  if (planIsEmpty(plan)) {
    return (
      <div className="py-6 text-sm text-fg-muted">
        <p className="font-semibold text-fg">Nothing to move.</p>
        <p className="mt-1">
          Every project's <Mono>.chats/</Mono> is already empty, so there is nothing to merge
          into your <Mono>~/.claude</Mono>.
        </p>
      </div>
    );
  }

  const everythingOn = rows.length > 0 && rows.every((r) => selected.has(r.sessionId));

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        Ticked chats move into <Mono>~/.claude</Mono>.{" "}
        <strong className="font-semibold text-fg">Unticked chats are not deleted</strong> — they
        are set aside in <Mono>.chats-pre-migration/</Mono>.
      </p>

      {plan.scanBudgetExhausted && (
        <Callout tone="warn" className="text-xs">
          <p className="font-semibold">
            {plan.totals.unknown.toLocaleString()}{" "}
            {plan.totals.unknown === 1 ? "chat was" : "chats were"} not compared.
          </p>
          <p className="mt-1">
            Comparing two copies of a chat means reading both in full, and this instance has
            more of them than one pass is allowed to read. Those rows are marked{" "}
            <em>Not compared</em> and start unticked — Paddock will not assume a chat is safe
            to merge when it has not looked. Ticking one keeps Paddock's copy and preserves the
            other; leaving it does the reverse. Nothing is lost either way.
          </p>
        </Callout>
      )}

      {plan.warnings.length > 0 && <WarningList warnings={plan.warnings} />}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge pb-2">
        <Checkbox
          checked={everythingOn}
          indeterminate={!everythingOn && selected.size > 0}
          onChange={() => setSelected(setAllSelection(plan, !everythingOn))}
          label={<span className="text-xs">Select all</span>}
        />
        <span className="flex flex-wrap items-center gap-1">
          <StateChip state="new" n={plan.totals.new} />
          <StateChip state="fast-forward" n={plan.totals.fastForward} />
          <StateChip state="diverged" n={plan.totals.diverged} />
          <StateChip state="unknown" n={plan.totals.unknown} />
        </span>
        {decisionCount > 0 && (
          <button
            type="button"
            onClick={() => setDecisionsOnly(!decisionsOnly)}
            className="focus-visible:focus-ring ml-auto rounded text-xs text-fg-muted underline underline-offset-2 can-hover:hover:text-fg"
          >
            {decisionsOnly
              ? "Show all chats"
              : `Only the ${decisionCount.toLocaleString()} needing a decision`}
          </button>
        )}
      </div>

      <ul className="space-y-4">
        {plan.projects.map((project) => (
          <ProjectGroup
            key={project.slug}
            project={project}
            selected={selected}
            setSelected={setSelected}
            decisionsOnly={decisionsOnly}
          />
        ))}
      </ul>

      {alsoMoving.total > 0 && <AlsoMoving alsoMoving={alsoMoving} />}
    </div>
  );
}

/**
 * The rest of what moves — stated up front rather than discovered on the
 * completion screen.
 *
 * `totals.chats` counts *rows*, and a row is only a chat with a decision
 * attached. Chats byte-identical on both sides have no decision to offer so
 * they are omitted; `projectExtras` (an agent `memory/` directory, flat
 * `agent-<hex>.jsonl` sidechains) never had one; sweeper transcripts are
 * internal curation runs that #882 ruled migrate silently with their project.
 * All of them move regardless of what is ticked, because the postcondition is
 * that `.chats/` ends up **empty** — the redirect symlink is not planted
 * otherwise and the project ends up half-blind (#708).
 *
 * So a footer reading "3 of 3 selected" against a completion screen reporting
 * forty moved things would look exactly like a bug, in the one place the user
 * is deciding whether to trust this. Cheaper to say it now.
 */
function AlsoMoving({ alsoMoving }: { alsoMoving: ReturnType<typeof silentlyMoving> }) {
  const [open, setOpen] = useState(false);

  const parts: string[] = [];
  if (alsoMoving.identical > 0)
    parts.push(
      `${alsoMoving.identical.toLocaleString()} ${alsoMoving.identical === 1 ? "chat that is" : "chats that are"} already identical in both places`,
    );
  if (alsoMoving.projectExtras > 0)
    parts.push(
      `${alsoMoving.projectExtras.toLocaleString()} project ${alsoMoving.projectExtras === 1 ? "file" : "files"} such as agent memory`,
    );
  if (alsoMoving.sweeperChats > 0)
    parts.push(`${alsoMoving.sweeperChats.toLocaleString()} internal sweeper transcripts`);

  return (
    <div className="border-t border-edge pt-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="focus-visible:focus-ring flex w-full items-center gap-1.5 rounded text-left text-xs text-fg-muted can-hover:hover:text-fg"
      >
        <Caret open={open} />
        <span>
          Also moving: <span className="text-fg">{summariseAlsoMoving(alsoMoving)}</span>
        </span>
      </button>

      {open && (
        <p className="mt-1.5 pl-5 text-xs text-fg-muted">
          {joinList(parts)}. These have no decision attached — Paddock's copy of an identical
          chat is set aside rather than deleted, and the rest have no counterpart to conflict
          with. <Mono>.chats/</Mono> has to end up completely empty for the switch to take
          effect.
        </p>
      )}
    </div>
  );
}

/**
 * The collapsed line: counts only, no prose.
 *
 * Deliberately terse — "+28 chats, +19 sweepers" answers "will the completion
 * screen's number match this one?", which is the only reason this row exists.
 * The *why* is one click away and stays there, because a user who has read it
 * once does not need it on every subsequent visit.
 *
 * Identical chats and project extras are both counted as "chats" here rather
 * than split three ways: at a glance they are the same fact ("things moving that
 * you were not asked about"), and the expanded text is where the distinction
 * lives.
 */
function summariseAlsoMoving(alsoMoving: ReturnType<typeof silentlyMoving>): string {
  const bits: string[] = [];
  const chats = alsoMoving.identical + alsoMoving.projectExtras;
  if (chats > 0) bits.push(`+${chats.toLocaleString()} ${chats === 1 ? "chat" : "chats"}`);
  if (alsoMoving.sweeperChats > 0)
    bits.push(`+${alsoMoving.sweeperChats.toLocaleString()} sweeper`);
  return bits.join(", ");
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={cxLocal(
        "h-3 w-3 shrink-0 transition-transform duration-fast",
        open && "rotate-90",
      )}
    >
      <path d="M4 2.5 8 6l-4 3.5z" fill="currentColor" />
    </svg>
  );
}

function ProjectGroup({
  project,
  selected,
  setSelected,
  decisionsOnly,
}: {
  project: TranscriptsMigrationProject;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  decisionsOnly: boolean;
}) {
  const visible = decisionsOnly ? project.chats.filter(needsDecision) : project.chats;
  // The header checkbox acts on what is on screen. With the filter on, a "select
  // all" that also ticked rows the user cannot see would be the exact opposite
  // of the deliberate choice this table exists to collect.
  const scope = useMemo(() => ({ ...project, chats: visible }), [project, visible]);
  const tally = projectTally(scope, selected);

  if (visible.length === 0 && project.projectExtras.length === 0) return null;

  return (
    <li>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-fg">
            {project.name || "Root workspace"}
          </h3>
          {/* The destination. Two projects' rows look identical and go to
              different stores, and for a repo-backed project this is keyed on
              the CHECKOUT rather than the project dir — surprising enough that
              hiding it would be a trap. Shown home-relative; the absolute path
              is in the `title`. */}
          <p className="truncate font-mono text-2xs text-fg-subtle" title={project.hostStore}>
            → {shortenHome(project.hostStore)}
          </p>
          {/* Once per project, not once per row. It is the same path for every
              row in the group, and repeated under five diverged rows it read as
              five different warnings rather than one constant fact — while
              burying the comparison that the decision actually turns on. */}
          {visible.some(isConflicted) && (
            <p className="truncate font-mono text-2xs text-fg-subtle" title={project.preserveDir}>
              kept, not deleted → {project.preserveDir}
            </p>
          )}
        </div>
        {visible.length > 0 && (
          <Checkbox
            checked={tally.all}
            indeterminate={tally.some}
            onChange={() => setSelected(setProjectSelection(selected, scope, !tally.all))}
            label={
              <span className="whitespace-nowrap text-2xs text-fg-muted">
                {tally.selected} of {tally.total}
              </span>
            }
          />
        )}
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-edge px-3 py-2 text-xs text-fg-muted">
          No chats here need a decision — {project.projectExtras.length.toLocaleString()} project{" "}
          {project.projectExtras.length === 1 ? "file moves" : "files move"} with it anyway.
        </p>
      ) : (
        <ul className="space-y-1">
          {visible.map((chat) => (
            <ChatRow
              key={chat.sessionId}
              chat={chat}
              checked={selected.has(chat.sessionId)}
              onToggle={() => setSelected(toggleRow(selected, chat.sessionId))}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * One row.
 *
 * Not a `<table>`. The row's payload is a name, an id, a classification and —
 * on a diverged row — a two-sided comparison, which is four columns of very
 * different shapes; and Ed reads this app on a phone, where a four-column table
 * either scrolls sideways or truncates the thing the decision depends on. So it
 * is a list of labelled checkboxes that lays its columns out with flex-wrap:
 * one line per row at width, and a stack on a phone with nothing hidden. The
 * checkbox is inside the `<label>`, so the whole row is the hit target.
 */
function ChatRow({
  chat,
  checked,
  onToggle,
}: {
  chat: TranscriptsMigrationChat;
  checked: boolean;
  onToggle: () => void;
}) {
  const conflicted = chat.state === "diverged" || chat.state === "unknown";

  return (
    <li>
      <label
        // The id and the sidecar count are the only things tying a row to a
        // filename in the preserve list the completion screen prints, so they
        // stay reachable — but on hover, not on screen. On a real instance they
        // were two more lines of monospace per row that nobody reads until
        // something has already gone wrong.
        title={rowTitle(chat)}
        className={cxLocal(
          "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition",
          "can-hover:hover:bg-surface-hover",
          conflicted ? "border-warn-edge bg-warn-soft/30" : "border-edge",
        )}
      >
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent-solid)]"
          checked={checked}
          onChange={onToggle}
          aria-label={`Merge ${chat.name ?? chat.sessionId} into ~/.claude`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="min-w-0 truncate text-sm text-fg">
              {chat.name ?? <span className="font-mono text-xs">{chat.sessionId}</span>}
            </span>
            <StateChip state={chat.state} />
          </span>

          {/* Suppressed when it merely repeats the name. A chat that was never
              renamed takes its auto-name from its first user message, so on a
              real instance most rows would otherwise print the same sentence
              twice and push the id and the hint further down. */}
          {chat.preview && chat.preview !== chat.name && (
            <span className="mt-0.5 block truncate text-xs text-fg-muted">{chat.preview}</span>
          )}

          {/* No per-row hint line: `StateChip` already carries `stateCopy().hint`
              as its `title`, so the explanation is one hover away rather than
              repeated verbatim under every row. "Fast-forward" IS "one copy is
              a longer version of the other" — printing both said it twice. */}
          {conflicted && chat.host && <Comparison chat={chat} checked={checked} />}
        </span>
      </label>
    </li>
  );
}

/**
 * The two sides of a conflicted row, side by side.
 *
 * This is the "indication on each row whether the chat is in conflict" half of
 * #882 that a chip alone cannot carry: "diverged" tells the user there is a
 * decision, and only this tells them how to make it. #899 populates
 * `messageCount` / `lastMessageAt` on precisely these rows for precisely this
 * reason — they cost a full parse, so they are not on rows that need no
 * decision.
 *
 * Both are optional even here, because they are charged to the same scan budget
 * that produces `unknown`. When they are missing the row falls back to size and
 * mtime, which is weaker (mtime is explicitly not a proxy for activity, #863)
 * but is never absent — a comparison with a blank side would be worse than a
 * coarse one.
 */
function Comparison({ chat, checked }: { chat: TranscriptsMigrationChat; checked: boolean }) {
  if (!chat.host) return null;
  return (
    <span className="mt-1.5 grid grid-cols-1 gap-1 sm:grid-cols-2">
      <SideCard
        title="Paddock's copy"
        side={chat.own}
        wins={checked}
        note={checked ? "moves into ~/.claude" : "kept in the preserve folder"}
      />
      <SideCard
        title="Your ~/.claude copy"
        side={chat.host}
        wins={!checked}
        note={checked ? "moved aside, kept" : "stays where it is"}
      />
    </span>
  );
}

function SideCard({
  title,
  side,
  wins,
  note,
}: {
  title: string;
  side: TranscriptsMigrationSide;
  wins: boolean;
  note: string;
}) {
  return (
    <span
      className={cxLocal(
        "block rounded-md border px-2 py-1.5 text-2xs",
        wins ? "border-accent-edge bg-accent-soft" : "border-edge bg-surface",
      )}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-fg">{title}</span>
        {/* Never "will be deleted". The losing side is moved, not removed, and
            the note says where it goes. */}
        <span className={wins ? "text-accent" : "text-fg-muted"}>{note}</span>
      </span>
      <span className="mt-0.5 block text-fg-muted tabular">
        {side.messageCount !== undefined
          ? `${side.messageCount.toLocaleString()} ${side.messageCount === 1 ? "message" : "messages"}`
          : formatSize(side.sizeBytes)}
        {" · "}
        {side.lastMessageAt ? (
          <>last message {relativeTime(side.lastMessageAt)}</>
        ) : (
          /* Labelled as the file timestamp rather than passed off as activity —
             #863's whole point is that mtime is not one. */
          <>file touched {relativeTime(side.mtime)}</>
        )}
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* running                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * No progress bar.
 *
 * The POST is one synchronous request with no job id and no progress frames —
 * the design rejected both — so any bar here would be an animation pretending
 * to be a measurement. What the user gets instead is the actual sequence, so a
 * pause of a few seconds reads as "quiescing" rather than as "hung".
 */
function RunningPanel({ plan, count }: { plan: TranscriptsMigrationPlan | null; count: number }) {
  return (
    <div className="space-y-3 py-6">
      <p className="text-sm font-semibold text-fg">
        <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-accent-solid" />
        Merging {count.toLocaleString()} {count === 1 ? "chat" : "chats"}…
      </p>
      <ol className="ml-4 list-decimal space-y-1 text-xs text-fg-muted">
        <li>Stopping any turns that are still running.</li>
        <li>
          Moving transcripts into{" "}
          <Mono>{plan?.projects[0]?.hostStore.replace(/\/[^/]*$/, "/…") ?? "~/.claude"}</Mono>.
        </li>
        <li>
          Setting <Mono>claude.transcripts: host</Mono>.
        </li>
      </ol>
      <p className="text-xs text-fg-subtle">
        Please leave this open. Nothing is deleted at any point, and if this is interrupted the
        migration can simply be run again.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* refusals                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The four ways the server says no — and the one sentence they share.
 *
 * Every refusal in this endpoint happens *before* the first rename: the
 * single-flight latch, the `expectedVersion` check and the quiesce all run
 * ahead of the mover, and both 400s are argument validation. So **nothing
 * moved** is true of all of them, and it is the first thing each one says. A
 * user who has just been refused mid-way through a file migration needs to know
 * the filesystem is untouched before they need to know why.
 *
 * Telling them apart needs the error body's `code`, which the client used to
 * throw away — see `ApiError.code`. Matching on the prose would have broken the
 * first time someone improved a message.
 */
function RefusalPanel({
  error,
  plan,
  rows,
  selected,
}: {
  error: unknown;
  plan: TranscriptsMigrationPlan | null;
  rows: TranscriptsMigrationChat[];
  selected: Set<string>;
}) {
  const code = error instanceof ApiError ? error.code : undefined;
  const stuck = stuckSessionIds(error);
  const nameFor = (id: string) => rows.find((r) => r.sessionId === id)?.name ?? id;

  return (
    <div className="space-y-3">
      <Callout tone={code === "env_shadowed" ? "danger" : "warn"} className="text-sm">
        <p className="font-semibold">{REFUSAL_TITLE[code ?? ""] ?? "The migration did not run."}</p>
        <p className="mt-1 text-fg">
          <strong className="font-semibold">Nothing was moved.</strong> Every one of these checks
          runs before the first file is touched, so your chats are exactly where they were.
        </p>
        <p className="mt-1.5 text-xs">{messageOf(error)}</p>
      </Callout>

      {code === "turn_running" && stuck.length > 0 && (
        <div className="text-xs text-fg-muted">
          <p className="font-semibold text-fg">Still running:</p>
          <ul className="mt-1 space-y-0.5">
            {stuck.map((id) => (
              <li key={id} className="break-all">
                <span className="text-fg">{nameFor(id)}</span>{" "}
                <span className="font-mono text-2xs text-fg-subtle">{id}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5">
            A chat mid-turn is still writing to its transcript, so moving it would race the
            write. Wait for it to finish — or stop it from its own chat screen — then try again.
            One chat left behind would leave that project's <Mono>.chats/</Mono> non-empty, which
            is why the whole migration refuses rather than skipping it.
          </p>
        </div>
      )}

      {code === "config_conflict" && (
        <p className="text-xs text-fg-muted">
          Something else edited <Mono>{plan?.configPath ?? "paddock.config.yaml"}</Mono> after this
          plan was built — another tab, or an editor. Reload the plan so your choices are made
          against the current file, then submit again.
        </p>
      )}

      {code === "migration_in_progress" && (
        <p className="text-xs text-fg-muted">
          Another tab or window is running this migration right now. Let it finish — when it
          does, reload this plan and it will report that there is nothing left to move.
        </p>
      )}

      {code === "env_shadowed" && (
        <p className="text-xs text-fg-muted">
          <Mono>PADDOCK_CLAUDE_TRANSCRIPTS</Mono> is set in this server's environment, and an
          environment variable beats the config file. Writing{" "}
          <Mono>claude.transcripts: host</Mono> would have no effect, so the chats would have been
          moved for nothing. Unset it, restart Paddock, and the offer will come back.
        </p>
      )}

      <p className="text-2xs text-fg-subtle">
        Your selection is still here: {selected.size.toLocaleString()} of{" "}
        {rows.length.toLocaleString()} ticked.
      </p>
    </div>
  );
}

const REFUSAL_TITLE: Record<string, string> = {
  turn_running: "A chat is still mid-turn.",
  config_conflict: "The config file changed underneath this plan.",
  migration_in_progress: "A migration is already running.",
  env_shadowed: "An environment variable is overriding the config file.",
  invalid: "That request was not valid.",
};

/* -------------------------------------------------------------------------- */
/* the completion screen                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What actually happened — including, deliberately and in full, everything that
 * was set aside.
 *
 * ## A 200 is not a success
 *
 * A non-empty `failed[]` means the config was **not** written and the instance
 * is still on `own`. #882's contract says so and this screen must not round it
 * up to "done": the user's next action is completely different in the two cases
 * (restart vs. re-run), and a green tick over a partial migration is how someone
 * restarts into a half-empty `.chats/` and concludes Paddock lost their chats.
 *
 * ## Why `preserved[]` is printed in full, with paths
 *
 * Because it is the recovery path. "Nothing is deleted" is the promise the whole
 * dialog rests on, and a promise the user cannot verify is just a claim. A list
 * of absolute paths is a thing they can `ls`. It is not collapsed behind a
 * disclosure for the same reason — the one time it matters is the time someone
 * regrets a tick, and that person should not have to go looking.
 */
function ResultPanel({ result }: { result: TranscriptsMigrationResult }) {
  const outcome = migrationOutcome(result);
  const preservedGroups = groupPreserved(result.preserved);
  const skipped = result.projects.filter((p) => p.outcome === "skipped-busy");

  return (
    <div className="space-y-3">
      {outcome === "partial" ? (
        <Callout tone="warn" className="text-sm">
          <p className="font-semibold">The migration did not finish.</p>
          <p className="mt-1">
            <Mono>claude.transcripts</Mono> was <strong className="font-semibold">not</strong>{" "}
            changed, so this instance is still using its own store and nothing about how Paddock
            behaves has changed yet. Files that did move are already in place and will not move
            twice — <strong className="font-semibold">running this again is safe</strong> and
            picks up where it stopped.
          </p>
        </Callout>
      ) : outcome === "already" ? (
        <Callout tone="info" className="text-sm">
          <p className="font-semibold">Already merged.</p>
          <p className="mt-1">
            Everything was already in your <Mono>~/.claude</Mono> and{" "}
            <Mono>claude.transcripts</Mono> was already <Mono>host</Mono>. Nothing needed doing.
          </p>
        </Callout>
      ) : (
        <Callout tone="success" className="text-sm">
          <p className="font-semibold">
            Merged {result.migrated.length.toLocaleString()}{" "}
            {result.migrated.length === 1 ? "chat" : "chats"} into your <Mono>~/.claude</Mono>.
          </p>
          {result.preserved.length > 0 && (
            <p className="mt-1">
              {result.preserved.length.toLocaleString()}{" "}
              {result.preserved.length === 1 ? "copy was" : "copies were"} set aside rather than
              overwritten. Every one is listed below.
            </p>
          )}
        </Callout>
      )}

      {result.restartRequired && (
        <RestartNotice ok={outcome !== "partial"} configWritten={result.configWritten} />
      )}

      {result.failed.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-fg">
            {result.failed.length.toLocaleString()} could not be moved
          </h3>
          <ul className="mt-1 space-y-1">
            {result.failed.map((f, i) => (
              <li
                key={`${f.slug}:${f.sessionId}:${i}`}
                className="rounded-md border border-warn-edge bg-warn-soft/40 px-2 py-1.5 text-2xs"
              >
                <span className="block break-all font-mono text-fg">{failureLabel(f)}</span>
                {/* Rendered verbatim. The reason vocabulary is open, and
                    swallowing a value this build has not heard of would hide the
                    only explanation the user gets. */}
                <span className="block text-fg-muted">
                  {f.reason}
                  {f.message ? ` — ${f.message}` : ""}
                </span>
                {/* Suppressed when the label already IS the path, which is what
                    the `"-"` sentinel falls back to. */}
                {f.path && failureLabel(f) !== f.path && (
                  <span className="block break-all font-mono text-fg-subtle">{f.path}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {skipped.length > 0 && (
        <Callout tone="warn" className="text-xs">
          <p className="font-semibold">
            {skipped.length} {skipped.length === 1 ? "project was" : "projects were"} left
            untouched.
          </p>
          <p className="mt-1">
            A turn started again between the stop and the move, so{" "}
            {skipped.map((p) => p.slug || "the root workspace").join(", ")} was skipped entirely
            rather than half-moved. Run the migration again once it is idle.
          </p>
        </Callout>
      )}

      {result.preserved.length > 0 && (
        <section data-testid="migration-preserved">
          {/* "items", not "files". Each entry is a CHAT — its transcript plus
              the `<id>/subagents/`, `<id>/tool-results/` and `.reverts/` that
              travel with it — or a single agent-memory file. Counting them as
              files understated a real run by six, and a recovery list whose
              own count does not match `ls` is exactly the kind of small
              inaccuracy that makes a user stop believing the rest of it. */}
          <h3 className="text-xs font-semibold text-fg">
            Kept, not deleted — {result.preserved.length.toLocaleString()}{" "}
            {result.preserved.length === 1 ? "item" : "items"}
          </h3>
          <p className="mt-0.5 text-2xs text-fg-muted">
            Every copy that did not end up in <Mono>~/.claude</Mono>, and exactly where it is
            now. Nothing here was removed; you can open any of these paths. A chat's sub-agent
            transcripts, tool results and revert history move with it.
          </p>
          {preservedGroups.map((group) => (
            <div key={group.slug} className="mt-2">
              <p className="text-2xs font-semibold text-fg-muted">
                {group.slug || "root workspace"}
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {group.items.map((item, i) => (
                  <li key={`${item.path}:${i}`} className="text-2xs">
                    <span className="block break-all font-mono text-fg">{item.path}</span>
                    <span className="text-fg-subtle">{preserveExplanation(item.reason, item.side)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {result.unplanned.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-fg">
            {result.unplanned.length.toLocaleString()} appeared after you opened this
          </h3>
          <p className="mt-0.5 text-2xs text-fg-muted">
            These chats were created between the table being built and Submit, so you were never
            shown them. Each was handled by the same default its classification would have had.
          </p>
          <ul className="mt-1 space-y-0.5">
            {result.unplanned.map((u, i) => (
              <li key={`${u.sessionId}:${i}`} className="break-all text-2xs">
                <span className="font-mono text-fg">{u.sessionId}</span>{" "}
                <span className="text-fg-muted">
                  — {stateCopy(u.state).label.toLowerCase()}, so it was{" "}
                  {u.action === "migrated" ? "merged" : "kept in the preserve folder"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.ignoredSessionIds.length > 0 && (
        <p className="text-2xs text-fg-muted">
          {result.ignoredSessionIds.length.toLocaleString()} ticked{" "}
          {result.ignoredSessionIds.length === 1 ? "chat was" : "chats were"} no longer on disk
          and were skipped.
        </p>
      )}

      {result.warnings.length > 0 && <WarningList warnings={result.warnings} />}

      {result.sweepers.chats > 0 && (
        <p className="text-2xs text-fg-subtle">
          {result.sweepers.chats.toLocaleString()} internal sweeper transcripts across{" "}
          {result.sweepers.stores.toLocaleString()}{" "}
          {result.sweepers.stores === 1 ? "store" : "stores"} moved with their projects.
        </p>
      )}
    </div>
  );
}

/**
 * The restart — and which of three different stories to tell about it.
 *
 * The `own → host` flip is the headline one and the single most important
 * paragraph in the dialog: `claude.transcripts` is frozen at boot, so the
 * running process is still resolving `own` against a `.chats/` this migration
 * just emptied, and the chat list will be **blank** until the restart. A user
 * who is not told will conclude the migration destroyed their history, and
 * every instinct from there makes it worse.
 *
 * The other two are not variations on that sentence, which is why this branches
 * on `configWritten` rather than patching one clause:
 *
 * - **Partial** (`!ok`): a restart is the wrong next action. The config was not
 *   written, so restarting comes back on `own` and still cannot see what moved.
 *   Finish the migration first.
 * - **Stranded-`host` recovery** (`ok` but `!configWritten`, reachable since
 *   #902): nothing was written because nothing was owed, and the list does not
 *   go blank — it has been missing chats all along and the restart returns
 *   them.
 */
function RestartNotice({ ok, configWritten }: { ok: boolean; configWritten: boolean }) {
  // On a PARTIAL migration a restart is the wrong instruction and telling the
  // user to do it first would waste the one action they take. The config was
  // not written, so a restart still comes back on `own` and still cannot see
  // the chats that did move — only finishing the migration flips the lever.
  // `restartRequired` is nonetheless true, because those chats are out of
  // `.chats/` and this process cannot see them either; so the notice stays and
  // the ORDER changes.
  if (!ok) {
    return (
      <Callout tone="accent" className="text-sm">
        <p className="font-semibold text-fg">Run the migration again, then restart.</p>
        <p className="mt-1">
          Some chats have already moved out of Paddock's own store, and because the setting was
          not written this server still looks for them there.{" "}
          <strong className="font-semibold text-fg">
            Until the migration finishes, your chat list will look incomplete.
          </strong>{" "}
          Nothing is lost — every file is either in your <Mono>~/.claude</Mono> or in the folders
          listed below. Fix what is reported above, run this again, and restart when it completes.
        </p>
      </Callout>
    );
  }

  // #902's STRANDED-`host` recovery, which is a different story end to end and
  // not a variation on one clause.
  //
  // That user was already on `host`; their non-empty `.chats/` made
  // `pointChatsDirAt` decline the redirect symlink, so their chats were
  // INVISIBLE (#708) and this migration is what makes them reachable again.
  // Nothing about their configuration changed, and their list does not go blank
  // and come back — it has been missing chats all along and the restart is what
  // returns them. Both halves of the `own → host` copy are false here: there is
  // no setting to have written, and "your list will look empty" describes the
  // opposite of what happens.
  if (!configWritten) {
    return (
      <Callout tone="accent" className="text-sm">
        <p className="font-semibold text-fg">Restart the Paddock server now.</p>
        <p className="mt-1">
          Your configuration already asked for <Mono>~/.claude</Mono>, so{" "}
          <strong className="font-semibold text-fg">nothing about it was changed</strong> — the
          chats were simply stranded where Paddock could not reach them, and they are now back in
          the store it reads. Paddock only wires that up at startup, so this running server has
          not caught up yet.{" "}
          <strong className="font-semibold text-fg">
            Restart and the chats that were missing will reappear.
          </strong>{" "}
          The copies set aside along the way are in the folders listed here.
        </p>
      </Callout>
    );
  }

  return (
    <Callout tone="accent" className="text-sm">
      <p className="font-semibold text-fg">Restart the Paddock server now.</p>
      <p className="mt-1">
        The setting is written, but Paddock reads it once when it starts — so this running server
        has not picked it up yet.{" "}
        <strong className="font-semibold text-fg">
          Until you restart, your chat list will look empty.
        </strong>{" "}
        That is expected and nothing is wrong: the running process is still looking in the old
        location, which the migration just emptied. Everything is on disk — the merged chats are
        in your <Mono>~/.claude</Mono> and the set-aside copies are in the folders listed here.
        They all come back the moment Paddock restarts.
      </p>
    </Callout>
  );
}

function preserveExplanation(reason: string, side: "own" | "host"): string {
  switch (reason) {
    case "unchecked":
      return "you left this one unticked, so Paddock's copy was set aside and your ~/.claude copy is untouched";
    case "unplanned-diverged":
      return "created after the table was built and had conflicting edits, so it was set aside rather than merged without asking";
    case "identical":
      return "already identical in both places, so Paddock's duplicate was set aside";
    case "already-ahead":
      return "your ~/.claude copy was the longer one and was kept, so Paddock's shorter copy was set aside";
    case "superseded":
      return "your ~/.claude copy was moved here first, then Paddock's copy took its place — this is the original";
    default:
      // Open vocabulary: name the value rather than inventing a description.
      return `set aside from the ${side === "host" ? "~/.claude" : "Paddock"} side (${reason})`;
  }
}

/* -------------------------------------------------------------------------- */
/* footer                                                                      */
/* -------------------------------------------------------------------------- */

function MigrationFooter({
  phase,
  plan,
  rows,
  selectedCount,
  alsoMoving,
  onClose,
  onRetry,
  onReload,
  onSubmit,
}: {
  phase: Phase;
  plan: TranscriptsMigrationPlan | null;
  rows: TranscriptsMigrationChat[];
  selectedCount: number;
  alsoMoving: number;
  onClose: () => void;
  onRetry: () => void;
  onReload: () => void;
  onSubmit: () => void;
}) {
  if (phase.kind === "running") {
    return (
      <span className="text-xs text-fg-muted">Working — this usually takes under a second.</span>
    );
  }

  if (phase.kind === "result") {
    return (
      <Button variant="primary" size="sm" onClick={onClose}>
        Close
      </Button>
    );
  }

  if (phase.kind === "load-failed") {
    return (
      <>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" size="sm" onClick={onReload}>
          Try again
        </Button>
      </>
    );
  }

  if (phase.kind === "refused") {
    const code = phase.error instanceof ApiError ? phase.error.code : undefined;
    // `env_shadowed` is the one refusal a retry cannot fix — the environment has
    // to change and the server has to restart. Offering "Try again" there would
    // be a button whose only possible outcome is the same error.
    const retryable = code !== "env_shadowed" && code !== "invalid";
    return (
      <>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        {code === "config_conflict" ? (
          <Button variant="primary" size="sm" onClick={onReload}>
            Reload the plan
          </Button>
        ) : (
          retryable && (
            <Button variant="primary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )
        )}
      </>
    );
  }

  if (phase.kind === "loading" || !plan) {
    return (
      <Button variant="ghost" size="sm" onClick={onClose}>
        Cancel
      </Button>
    );
  }

  if (planIsEmpty(plan)) {
    return (
      <Button variant="primary" size="sm" onClick={onClose}>
        Close
      </Button>
    );
  }

  return (
    <>
      <span className="mr-auto text-xs text-fg-muted">
        {selectedCount.toLocaleString()} of {rows.length.toLocaleString()} ticked
        {alsoMoving > 0 && (
          <span className="text-fg-subtle"> · {alsoMoving.toLocaleString()} more move anyway</span>
        )}
      </span>
      <Button variant="ghost" size="sm" onClick={onClose}>
        Cancel
      </Button>
      {/*
        NOT disabled at zero. "Migrate nothing, preserve everything, flip the
        lever" is a legal and meaningful choice — the server documents an empty
        `sessionIds` as exactly that and deliberately does not 400 it — and it is
        the right one for a user who wants the CLI to own their history from here
        on without importing any of Paddock's. Disabling it would silently
        remove an option the API supports; the label says plainly what it will
        do instead.
      */}
      <Button variant="primary" size="sm" onClick={onSubmit}>
        {selectedCount === 0
          ? "Merge nothing, keep everything"
          : `Merge ${selectedCount.toLocaleString()} ${selectedCount === 1 ? "chat" : "chats"}`}
      </Button>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* bits                                                                        */
/* -------------------------------------------------------------------------- */

function WarningList({ warnings }: { warnings: TranscriptsMigrationWarning[] }) {
  return (
    <Callout tone="warn" className="text-xs">
      <p className="font-semibold">
        {warnings.length === 1 ? "One thing to know" : `${warnings.length} things to know`}
      </p>
      <ul className="mt-1 space-y-1">
        {warnings.map((w, i) => (
          <li key={`${w.code}:${i}`}>
            {/* `message` rather than `code`: the vocabulary is open and the
                server writes the prose, so an unrecognised code still reaches
                the user with an explanation attached. */}
            <span>{w.message}</span>
            {/*
              Paths behind a disclosure, messages always visible.

              Driving the real rig is what forced this: three warnings with
              their absolute paths expanded filled roughly 40% of the dialog,
              so the first chat row sat below the fold and the table this
              feature exists for was invisible on open. Hiding the WARNING
              would be the wrong fix — an unreadable host store is exactly the
              kind of thing that must not be buried — so what folds away is the
              bulk, which is the paths.
            */}
            {w.paths && w.paths.length > 0 && (
              <details className="mt-0.5">
                <summary className="focus-visible:focus-ring cursor-pointer text-2xs underline underline-offset-2">
                  {w.paths.length === 1 ? "Show the path" : `Show ${w.paths.length} paths`}
                </summary>
                <ul className="mt-0.5">
                  {w.paths.map((p) => (
                    <li key={p} className="break-all font-mono text-2xs text-fg-subtle">
                      {p}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

const STATE_TONE: Record<string, ChipTone> = {
  new: "success",
  "fast-forward": "info",
  diverged: "warn",
  unknown: "neutral",
};

function StateChip({ state, n }: { state: TranscriptsMigrationState; n?: number }) {
  if (n === 0) return null;
  const copy = stateCopy(state);
  return (
    <Chip tone={STATE_TONE[state] ?? "neutral"} title={copy.hint}>
      {n === undefined ? copy.label : `${n.toLocaleString()} ${copy.label.toLowerCase()}`}
    </Chip>
  );
}

/**
 * The hover text for a row: its session id, and how many sidecar files travel
 * with it.
 *
 * Both used to be printed under every row. They are identifiers, not decisions —
 * the id matters only when cross-referencing the preserve list on the completion
 * screen, and the sidecar count only if you are counting files. Neither helps
 * anyone answer "should this be ticked?", which is the one question this table
 * exists to ask.
 *
 * The id is omitted when the row is already headed by it (an unnamed chat), so
 * the tooltip never just repeats the label.
 */
function rowTitle(chat: TranscriptsMigrationChat): string | undefined {
  const parts: string[] = [];
  if (chat.name !== undefined) parts.push(chat.sessionId);
  if (chat.extras.length > 0)
    parts.push(`+${chat.extras.length} sidecar ${chat.extras.length === 1 ? "file" : "files"}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** A chat whose default is "don't touch it without being told to". */
function needsDecision(chat: TranscriptsMigrationChat): boolean {
  return !chat.defaultSelected;
}

/** A row with a counterpart the migration has to choose between. */
function isConflicted(chat: TranscriptsMigrationChat): boolean {
  return chat.state === "diverged" || chat.state === "unknown";
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="break-all font-mono">{children}</span>;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The dialog heading, which must never claim more than the outcome supports. */
function dialogTitle(phase: Phase): string {
  const base = "Merge chats into ~/.claude";
  if (phase.kind !== "result") return base;
  switch (migrationOutcome(phase.result)) {
    case "partial":
      return `${base} — unfinished`;
    case "already":
      return `${base} — nothing to do`;
    default:
      return `${base} — done`;
  }
}

/**
 * What to call a failure that is not about one chat.
 *
 * The server uses a literal `"-"` sentinel for `sessionId` when the failure is
 * a whole store that would not drain or the config write itself. Rendering that
 * verbatim puts a bare dash where a chat name should be, which reads as a
 * corrupted row rather than as "this one is not a chat". Both those cases carry
 * a `path`, so use it.
 */
function failureLabel(f: TranscriptsMigrationFailure): string {
  if (f.sessionId && f.sessionId !== "-") return f.sessionId;
  return f.path ?? "Project files";
}

/** The ids from a `turn_running` body, narrowed defensively. */
function stuckSessionIds(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const body = error.body;
  if (typeof body !== "object" || body === null) return [];
  const ids = (body as { sessionIds?: unknown }).sessionIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function cxLocal(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* -------------------------------------------------------------------------- */

/**
 * The shared `Dialog`, widened.
 *
 * `size="lg"` is `max-w-2xl`, which is right for a confirmation and too narrow
 * for a two-column comparison inside a row. The override is a `sm:` variant
 * rather than a bare `max-w-4xl` because responsive utilities sort after base
 * ones in Tailwind's output, so it wins deterministically instead of depending
 * on class order — and below `sm` the panel is full-width anyway, which is the
 * width a phone should get.
 */
function Dialogish(props: React.ComponentProps<typeof Dialog>) {
  return <Dialog {...props} size="lg" className="sm:max-w-4xl" />;
}
