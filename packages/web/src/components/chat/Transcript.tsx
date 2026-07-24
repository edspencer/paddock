import { memo, useContext, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { type ToolCall } from "../../lib/ws";
import { formatDuration, formatUsd, isTerminatedTaskStatus } from "../../lib/format";
import type {
  BashDetails,
  EditDiff,
  HistoryMessage,
  MessageSender,
  TaskCreateInfo,
  TurnNotice,
} from "../../lib/types";
import { Markdown } from "../Markdown";
import { MessageAttachments } from "../MessageAttachments";
import { SentFileBlock } from "../SentFileBlock";
import { InlineImage } from "../MediaImage";
import { PaddockManageBody } from "../PaddockManageBlock";
import { mcpToolInfo, parsePaddockManage, paddockManageSummary } from "../../lib/mcpTools";
import {
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  FileIcon,
  PencilIcon,
  SearchIcon,
  SparkIcon,
  WrenchIcon,
} from "../icons";
import { type Turn, historyToTurns } from "./turnModel";
import {
  RecoveryContext,
  SubagentFetchContext,
  SubagentLiveContext,
  ToolImageUrlContext,
} from "./chatContexts";
import {
  SUBAGENT_TOOLS,
  diffLineClass,
  gutter,
  isBackgroundTool,
  paddockMcpIcon,
  readRangeLabel,
  searchCountLabel,
  statusChipClass,
  taskStatusPillClass,
} from "./toolFormatting";

// Memoized so unchanged turns bail out of reconciliation when ChatPane state that
// is independent of the transcript churns — composer `draft` (every keystroke),
// streaming appends, the slash menu, connection/model state. `turns` are rebuilt
// (new refs) only when `msgs` changes, so on those unrelated updates every turn's
// prop reference is stable and memo turns the O(N)-per-keystroke reconcile into
// O(changed). (#148)
export const TurnView = memo(function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === "user") {
    return (
      <div className="flex animate-fade-in flex-col items-end">
        {turn.sender ? <SenderAttribution sender={turn.sender} /> : null}
        {turn.attachments && turn.attachments.length > 0 ? (
          <MessageAttachments attachments={turn.attachments} />
        ) : null}
        {turn.content ? (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white shadow-sm">
            {turn.content}
          </div>
        ) : null}
      </div>
    );
  }
  if (turn.kind === "file") {
    return <SentFileBlock file={turn.file} />;
  }
  if (turn.kind === "tool") {
    return <ToolBlock tool={turn.tool} />;
  }
  if (turn.kind === "command") {
    // A slash-command echo (e.g. `/compact`) — a centered, unobtrusive chip, not
    // a user bubble of raw `<command-name>…` XML (issue #106).
    return (
      <div className="flex animate-fade-in justify-center">
        <span className="rounded-full bg-paddock-100 px-2.5 py-0.5 font-mono text-xs text-ink-subtle ring-1 ring-paddock-200/70 dark:bg-paddock-900 dark:text-ink-dark/70 dark:ring-paddock-800">
          {turn.command}
        </span>
      </div>
    );
  }
  if (turn.kind === "commandOutput") {
    // The rendered output of a client-local command (`/context`, `/usage`, …),
    // recovered from its `<local-command-stdout>` block (issue #158). An empty
    // payload (a display-only command that produced nothing, or the dropped
    // `<local-command-caveat>`) renders nothing at all.
    if (!turn.content) return null;
    return <LocalCommandOutput content={turn.content} />;
  }
  if (turn.kind === "compact") {
    return <CompactBoundary summary={turn.summary} />;
  }
  if (turn.kind === "notice") {
    // A turn that dead-ended without a normal reply (issue #329): a
    // subscription/usage-limit hit, the max-turns cap, or an error. A distinct
    // banner surfaces WHY the chat stopped, with a Retry affordance where safe.
    return <NoticeBlock notice={turn.notice} />;
  }
  if (turn.kind === "notification") {
    // A KILLED/STOPPED background task (issue #301): the turn-boundary-kill case
    // (herdctl#374) that leaves the keeper alive-but-idle. Render a distinct amber
    // "keeper is idle" affordance with a one-click Continue instead of the neutral
    // pill, so the silent hang is both visible and recoverable.
    if (isTerminatedTaskStatus(turn.status)) {
      return <KilledTaskNotice summary={turn.summary} />;
    }
    // An internal background-agent `<task-notification>` (issue #181): a subtle,
    // centered system-status line carrying the human-readable summary, never a
    // raw-XML user bubble. Full text on hover for the longer "stopped" variants.
    return (
      <div className="flex animate-fade-in justify-center">
        <span
          className="max-w-[85%] truncate rounded-full bg-paddock-50 px-2.5 py-0.5 text-xs italic text-ink-subtle/80 ring-1 ring-paddock-200/60 dark:bg-paddock-950 dark:text-ink-dark/60 dark:ring-paddock-800/70"
          title={turn.summary}
        >
          {turn.summary}
        </span>
      </div>
    );
  }
  // assistant
  return (
    <div className="flex animate-fade-in justify-start">
      <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-white px-4 py-2.5 text-ink shadow-sm ring-1 ring-paddock-200/70 dark:bg-paddock-900 dark:text-ink-dark dark:ring-paddock-800">
        {turn.content ? (
          <div className={turn.streaming ? "streaming-caret" : undefined}>
            <Markdown>{turn.content}</Markdown>
          </div>
        ) : (
          <div className="flex gap-1 py-1">
            <Dot /> <Dot delay="150ms" /> <Dot delay="300ms" />
          </div>
        )}
      </div>
    </div>
  );
});

