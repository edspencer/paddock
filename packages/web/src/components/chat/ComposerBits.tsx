import { useEffect, useState } from "react";
import type { ConnectionState } from "../../lib/ws";
import { formatSessionUsage, formatTokens, formatUsd } from "../../lib/format";
import type { AttachmentRef, ChatCompleteUsage, ChatUsage, ModelInfo } from "../../lib/types";
import { BranchIcon, ClockIcon, PencilIcon, XIcon } from "../icons";

/**
 * Issue #1/#188 — the "Preload project context" checkbox shown on a NEW project
 * chat's composer. When checked, the first turn injects the project's curated
 * OVERVIEW.md (current state) and CHANGELOG.md (history) as context. Disabled
 * (with an explanatory note) until a sweep has produced an overview.
 */
export function PreloadToggle({
  checked,
  available,
  onChange,
}: {
  checked: boolean;
  available: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`group mb-2 inline-flex w-fit items-center gap-2 rounded-lg px-1 py-0.5 text-xs ${
        available
          ? "cursor-pointer text-fg-muted"
          : "cursor-not-allowed text-fg-subtle"
      }`}
      title={
        available
          ? "Inject this project's curated OVERVIEW.md (current state) and CHANGELOG.md (history) as context on the first message of this new chat, so the agent starts already knowing the project's state and narrative."
          : "No project overview yet — a sweep writes OVERVIEW.md after some activity. The agent will still see the project's files."
      }
    >
      <input
        type="checkbox"
        // Reflects the user's intent (default ON); disabled until a sweep has
        // produced an overview to actually inject.
        checked={checked}
        disabled={!available}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-edge-strong accent-[var(--accent-solid)] focus:ring-accent/30 disabled:opacity-50"
      />
      <span className="font-medium">Preload project context</span>
      {/* The inline hint is redundant with the label's own tooltip, so it's
          hidden on mobile (< sm) to keep the label on one line and reclaim
          vertical space (#372); it stays inline on desktop. */}
      <span className="hidden text-fg-subtle transition-opacity sm:inline">
        {available ? "(injects OVERVIEW.md + CHANGELOG.md)" : "(no overview yet)"}
      </span>
    </label>
  );
}

/**
 * CONTRACT-v3 §8 — a compact status row above the composer: a model picker and
 * a context-window meter for the currently open chat. Deliberately unobtrusive
 * (a status row, not a settings panel). The meter is sourced from the most
 * recent completed turn's usage, so it is intentionally stale-by-one-turn.
 */