function Dot({ delay }: { delay?: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-paddock-400"
      style={{ animationDelay: delay }}
    />
  );
}

/**
 * The rendered output of a client-local slash command (`/context`, `/usage`, …),
 * recovered from its `<local-command-stdout>` block (issue #158). Shown as a
 * labeled, assistant-styled block — the output is genuine (markdown tables, cost
 * summaries), it just lives in a transcript entry the herdctl parser/translator
 * drop — so it reads as command output, not a message the human or the agent
 * typed. Paddock's own context ring + cost meter remain the primary usage view;
 * this simply stops the output vanishing (or rendering as raw XML).
 */
function LocalCommandOutput({ content }: { content: string }) {
  return (
    <div className="flex animate-fade-in justify-start">
      <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-paddock-50 px-4 py-2.5 text-ink shadow-sm ring-1 ring-paddock-200/70 dark:bg-paddock-950 dark:text-ink-dark dark:ring-paddock-800">
        <div className="mb-1 flex items-center gap-1 text-[11px] italic text-ink-subtle/80 dark:text-ink-dark/60">
          <span aria-hidden>⌨</span>
          <span>command output</span>
        </div>
        <Markdown>{content}</Markdown>
      </div>
    </div>
  );
}

/**
 * A "conversation compacted" boundary for CC's post-`/compact` continuation
 * summary (issue #106). Shown as a centered divider — the reload-time equivalent
 * of the live "🗜️ Context compacted" note — with the (machine-generated) summary
 * text tucked behind a disclosure so nothing is lost but the chat no longer looks
 * like it ended on a stray user message.
 */
function CompactBoundary({ summary }: { summary: string }) {
  return (
    <div className="animate-fade-in py-1">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 text-xs text-ink-subtle dark:text-ink-dark/60">
          <span className="h-px flex-1 bg-paddock-200/70 dark:bg-paddock-800" />
          <span className="whitespace-nowrap">🗜️ conversation compacted</span>
          <span className="h-px flex-1 bg-paddock-200/70 dark:bg-paddock-800" />
        </summary>
        <div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-paddock-50 px-3 py-2 text-xs text-ink-subtle ring-1 ring-paddock-200/70 dark:bg-paddock-950 dark:text-ink-dark/70 dark:ring-paddock-800">
          {summary}
        </div>
      </details>
    </div>
  );
}

/**
 * A subtle per-message attribution shown above a machine-injected user bubble
 * (issue #290) — the per-MESSAGE analog of the chat-list ProvenanceBadge (#267).
 * A human-typed turn renders none of this (its `sender` is absent), so the
 * transcript stays quiet and only the "who added this?" cases stand out:
 *
 *  - `chat`     — "↩ sent by <name>", linking to the sending chat so you can jump
 *                 to whoever injected it (a manager's report-back, a peer send).
 *  - `schedule` — "⏰ scheduled by <name>" (a schedule fired this turn).
 *  - `agent`    — "↩ sent by an agent" (a machine turn with no richer identity).
 */
function SenderAttribution({ sender }: { sender: MessageSender }) {
  const base =
    "mb-1 flex items-center gap-1 text-[11px] italic text-ink-subtle/80 dark:text-ink-dark/60";
  if (sender.kind === "schedule") {
    return (
      <div className={base} data-sender="schedule">
        <span aria-hidden>⏰</span>
        <span>
          scheduled by <span className="font-medium not-italic">{sender.name}</span>
        </span>
      </div>
    );
  }
  if (sender.kind === "hook") {
    return (
      <div className={base} data-sender="hook">
        <span aria-hidden>⚡</span>
        <span>
          triggered by hook <span className="font-medium not-italic">{sender.name}</span>
        </span>
      </div>
    );
  }
  if (sender.kind === "recovery") {
    return (
      <div className={base} data-sender="recovery">
        <span aria-hidden>⚠</span>
        <span>continued after a background task was terminated</span>
      </div>
    );
  }
  if (sender.kind === "agent") {
    return (
      <div className={base} data-sender="agent">
        <span aria-hidden>↩</span>
        <span>sent by an agent</span>
      </div>
    );
  }
  // chat — link to the sending chat so "who sent this?" is one click away.
  const label = sender.name?.trim() || sender.sessionId.slice(0, 8);
  return (
    <div className={base} data-sender="chat">
      <span aria-hidden>↩</span>
      <span>
        sent by{" "}
        <Link
          to={`/projects/${encodeURIComponent(sender.project)}/chat/${encodeURIComponent(
            sender.sessionId,
          )}`}
          className="font-medium not-italic text-accent hover:underline"
          title={`Open ${label} in ${sender.project}`}
        >
          {label}
        </Link>
      </span>
    </div>
  );
}

/**
 * The Layer 2 recovery affordance (issue #301) shown for a KILLED/STOPPED
 * background-task notification: an amber panel stating the keeper was left idle
 * when its background task was terminated at the turn boundary, plus a one-click
 * "Continue" that re-drives it. The button is gated on the resolved
 * `recovery.surfaceKilledTask` (via {@link RecoveryContext}) — when Layer 2 is off,
 * or on a scratch chat (no keeper to recover), only the explanatory notice shows.
 * `busy` disables the button while a turn is already streaming.
 */