export function StatusRow({
  models,
  model,
  onSelectModel,
  usage,
  sessionUsage,
  forkParent,
  onOpenForkParent,
}: {
  models: ModelInfo[];
  model: string | null;
  onSelectModel: (id: string) => void;
  usage: ChatCompleteUsage | null;
  sessionUsage: ChatUsage | null;
  forkParent?: { sessionId: string; name: string };
  onOpenForkParent?: (sessionId: string) => void;
}) {
  return (
    <div className="mb-2 flex items-center gap-3 px-1 text-2xs text-fg-subtle">
      <label className="inline-flex items-center gap-1.5">
        <span className="font-medium text-fg-muted">Model</span>
        <select
          value={model ?? ""}
          onChange={(e) => onSelectModel(e.target.value)}
          disabled={models.length === 0}
          title="Model for this chat (sent on every message; remembered per chat)"
          className="rounded-md border border-edge-strong bg-surface-raised px-1.5 py-0.5 text-2xs text-fg-muted outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 disabled:opacity-50"
        >
          {/* A placeholder while the selected model isn't among the loaded list
              (e.g. before /api/models resolves) so the <select> stays controlled. */}
          {model && !models.some((m) => m.id === model) && (
            <option value={model}>{model}</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <ContextMeter usage={usage} />
      <SessionCost usage={sessionUsage} />
      {/* Fork lineage: this chat was branched from another — link back to it.
          Sits to the right (ml-auto) in the otherwise-empty gap of the row. */}
      {forkParent && (
        <span className="ml-auto inline-flex min-w-0 items-center gap-1">
          <BranchIcon width={11} height={11} className="shrink-0 text-fg-subtle" />
          <span className="shrink-0">Fork of</span>
          <button
            type="button"
            onClick={() => onOpenForkParent?.(forkParent.sessionId)}
            title={`Open the chat this was forked from: ${forkParent.name}`}
            className="truncate font-medium text-accent underline-offset-2 hover:underline"
          >
            {forkParent.name}
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * The thin context-window meter. Before any turn completes (no usage yet) it
 * shows a muted "context: —" placeholder. Once a turn has completed it renders
 * "{k}k / {limit}k ({pct}%)" with a thin progress bar that turns amber at ≥80%.
 */
export function ContextMeter({ usage }: { usage: ChatCompleteUsage | null }) {
  if (!usage || usage.contextLimit <= 0) {
    return <span className="text-fg-subtle">context: —</span>;
  }
  const pct = Math.min(100, Math.max(0, (usage.contextTokens / usage.contextLimit) * 100));
  const warn = pct >= 80;
  const used = Math.round(usage.contextTokens / 1000);
  const limit = Math.round(usage.contextLimit / 1000);
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5"
      title={`Context window used as of the last completed turn (${usage.contextTokens.toLocaleString()} / ${usage.contextLimit.toLocaleString()} tokens)`}
    >
      <span className="h-1 w-20 overflow-hidden rounded-full bg-surface-active">
        <span
          className={`motion-base block h-full rounded-full transition-[width,background-color] ${
            warn ? "bg-warn-solid" : "bg-accent-solid"
          }`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={warn ? "text-warn" : undefined}>
        {used}k / {limit}k ({Math.round(pct)}%)
      </span>
    </span>
  );
}

/**
 * A compact "this chat has cost N tokens (~$X at API rates)" chip, sitting next
 * to the context meter (issue #152). Unlike the meter (last-turn context fill),
 * this is the chat's *cumulative* consumption. The headline shows the dollar
 * estimate when the model has known pricing, else the total token count; the
 * full breakdown is in the tooltip. Hidden until there's usage.
 */
export function SessionCost({ usage }: { usage: ChatUsage | null }) {
  if (!usage || usage.totalTokens <= 0) return null;
  const headline = usage.costUsd != null ? `~${formatUsd(usage.costUsd)}` : formatTokens(usage.totalTokens);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      title={`Session so far: ${formatSessionUsage(usage)}`}
    >
      <span aria-hidden="true">·</span>
      <span>{headline}</span>
    </span>
  );
}

/**
 * A persistent "agent is working…" pill shown under the transcript while a turn
 * is in flight (#53). Cycles a few lightweight status phrases (à la Claude Code's
 * "reticulating splines") so it reads as alive even during a quiet thinking gap,
 * and — because it's driven by the turn-level `streaming` state, now restored on
 * return via chat:active — it lights up the moment you come back to a live chat.
 */
const WORKING_PHRASES = [
  "working",
  "thinking",
  "reticulating splines",
  "consulting Claude",
  "herding electrons",
  "tending the paddock",
];
export function WorkingIndicator() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % WORKING_PHRASES.length), 2600);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4">
      <div className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface-active px-3 py-1 text-xs text-fg-muted">
        {/* A static dot — the cycling phrase + the ring spinner already signal
            "alive"; the old `animate-ping` was a third perpetual 60fps animation
            (a continuous scale) running for the whole turn, dropped for cost. */}
        <span className="inline-flex h-1.5 w-1.5 rounded-full bg-accent-solid" aria-hidden="true" />
        <span>{WORKING_PHRASES[i]}…</span>
      </div>
    </div>
  );
}

/**
 * Issue #91 — the slim "queued message" toolbar shown directly above the
 * composer while a message is stacked to auto-send. Shows the queued message's
 * first line + a "queued" indicator; hovering reveals Edit (pop it back into the
 * composer, cancelling the pending auto-send) and Clear (discard it). At most one
 * message is ever queued.
 */
export function QueuedMessageBar({
  text,
  attachments = [],
  onEdit,
  onClear,
}: {
  text: string;
  /**
   * Files staged on the queued message (#728). Listed here because the queue is
   * where they now live: enqueueing moves them out of the composer tray, so the
   * bar is the only place the user can see that a file is going out with this
   * message — and Edit is how they get it back. `text` may be `""` when the
   * message is attachments-only (#328).
   */
  attachments?: AttachmentRef[];
  onEdit: () => void;
  onClear: () => void;
}) {
  const firstLine = text.split("\n", 1)[0];
  // Everything past the first line is hidden by the single-line toolbar. Surface
  // how much more there is so a multi-line queued message doesn't look truncated
  // (issue #91 follow-up) — counts the hidden characters, newline(s) included.
  const moreChars = text.length - firstLine.length;
  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4">
      <div className="group flex items-center gap-2 rounded-lg border border-accent-edge bg-accent-soft px-3 py-1.5 text-xs">
        <ClockIcon width={13} height={13} className="shrink-0 text-accent" />
        <span className="shrink-0 eyebrow text-accent">
          queued
        </span>
        <span
          className="min-w-0 flex-1 truncate text-fg-muted"
          title={text || attachments.map((a) => a.filename).join(", ")}
        >
          {firstLine ||
            (attachments.length > 0 ? (
              <span className="italic text-fg-muted">
                {attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`}
              </span>
            ) : null)}
        </span>
        {firstLine && attachments.length > 0 && (
          <span
            className="shrink-0 tabular-nums text-fg-subtle"
            data-testid="queued-attachment-count"
            title={attachments.map((a) => a.filename).join(", ")}
          >
            📎 {attachments.length}
          </span>
        )}
        {moreChars > 0 && (
          <span
            className="shrink-0 tabular-nums text-fg-subtle"
            title={`${moreChars} more character${moreChars === 1 ? "" : "s"} not shown — hover Edit to see the full message`}
          >
            +{moreChars} character{moreChars === 1 ? "" : "s"}
          </span>
        )}
        {/* Revealed on hover/focus. Kept in the DOM (not conditionally mounted)
            so they stay keyboard-reachable and testable. */}
        <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={onEdit}
            title="Edit this message (cancels the pending auto-send)"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-fg-muted hover:bg-surface-active"
          >
            <PencilIcon width={12} height={12} />
            Edit
          </button>
          <button
            type="button"
            onClick={onClear}
            title="Remove queued message"
            aria-label="Remove queued message"
            className="inline-flex items-center rounded p-1 text-fg-muted hover:bg-surface-active hover:text-danger"
          >
            <XIcon width={12} height={12} />
          </button>
        </span>
      </div>
    </div>
  );
}

export function ConnDot({ state }: { state: ConnectionState }) {
  const map = {
    open: { c: "bg-success-solid", t: "connected" },
    connecting: { c: "bg-warn-solid animate-pulse", t: "connecting" },
    closed: { c: "bg-danger-solid", t: "offline" },
  }[state];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${map.c}`} />
      {map.t}
    </span>
  );
}