function KilledTaskNotice({ summary }: { summary: string }) {
  const recovery = useContext(RecoveryContext);
  const canContinue = Boolean(recovery?.enabled);
  const busy = Boolean(recovery?.busy);
  return (
    <div className="flex animate-fade-in justify-center" data-recovery="killed-task">
      <div className="flex max-w-[90%] flex-col gap-1.5 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/50 dark:text-amber-200">
        <div className="flex items-start gap-1.5">
          <span aria-hidden className="leading-tight">
            ⚠
          </span>
          <span className="leading-snug">
            A background task was terminated at the turn boundary — the keeper is
            idle and will not continue on its own.
            <span className="mt-0.5 block text-[11px] text-amber-800/80 dark:text-amber-300/70">
              {summary}
            </span>
          </span>
        </div>
        {canContinue && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={recovery?.onContinue}
              disabled={busy}
              data-recovery-action="continue"
              className="rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-amber-700 dark:hover:bg-amber-600"
            >
              {busy ? "Continuing…" : "Continue"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A dead-ended turn (issue #329). Renders a distinct banner explaining WHY the
 * chat stopped instead of leaving it looking dead:
 *  - `usage_limit` — the shared Max-plan quota (recurring on this box): an amber
 *    banner with the "resets …" time; NOT retryable (only the reset clears it).
 *  - `max_turns` — the keeper hit its per-turn cap and wrote nothing renderable:
 *    an amber banner with a Continue affordance.
 *  - `error` — a network / API 5xx-overload / auth / crash failure: a rose banner
 *    with the underlying detail and a Retry affordance.
 *
 * The Continue/Retry button reuses the Layer-2 recovery path ({@link
 * RecoveryContext}) — a nudge that re-drives the still-alive keeper — and only
 * shows when the notice is `retryable` AND recovery is enabled for this chat
 * (session-mode keeper). A usage limit never offers it.
 */
function NoticeBlock({ notice }: { notice: TurnNotice }) {
  const recovery = useContext(RecoveryContext);
  const canRetry = notice.retryable && Boolean(recovery?.enabled);
  const busy = Boolean(recovery?.busy);
  const isError = notice.kind === "error";
  const tone = isError
    ? "border-rose-300/70 bg-rose-50 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-200"
    : "border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/50 dark:text-amber-200";
  const btnTone = isError
    ? "bg-rose-600 hover:bg-rose-700 dark:bg-rose-700 dark:hover:bg-rose-600"
    : "bg-amber-600 hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600";
  const detailTone = isError
    ? "text-rose-800/80 dark:text-rose-300/70"
    : "text-amber-800/80 dark:text-amber-300/70";
  const heading =
    notice.kind === "usage_limit"
      ? "Session limit reached"
      : notice.kind === "max_turns"
        ? "Turn limit reached"
        : "The turn failed";
  return (
    <div className="flex animate-fade-in justify-center" data-notice={notice.kind}>
      <div className={`flex max-w-[90%] flex-col gap-1.5 rounded-lg border px-3 py-2 text-xs ${tone}`}>
        <div className="flex items-start gap-1.5">
          <span aria-hidden className="leading-tight">
            {isError ? "⚠" : "⏳"}
          </span>
          <span className="leading-snug">
            <span className="font-medium">{heading}.</span>{" "}
            {notice.message}
            {notice.kind === "usage_limit" && notice.resetTime && (
              <span className={`mt-0.5 block text-[11px] ${detailTone}`}>
                Resets {notice.resetTime}. The keeper will respond again after the quota resets.
              </span>
            )}
            {isError && notice.detail && (
              <span className={`mt-0.5 block break-words font-mono text-[11px] ${detailTone}`}>
                {notice.detail}
              </span>
            )}
          </span>
        </div>
        {canRetry && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={recovery?.onContinue}
              disabled={busy}
              data-notice-action="retry"
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${btnTone}`}
            >
              {busy ? "Retrying…" : notice.kind === "max_turns" ? "Continue" : "Retry"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolBlock({ tool }: { tool: ToolCall }) {
  // Paddock's own MCP tools (issue #253): a prettified name + brand badge for any
  // `mcp__…` tool (Phase 0), and a structured body parsed from the tool's JSON
  // output for the `paddock_manage` server (Phase 1). send_file is diverted to
  // SentFileBlock before this, so it never reaches here.
  const mcp = mcpToolInfo(tool.toolName);
  const paddockManage = parsePaddockManage(tool.toolName, tool.output);
  const PaddockIcon = mcp.isPaddock ? paddockMcpIcon(mcp.tool) : null;
  // The write actions (create/fork/send/batch) lead with a chat link worth seeing
  // without a click; the potentially long read results (list/read) start collapsed.
  const pmActionDefaultOpen =
    paddockManage != null &&
    (paddockManage.tool === "create_chat" ||
      paddockManage.tool === "fork_chat" ||
      paddockManage.tool === "send_message" ||
      paddockManage.tool === "fork_chat_batch");
  const [open, setOpen] = useState(pmActionDefaultOpen);
  const toolImageUrl = useContext(ToolImageUrlContext);
  // #429: whether this chat has a live turn in flight. Drives the sub-agent
  // running indicator + nested-step polling while the sub-agent works (incl. a
  // background sub-agent whose launch-ack tool_call already completed).
  const chatLive = useContext(SubagentLiveContext);
  // In-flight tool (#175): rendered before it completes — no output/duration
  // yet, just a "running…" affordance so a slow tool/subagent is visibly alive.
  const pending = Boolean(tool.pending);
  // For a sub-agent, show its actual run time (from its transcript) rather than
  // the near-instant launch time the Task/Agent tool_call itself records.
  const dur = formatDuration(tool.subagentDurationMs ?? tool.durationMs);
  // A sub-agent's estimated API-rate cost, priced server-side per-model (issue
  // #166). Rendered next to the duration; null when its model has no pricing.
  const cost = tool.subagentCostUsd != null ? `~${formatUsd(tool.subagentCostUsd)}` : null;
  const isSubagent = SUBAGENT_TOOLS.has(tool.toolName);
  // A detached tool (Monitor / bg Bash / background-task op) — a first-class class
  // distinct from a sub-agent, with a "background" badge + status chip (issue #230).
  const isBg = !isSubagent && isBackgroundTool(tool);
  const events = tool.monitorEvents ?? [];
  // Per-tool detail recovered from the raw `{input, toolUseResult}` sidecar (#237);
  // each is history-hydrated only and gates a richer treatment, else generic block.
  const diff = tool.editDiff;
  const isEdit = Boolean(diff);
  const readInfo = tool.toolName === "Read" ? tool.readInfo : undefined;
  // An image Read that resolves inside the project dir → render it inline (#239).
  const imageUrl =
    readInfo?.isImage && readInfo.projectRelPath && toolImageUrl
      ? toolImageUrl(readInfo.projectRelPath)
      : null;
  const bash = tool.toolName === "Bash" ? tool.bashDetails : undefined;
  const search = tool.searchInfo;
  const taskUpdate = tool.toolName === "TaskUpdate" ? tool.taskUpdate : undefined;
  const taskCreate = tool.toolName === "TaskCreate" ? tool.taskCreate : undefined;
  // Bash renders a split body only when there's a stderr to peel off; otherwise the
  // generic output pre still handles it (we don't duplicate every clean call).
  const bashSplit = Boolean(bash && bash.stderr);
  const searchCount = search ? searchCountLabel(search) : null;
  const readRange = readInfo ? readRangeLabel(readInfo) : null;
  // A sub-agent is still working when the chat is live and we don't yet have its
  // final metrics (subagentDurationMs is filled by the history subagent-join once
  // its transcript is complete) (#429). Covers BOTH a pending synchronous Task and
  // a background Task whose launch-ack tool_call already completed but whose run
  // continues on the still-active session. A reloaded/finished card has a duration
  // → never shows as running.
  const subagentRunning = isSubagent && chatLive && tool.subagentDurationMs == null;
  // Expandable-into-steps once the launch is known (live) or its transcript is on
  // disk (history). #429 relaxes the old `!pending` guard for sub-agents: the
  // launching card is now expandable the instant it starts, and NestedSteps polls
  // the (growing) transcript live — showing a "waiting…" placeholder until the
  // sidecar appears. Non-sub-agent tools are unaffected.
  const expandable = Boolean(isSubagent && tool.hasSubagent && tool.toolUseId);
  // Sub-agent header reads as "<type> — <description>"; the detail-bearing tools show
  // a friendlier subtitle; others keep the classic "<toolName> <inputSummary>".
  const label = isSubagent
    ? (tool.subagentType ?? tool.toolName)
    : mcp.isMcp
      ? mcp.display
      : tool.toolName;
  const subtitle = isSubagent
    ? tool.description
    : paddockManage
      ? paddockManageSummary(paddockManage)
      : isEdit
        ? (diff!.filePath?.split("/").pop() ?? diff!.filePath)
        : readInfo
          ? (readInfo.basename ?? readInfo.filePath ?? tool.inputSummary)
          : taskCreate
            ? taskCreate.subject
            : tool.inputSummary;
  // Full path/text on hover — fixes the long-path header cutoff for Read (#237).
  const subtitleTitle = readInfo?.filePath ?? taskCreate?.description ?? subtitle ?? undefined;
  return (
    <div className="flex justify-start">
      <div
        className={`w-full max-w-[92%] overflow-hidden rounded-xl border text-xs transition-colors ${
          tool.isError
            ? "border-rose-300/70 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/30"
            : isSubagent
              ? "border-accent/40 bg-accent/[0.06] dark:border-accent/40 dark:bg-accent/10"
              : isBg
                ? "border-sky-300/50 bg-sky-50/40 dark:border-sky-900/50 dark:bg-sky-950/20"
                : "border-paddock-200 bg-paddock-100/50 dark:border-paddock-800 dark:bg-paddock-900/40"
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
        >
          <ChevronRightIcon
            width={13}
            height={13}
            className={`shrink-0 text-paddock-400 transition-transform ${open ? "rotate-90" : ""}`}
          />
          {isSubagent ? (
            <SparkIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-accent"}`}
            />
          ) : isBg ? (
            <ClockIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-sky-600 dark:text-sky-400"}`}
            />
          ) : PaddockIcon ? (
            <PaddockIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-accent"}`}
            />
          ) : isEdit ? (
            <PencilIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-paddock-500"}`}
            />
          ) : readInfo ? (
            <FileIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-paddock-500"}`}
            />
          ) : search ? (
            <SearchIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-paddock-500"}`}
            />
          ) : taskUpdate || taskCreate ? (
            <CheckIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-paddock-500"}`}
            />
          ) : (
            <WrenchIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-paddock-500"}`}
            />
          )}
          <span className="shrink-0 whitespace-nowrap font-mono font-semibold text-paddock-700 dark:text-paddock-200">
            {label}
          </span>
          {isSubagent && (
            <span className="shrink-0 whitespace-nowrap rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
              sub-agent
            </span>
          )}
          {isBg && (
            <span className="shrink-0 whitespace-nowrap rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
              background
            </span>
          )}
          {mcp.isPaddock && (
            // Paddock's own injected MCP tool — a brand badge so it reads as a
            // first-class Paddock action, not a random tool (issue #253).
            <span className="shrink-0 whitespace-nowrap rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
              Paddock
            </span>
          )}
          {mcp.isMcp && !mcp.isPaddock && (
            <span className="shrink-0 whitespace-nowrap rounded bg-paddock-200/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300">
              MCP
            </span>
          )}
          {taskUpdate ? (
            // A TaskUpdate status transition: colored from → to pills (#237).
            <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-paddock-500 dark:text-paddock-400">
              {taskUpdate.taskId && <span className="shrink-0">Task #{taskUpdate.taskId}</span>}
              {taskUpdate.from && taskUpdate.to ? (
                <span className="flex shrink-0 items-center gap-1">
                  <TaskStatusPill status={taskUpdate.from} />
                  <span className="text-paddock-400">→</span>
                  <TaskStatusPill status={taskUpdate.to} />
                </span>
              ) : (
                taskUpdate.updatedFields && (
                  <span className="shrink-0 truncate">{taskUpdate.updatedFields.join(", ")}</span>
                )
              )}
            </span>
          ) : (
            subtitle && (
              <span
                className="min-w-0 truncate font-mono text-paddock-500 dark:text-paddock-400"
                title={subtitleTitle}
              >
                {subtitle}
              </span>
            )
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {tool.isError && (
              <span className="rounded bg-rose-200/70 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/60 dark:text-rose-300">
                error
              </span>
            )}
            {pending || subagentRunning ? (
              // In-flight tool (#175) or a still-working sub-agent (#429): a spinner
              // + "running" instead of the completion metadata it lacks yet (for a
              // background sub-agent, this replaces the misleading near-instant
              // launch-ack duration until its real run finishes).
              <span className="flex items-center gap-1.5 text-accent" title="Sub-agent is running">
                <span
                  className="h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent"
                  aria-hidden="true"
                />
                <span className="text-[10px] font-semibold uppercase tracking-wide">running</span>
              </span>
            ) : (
              <>
                {isBg && events.length > 0 && (
                  <span className="whitespace-nowrap text-[10px] text-sky-600 dark:text-sky-400">
                    {events.length} event{events.length === 1 ? "" : "s"}
                  </span>
                )}
                {isBg && tool.taskStatus && (
                  <span
                    className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${statusChipClass(
                      tool.taskStatus,
                    )}`}
                  >
                    {tool.taskStatus}
                  </span>
                )}
                {isEdit && (diff!.additions > 0 || diff!.deletions > 0) && (
                  <span className="whitespace-nowrap font-mono text-[10px] font-semibold tabular-nums">
                    {diff!.additions > 0 && (
                      <span className="text-emerald-600 dark:text-emerald-400">+{diff!.additions}</span>
                    )}
                    {diff!.additions > 0 && diff!.deletions > 0 && " "}
                    {diff!.deletions > 0 && (
                      <span className="text-rose-600 dark:text-rose-400">−{diff!.deletions}</span>
                    )}
                  </span>
                )}
                {readRange && (
                  <span className="whitespace-nowrap font-mono text-[10px] text-paddock-400 tabular-nums">
                    {readRange}
                  </span>
                )}
                {searchCount && (
                  <span className="whitespace-nowrap font-mono text-[10px] font-medium text-paddock-500 tabular-nums dark:text-paddock-400">
                    {searchCount}
                  </span>
                )}
                {bash?.gitHint && (
                  <span className="whitespace-nowrap rounded bg-paddock-200/70 px-1.5 py-0.5 font-mono text-[10px] text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300">
                    {bash.gitHint}
                  </span>
                )}
                {bash?.interrupted && (
                  <span className="whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                    interrupted
                  </span>
                )}
                {bash?.returnCodeInterpretation && (
                  <span className="max-w-[12rem] truncate whitespace-nowrap text-[10px] italic text-paddock-400">
                    {bash.returnCodeInterpretation}
                  </span>
                )}
                {dur && <span className="text-paddock-400">{dur}</span>}
                {cost && <span className="text-paddock-400">{cost}</span>}
              </>
            )}
          </span>
        </button>
        {open &&
          (expandable ? (
            <NestedSteps toolUseId={tool.toolUseId!} live={subagentRunning} />
          ) : isBg && events.length > 0 ? (
            // Monitor: the streamed events, grouped under the launching call
            // instead of scattered as separate pills (issue #230).
            <div className="max-h-72 overflow-auto border-t border-sky-200/60 bg-sky-50/40 dark:border-sky-900/50 dark:bg-sky-950/20">
              {events.map((e, i) => (
                <div
                  key={i}
                  className="whitespace-pre-wrap break-words border-b border-sky-200/40 px-3 py-1.5 font-mono text-[11.5px] leading-relaxed text-paddock-700 last:border-b-0 dark:border-sky-900/40 dark:text-paddock-300"
                >
                  {e}
                </div>
              ))}
            </div>
          ) : paddockManage ? (
            <PaddockManageBody data={paddockManage} />
          ) : isEdit ? (
            <DiffBody diff={diff!} />
          ) : imageUrl ? (
            <div className="border-t border-paddock-200/70 dark:border-paddock-800">
              <InlineImage src={imageUrl} filename={readInfo?.basename ?? "image"} />
            </div>
          ) : bashSplit ? (
            <BashBody bash={bash!} />
          ) : taskCreate && taskCreate.description ? (
            <TaskCreateBody info={taskCreate} />
          ) : (
            <div className="border-t border-paddock-200/70 dark:border-paddock-800">
              {isBg && tool.taskResultSummary && (
                <div className="border-b border-paddock-200/70 bg-sky-50/50 px-3 py-2 text-[11.5px] font-medium text-paddock-700 dark:border-paddock-800 dark:bg-sky-950/20 dark:text-paddock-200">
                  {tool.taskResultSummary}
                </div>
              )}
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-paddock-50/80 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-paddock-700 dark:bg-paddock-950/60 dark:text-paddock-300">
                {pending ? "Running…" : tool.output || "(no output)"}
              </pre>
            </div>
          ))}
      </div>
    </div>
  );
}

/**
 * The inline diff for an Edit/MultiEdit/Write tool call (issue #232 → #237): each
 * hunk rendered with a real `@@ -old +new @@` header, an old/new line-number gutter
 * (from `toolUseResult.structuredPatch`), and the +/- green/red tint. Height-capped
 * + scrollable; a truncated diff notes the cut.
 */
function DiffBody({ diff }: { diff: EditDiff }) {
  return (
    <div className="max-h-96 overflow-auto border-t border-paddock-200/70 bg-paddock-50/80 font-mono text-[11.5px] leading-relaxed dark:border-paddock-800 dark:bg-paddock-950/60">
      {diff.hunks.map((h, hi) => (
        <div
          key={hi}
          className={hi > 0 ? "border-t border-paddock-200/60 dark:border-paddock-800/60" : ""}
        >
          <div className="bg-paddock-100/70 px-3 py-1 font-mono text-[10px] font-semibold text-sky-700/80 dark:bg-paddock-900/50 dark:text-sky-400/80">
            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </div>
          {h.lines.map((l, li) => (
            <div key={li} className={`flex ${diffLineClass(l.t)}`}>
              <span className="w-8 shrink-0 select-none pr-1 text-right tabular-nums opacity-40">
                {gutter(l.oldLine)}
              </span>
              <span className="w-8 shrink-0 select-none pr-1 text-right tabular-nums opacity-40">
                {gutter(l.newLine)}
              </span>
              <span className="w-3 shrink-0 select-none text-center opacity-60">
                {l.t === " " ? "" : l.t}
              </span>
              <span className="whitespace-pre-wrap break-words pr-3">{l.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
      {diff.truncated && (
        <div className="px-3 py-1.5 text-[11px] italic text-paddock-400">
          … diff truncated (see the file for the full change)
        </div>
      )}
    </div>
  );
}

/** A small colored pill for one task status value (e.g. `pending`, `in_progress`). */
function TaskStatusPill({ status }: { status: string }) {
  return (
    <span
      className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${taskStatusPillClass(
        status,
      )}`}
    >
      {status}
    </span>
  );
}

/**
 * A Bash body that splits stdout (plain) from stderr (red), instead of the merged
 * output herdctl produces (issue #237). Only used when there IS a stderr to peel.
 */
function BashBody({ bash }: { bash: BashDetails }) {
  return (
    <div className="max-h-72 overflow-auto border-t border-paddock-200/70 dark:border-paddock-800">
      {bash.stdout && (
        <pre className="whitespace-pre-wrap break-words bg-paddock-50/80 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-paddock-700 dark:bg-paddock-950/60 dark:text-paddock-300">
          {bash.stdout}
        </pre>
      )}
      {bash.stderr && (
        <pre className="whitespace-pre-wrap break-words border-t border-rose-200/50 bg-rose-50/50 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-rose-700 first:border-t-0 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
          {bash.stderr}
        </pre>
      )}
    </div>
  );
}

/** A TaskCreate body: the task subject + description text (issue #237). */
function TaskCreateBody({ info }: { info: TaskCreateInfo }) {
  return (
    <div className="border-t border-paddock-200/70 bg-paddock-50/80 px-3 py-2 dark:border-paddock-800 dark:bg-paddock-950/60">
      {info.subject && (
        <div className="text-[12px] font-semibold text-paddock-700 dark:text-paddock-200">
          {info.subject}
        </div>
      )}
      {info.description && (
        <div className="mt-1 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-paddock-600 dark:text-paddock-400">
          {info.description}
        </div>
      )}
    </div>
  );
}

/** How often to re-fetch a live sub-agent's growing transcript while it runs (#429). */
const NESTED_POLL_MS = 2000;

/**
 * A sub-agent's own step-by-step transcript, lazy-loaded on first expand and
 * rendered inline (issue #37). Reuses TurnView, so any Task/Agent steps the
 * sub-agent itself ran render as further-expandable ToolBlocks — arbitrary depth
 * through the same SubagentFetchContext (sub-agents are flat under the session).
 *
 * When `live` (the sub-agent is still working, #429) it POLLS the endpoint every
 * {@link NESTED_POLL_MS}: the sub-agent's transcript grows on disk as it runs, so
 * each re-fetch surfaces its new steps INSIDE the card without a refresh — nested
 * launches recurse through the same path. The last loaded steps stay visible
 * across polls (no flash back to the spinner), and a transient read error while
 * live just retries rather than tearing the stream down.
 */
function NestedSteps({ toolUseId, live = false }: { toolUseId: string; live?: boolean }) {
  const fetchSubagent = useContext(SubagentFetchContext);
  const [msgs, setMsgs] = useState<HistoryMessage[] | null>(null);
  const [error, setError] = useState(false);

  // Reset only when the sub-agent changes — NOT when `live` flips off, so the
  // finished steps don't flash back to the loading spinner as the turn settles.
  useEffect(() => {
    setMsgs(null);
    setError(false);
  }, [toolUseId]);

  useEffect(() => {
    if (!fetchSubagent) {
      setError(true);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      fetchSubagent(toolUseId)
        .then((m) => {
          if (cancelled) return;
          setMsgs(m);
          if (live) timer = setTimeout(tick, NESTED_POLL_MS);
        })
        .catch(() => {
          if (cancelled) return;
          // Keep streaming through a transient read error while live (retry); a
          // one-shot history load surfaces it.
          if (live) timer = setTimeout(tick, NESTED_POLL_MS);
          else setError(true);
        });
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchSubagent, toolUseId, live]);

  const turns = useMemo(() => historyToTurns(msgs ?? []), [msgs]);

  return (
    <div className="border-t border-paddock-200/70 bg-paddock-50/60 px-3 py-3 dark:border-paddock-800 dark:bg-paddock-950/40">
      {error ? (
        <div className="text-[11.5px] text-rose-500">couldn't load sub-agent steps</div>
      ) : msgs === null ? (
        <div className="flex items-center gap-1.5 text-[11.5px] text-paddock-400">
          <Dot /> <Dot delay="150ms" /> <Dot delay="300ms" />
          <span className="ml-1">loading sub-agent steps…</span>
        </div>
      ) : turns.length === 0 ? (
        <div className="flex items-center gap-1.5 text-[11.5px] text-paddock-400">
          {live ? (
            <>
              <Dot /> <Dot delay="150ms" /> <Dot delay="300ms" />
              <span className="ml-1">waiting for sub-agent steps…</span>
            </>
          ) : (
            <span>(no recorded steps)</span>
          )}
        </div>
      ) : (
        <div className="space-y-3 border-l-2 border-accent/30 pl-3">
          {turns.map((t) => (
            <TurnView key={t.id} turn={t} />
          ))}
          {live && (
            <div className="flex items-center gap-1.5 text-[11px] text-accent/80">
              <Dot /> <Dot delay="150ms" /> <Dot delay="300ms" />
              <span className="ml-1">sub-agent working…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
