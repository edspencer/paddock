import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type ToolCall } from "../../lib/ws";
import {
  formatDuration,
  formatTokens,
  formatUsd,
  isTerminatedTaskStatus,
  relativeTime,
} from "../../lib/format";
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
  BranchIcon,
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
  SubagentActivityContext,
  SubagentFetchContext,
  SubagentFocusContext,
  SubagentLiveContext,
  ToolImageUrlContext,
  TurnActionsContext,
} from "./chatContexts";
import {
  SUBAGENT_TOOLS,
  diffLineClass,
  gutter,
  isBackgroundTool,
  isSubagentRunning,
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
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent-solid px-4 py-2.5 text-sm text-accent-fg shadow-sm">
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
        <span className="rounded-full bg-surface-active px-2.5 py-0.5 font-mono text-xs text-fg-muted ring-1 ring-edge">
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
          className="max-w-[85%] truncate rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs italic text-fg-muted ring-1 ring-edge"
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
      <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-surface-raised px-4 py-2.5 text-fg shadow-sm ring-1 ring-edge">
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

/** A reload-stable turn id is the Claude Code record uuid (optionally `#n`). Live
 *  streamed turns use an ephemeral `t<n>` counter, which we must NOT anchor
 *  fork/revert on — gate on the uuid shape. */
const UUID_TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-/;

/**
 * Wraps a rendered turn with the per-message hover rail (issue #451): a floating
 * cluster — revealed on hover — showing the message time and the context-window
 * fill as of that point, plus "Fork from here" and "Revert to here" buttons. The
 * rail only appears on reloaded user/assistant turns (which carry a stable uuid +
 * timestamp) when the chat exposes the actions; every other turn renders bare.
 */
export function TurnRow({ turn }: { turn: Turn }) {
  const actions = useContext(TurnActionsContext);
  const anchorable =
    !!actions &&
    (turn.kind === "user" || turn.kind === "assistant") &&
    typeof turn.timestamp === "string" &&
    UUID_TURN_ID.test(turn.id);
  if (!anchorable) return <TurnView turn={turn} />;

  const uuid = turn.id.split("#")[0];
  const ctx = turn.contextTokens;
  const limit = actions.contextLimit;
  const pct = ctx != null && limit ? Math.min(100, Math.round((ctx / limit) * 100)) : null;
  const chip =
    "flex items-center rounded-full bg-surface/95 shadow-sm ring-1 ring-edge backdrop-blur";

  // Reveal the rail on hover OR keyboard focus (`focus-within`), so tabbing to a
  // fork/revert button actually shows it instead of leaving an invisible focus
  // stop (#451 QA). `focus-visible` rings give each button a keyboard focus cue.
  const btn = `${chip} h-6 w-6 justify-center text-fg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent`;

  return (
    <div className="group relative">
      <div className="pointer-events-none absolute -top-3 right-1 z-10 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <span
          className={`${chip} gap-1 px-2 py-0.5 text-2xs text-fg-muted`}
          title={new Date(turn.timestamp!).toLocaleString()}
        >
          <span>{relativeTime(turn.timestamp)}</span>
          {ctx != null ? (
            <span className="text-fg-subtle tabular" title="Context-window fill as of this message">
              · {formatTokens(ctx)}
              {pct != null ? ` · ${pct}%` : ""}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => actions.onFork(uuid)}
          title="Fork a new chat from here"
          aria-label="Fork a new chat from here"
          className={`${btn} hover:text-accent`}
        >
          <BranchIcon width={13} height={13} />
        </button>
        <button
          type="button"
          onClick={() => actions.onRevert(uuid)}
          title="Revert conversation back to here"
          aria-label="Revert conversation back to here"
          className={`${btn} hover:text-danger`}
        >
          <ClockIcon width={13} height={13} />
        </button>
      </div>
      <TurnView turn={turn} />
    </div>
  );
}

function Dot({ delay }: { delay?: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-fg-subtle"
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
      <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-surface-sunken px-4 py-2.5 text-fg shadow-sm ring-1 ring-edge">
        <div className="mb-1 flex items-center gap-1 text-2xs italic text-fg-muted">
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
        <summary className="flex cursor-pointer list-none items-center gap-3 text-xs text-fg-muted">
          <span className="h-px flex-1 bg-edge" />
          <span className="whitespace-nowrap">🗜️ conversation compacted</span>
          <span className="h-px flex-1 bg-edge" />
        </summary>
        <div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-sunken px-3 py-2 text-xs text-fg-muted ring-1 ring-edge">
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
    "mb-1 flex items-center gap-1 text-2xs italic text-fg-muted";
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
 * or there is no keeper session to recover, only the explanatory notice shows.
 * `busy` disables the button while a turn is already streaming.
 */
function KilledTaskNotice({ summary }: { summary: string }) {
  const recovery = useContext(RecoveryContext);
  const canContinue = Boolean(recovery?.enabled);
  const busy = Boolean(recovery?.busy);
  return (
    <div className="flex animate-fade-in justify-center" data-recovery="killed-task">
      <div className="flex max-w-[90%] flex-col gap-1.5 rounded-lg border border-warn-edge bg-warn-soft px-3 py-2 text-xs text-warn">
        <div className="flex items-start gap-1.5">
          <span aria-hidden className="leading-tight">
            ⚠
          </span>
          <span className="leading-snug">
            A background task was terminated at the turn boundary — Claude is idle
            and will not continue on its own.
            <span className="mt-0.5 block text-2xs text-warn">
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
              className="motion-fast rounded-md bg-warn-solid px-2.5 py-1 text-2xs font-medium text-warn-fg shadow-sm transition-[filter,box-shadow,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
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
    ? "border-danger-edge bg-danger-soft text-danger"
    : "border-warn-edge bg-warn-soft text-warn";
  const btnTone = isError
    ? "bg-danger-solid text-danger-fg hover:brightness-110"
    : "bg-warn-solid text-warn-fg hover:brightness-110";
  const detailTone = isError ? "text-danger" : "text-warn";
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
              <span className={`mt-0.5 block text-2xs ${detailTone}`}>
                Resets {notice.resetTime}. Claude will respond again after the quota resets.
              </span>
            )}
            {isError && notice.detail && (
              <span className={`mt-0.5 block break-words font-mono text-2xs ${detailTone}`}>
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
              className={`motion-fast rounded-md px-2.5 py-1 text-2xs font-medium shadow-sm transition-[filter,box-shadow,opacity] disabled:cursor-not-allowed disabled:opacity-50 ${btnTone}`}
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
  // Reveal-from-the-bar wiring: tapping a running sub-agent in the bar expands
  // THIS card, scrolls it into view, and flashes it. `focused` carries a nonce so
  // re-tapping the same sub-agent replays the flash (see SubagentFocusContext).
  const focusCtx = useContext(SubagentFocusContext);
  const cardRef = useRef<HTMLDivElement>(null);
  const [revealing, setRevealing] = useState(false);
  const focusedNonce =
    focusCtx?.focused && focusCtx.focused.toolUseId === tool.toolUseId
      ? focusCtx.focused.nonce
      : null;
  useEffect(() => {
    if (focusedNonce == null) return;
    setOpen(true);
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setRevealing(true);
    // Matches the .subagent-reveal keyframes (1.6s × 2) so the class is removed
    // once the flash is done and a later reveal can re-trigger it.
    const t = setTimeout(() => setRevealing(false), 3200);
    return () => clearTimeout(t);
  }, [focusedNonce]);
  // #429: whether this chat has a live turn in flight. Drives the sub-agent
  // running indicator + nested-step polling while the sub-agent works (incl. a
  // background sub-agent whose launch-ack tool_call already completed).
  const chatLive = useContext(SubagentLiveContext);
  // Live per-sub-agent steps, polled once by the chat (see useSubagentActivity).
  // Drives both this card's running subtitle and its nested-step body.
  const subagentActivity = useContext(SubagentActivityContext);
  // In-flight tool (#175): rendered before it completes — no output/duration
  // yet, just a "running…" affordance so a slow tool/subagent is visibly alive.
  const pending = Boolean(tool.pending);
  const isSubagent = SUBAGENT_TOOLS.has(tool.toolName);
  const liveActivity = tool.toolUseId ? subagentActivity?.get(tool.toolUseId) : undefined;
  // A sub-agent's duration must NEVER fall back to its launching tool_call's own
  // `durationMs`. The SDK backgrounds sub-agents by default, so that call returns
  // as soon as the sub-agent is spawned — a four-minute research run advertised
  // itself as "38ms", which is not a rounding error but a different quantity.
  //
  // Preference order: the server's final figure (history join on reload), else
  // the first→last span of the transcript we are already polling, else nothing.
  // Showing NOTHING is the correct third option: an honest gap beats a wrong
  // number. Non-sub-agent tools are unaffected and still use their own duration.
  const dur = isSubagent
    ? formatDuration(tool.subagentDurationMs ?? liveActivity?.elapsedMs)
    : formatDuration(tool.durationMs);
  // A sub-agent's estimated API-rate cost, priced server-side per-model (issue
  // #166). Rendered next to the duration; null when its model has no pricing.
  const cost = tool.subagentCostUsd != null ? `~${formatUsd(tool.subagentCostUsd)}` : null;
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
  // Is this sub-agent still working? Its OWN transcript is the authority, because
  // a sub-agent outlives its parent's turn: the SDK backgrounds sub-agents by
  // default, so the parent finishes its reply — and the chat stops streaming —
  // while they keep going. Judging by `chatLive` alone made every card snap to
  // "finished" the moment the parent replied. Falls back to the old predicate
  // before the first poll lands, and for a nested sub-agent (only top-level ones
  // are polled).
  const subagentRunning =
    liveActivity != null ? liveActivity.running : isSubagentRunning(tool, chatLive);
  // Expandable-into-steps once the launch is known (live) or its transcript is on
  // disk (history). #429 relaxes the old `!pending` guard for sub-agents: the
  // launching card is now expandable the instant it starts, and NestedSteps polls
  // the (growing) transcript live — showing a "waiting…" placeholder until the
  // sidecar appears. Non-sub-agent tools are unaffected.
  const expandable = Boolean(isSubagent && tool.hasSubagent && tool.toolUseId);
  // WHILE a sub-agent works, its header reports what it is doing RIGHT NOW rather
  // than the static description it was launched with — the same latest-step the
  // running-sub-agents bar shows, read from the same shared poll. A collapsed card
  // is the common case, so this is where the progress is actually wanted.
  //
  // Falls back to the description whenever there is no step to show: before the
  // first poll returns, and for a nested sub-agent (only top-level ones are
  // polled). The description returns as the subtitle the moment the sub-agent
  // finishes — `subagentRunning` goes false — and stays reachable on hover
  // meanwhile, so replacing it costs nothing.
  const liveStep =
    subagentRunning && tool.toolUseId
      ? subagentActivity?.get(tool.toolUseId)?.latestStep
      : undefined;
  // Sub-agent header reads as "<type> — <description>"; the detail-bearing tools show
  // a friendlier subtitle; others keep the classic "<toolName> <inputSummary>".
  const label = isSubagent
    ? (tool.subagentType ?? tool.toolName)
    : mcp.isMcp
      ? mcp.display
      : tool.toolName;
  const subtitle = isSubagent
    ? (liveStep ?? tool.description)
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
  // While a live step has taken the subtitle's place, hover surfaces the sub-agent's
  // description instead, so what it was ASKED to do is never actually lost.
  const subtitleTitle =
    readInfo?.filePath ??
    taskCreate?.description ??
    (liveStep ? tool.description : undefined) ??
    subtitle ??
    undefined;
  return (
    <div className="flex justify-start">
      <div
        ref={cardRef}
        className={`motion-fast w-full max-w-[92%] overflow-hidden rounded-xl border text-xs transition-[color,background-color,border-color] ${
          revealing ? "subagent-reveal " : ""
        }${
          tool.isError
            ? "border-danger-edge bg-danger-soft"
            : isSubagent
              ? "border-accent-edge bg-accent-soft"
              : isBg
                ? "border-info-edge bg-info-soft"
                : "border-edge bg-surface-raised"
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
            className={`motion-fast shrink-0 text-fg-subtle transition-transform ${open ? "rotate-90" : ""}`}
          />
          {isSubagent ? (
            <SparkIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-danger" : "text-accent"}`}
            />
          ) : isBg ? (
            <ClockIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-danger" : "text-info"}`}
            />
          ) : PaddockIcon ? (
            <PaddockIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-danger" : "text-accent"}`}
            />
          ) : isEdit ? (
            <PencilIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-danger" : "text-fg-muted"}`}
            />
          ) : readInfo ? (
            <FileIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-danger" : "text-fg-muted"}`}
            />
          ) : search ? (
            <SearchIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-danger" : "text-fg-muted"}`}
            />
          ) : taskUpdate || taskCreate ? (
            <CheckIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-danger" : "text-fg-muted"}`}
            />
          ) : (
            <WrenchIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-danger" : "text-fg-muted"}`}
            />
          )}
          <span className="shrink-0 whitespace-nowrap font-mono font-semibold text-fg">
            {label}
          </span>
          {isSubagent && (
            <span className="shrink-0 whitespace-nowrap rounded bg-accent-soft px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-accent">
              sub-agent
            </span>
          )}
          {isBg && (
            <span className="shrink-0 whitespace-nowrap rounded bg-info-soft px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-info">
              background
            </span>
          )}
          {mcp.isPaddock && (
            // Paddock's own injected MCP tool — a brand badge so it reads as a
            // first-class Paddock action, not a random tool (issue #253). When the
            // action targets a specific project (e.g. a cross-project create/fork/
            // read/send in another project), label it with that target project so
            // the badge matches the card body's "in {project}" line instead of
            // reading as the host project's brand name.
            <span className="shrink-0 whitespace-nowrap rounded bg-accent-soft px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-accent">
              {paddockManage && "project" in paddockManage && paddockManage.project
                ? paddockManage.project
                : "Paddock"}
            </span>
          )}
          {mcp.isMcp && !mcp.isPaddock && (
            <span className="shrink-0 whitespace-nowrap rounded bg-surface-active px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-fg-muted">
              MCP
            </span>
          )}
          {taskUpdate ? (
            // A TaskUpdate status transition: colored from → to pills (#237).
            <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-fg-muted">
              {taskUpdate.taskId && <span className="shrink-0">Task #{taskUpdate.taskId}</span>}
              {taskUpdate.from && taskUpdate.to ? (
                <span className="flex shrink-0 items-center gap-1">
                  <TaskStatusPill status={taskUpdate.from} />
                  <span className="text-fg-subtle">→</span>
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
                className={`min-w-0 truncate font-mono ${
                  // A live step is activity, not a title — tint it so the header
                  // doesn't read as though the sub-agent were renamed mid-run.
                  liveStep ? "text-accent" : "text-fg-muted"
                }`}
                title={subtitleTitle}
              >
                {subtitle}
              </span>
            )
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {tool.isError && (
              <span className="rounded bg-danger-soft px-1.5 py-0.5 text-3xs font-semibold text-danger">
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
                  className="h-3 w-3 animate-spin rounded-full border-2 border-accent-edge border-t-accent"
                  aria-hidden="true"
                />
                <span className="text-3xs font-semibold uppercase tracking-wide">running</span>
              </span>
            ) : (
              <>
                {isBg && events.length > 0 && (
                  <span className="whitespace-nowrap text-3xs text-info">
                    {events.length} event{events.length === 1 ? "" : "s"}
                  </span>
                )}
                {isBg && tool.taskStatus && (
                  <span
                    className={`whitespace-nowrap rounded px-1.5 py-0.5 text-3xs font-semibold ${statusChipClass(
                      tool.taskStatus,
                    )}`}
                  >
                    {tool.taskStatus}
                  </span>
                )}
                {isEdit && (diff!.additions > 0 || diff!.deletions > 0) && (
                  <span className="whitespace-nowrap font-mono text-3xs font-semibold tabular">
                    {diff!.additions > 0 && (
                      <span className="text-success">+{diff!.additions}</span>
                    )}
                    {diff!.additions > 0 && diff!.deletions > 0 && " "}
                    {diff!.deletions > 0 && <span className="text-danger">−{diff!.deletions}</span>}
                  </span>
                )}
                {readRange && (
                  <span className="whitespace-nowrap font-mono text-3xs text-fg-subtle tabular">
                    {readRange}
                  </span>
                )}
                {searchCount && (
                  <span className="whitespace-nowrap font-mono text-3xs font-medium text-fg-muted tabular">
                    {searchCount}
                  </span>
                )}
                {bash?.gitHint && (
                  <span className="whitespace-nowrap rounded bg-surface-active px-1.5 py-0.5 font-mono text-3xs text-fg-muted">
                    {bash.gitHint}
                  </span>
                )}
                {bash?.interrupted && (
                  <span className="whitespace-nowrap rounded bg-warn-soft px-1.5 py-0.5 text-3xs font-semibold text-warn">
                    interrupted
                  </span>
                )}
                {bash?.returnCodeInterpretation && (
                  <span className="max-w-[12rem] truncate whitespace-nowrap text-3xs italic text-fg-subtle">
                    {bash.returnCodeInterpretation}
                  </span>
                )}
                {dur && <span className="text-fg-subtle tabular">{dur}</span>}
                {cost && <span className="text-fg-subtle tabular">{cost}</span>}
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
            <div className="max-h-72 overflow-auto border-t border-info-edge bg-info-soft">
              {events.map((e, i) => (
                <div
                  key={i}
                  className="whitespace-pre-wrap break-words border-b border-info-edge px-3 py-1.5 font-mono text-2xs leading-relaxed text-fg-muted last:border-b-0"
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
            <div className="border-t border-edge">
              <InlineImage src={imageUrl} filename={readInfo?.basename ?? "image"} />
            </div>
          ) : bashSplit ? (
            <BashBody bash={bash!} />
          ) : taskCreate && taskCreate.description ? (
            <TaskCreateBody info={taskCreate} />
          ) : (
            <div className="border-t border-edge">
              {isBg && tool.taskResultSummary && (
                <div className="border-b border-edge bg-info-soft px-3 py-2 text-2xs font-medium text-fg">
                  {tool.taskResultSummary}
                </div>
              )}
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-surface-sunken px-3 py-2 font-mono text-2xs leading-relaxed text-fg-muted">
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
    <div className="max-h-96 overflow-auto border-t border-edge bg-surface-sunken font-mono text-2xs leading-relaxed">
      {diff.hunks.map((h, hi) => (
        <div key={hi} className={hi > 0 ? "border-t border-edge" : ""}>
          <div className="bg-surface-active px-3 py-1 font-mono text-3xs font-semibold text-lineage">
            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </div>
          {h.lines.map((l, li) => (
            <div key={li} className={`flex ${diffLineClass(l.t)}`}>
              <span className="w-8 shrink-0 select-none pr-1 text-right tabular opacity-40">
                {gutter(l.oldLine)}
              </span>
              <span className="w-8 shrink-0 select-none pr-1 text-right tabular opacity-40">
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
        <div className="px-3 py-1.5 text-2xs italic text-fg-subtle">
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
      className={`whitespace-nowrap rounded px-1.5 py-0.5 text-3xs font-semibold ${taskStatusPillClass(
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
    <div className="max-h-72 overflow-auto border-t border-edge">
      {bash.stdout && (
        <pre className="whitespace-pre-wrap break-words bg-surface-sunken px-3 py-2 font-mono text-2xs leading-relaxed text-fg-muted">
          {bash.stdout}
        </pre>
      )}
      {bash.stderr && (
        <pre className="whitespace-pre-wrap break-words border-t border-danger-edge bg-danger-soft px-3 py-2 font-mono text-2xs leading-relaxed text-danger first:border-t-0">
          {bash.stderr}
        </pre>
      )}
    </div>
  );
}

/** A TaskCreate body: the task subject + description text (issue #237). */
function TaskCreateBody({ info }: { info: TaskCreateInfo }) {
  return (
    <div className="border-t border-edge bg-surface-sunken px-3 py-2">
      {info.subject && <div className="text-xs font-semibold text-fg">{info.subject}</div>}
      {info.description && (
        <div className="mt-1 whitespace-pre-wrap break-words text-2xs leading-relaxed text-fg-muted">
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
  // A RUNNING sub-agent is already being polled once per tick by the chat (to feed
  // the running-sub-agents bar), so read its steps from that shared result rather
  // than opening a second poll for the same file. Absent for a finished sub-agent,
  // which nothing polls — that still lazy-loads below.
  const shared = useContext(SubagentActivityContext)?.get(toolUseId)?.messages;

  // Reset only when the sub-agent changes — NOT when `live` flips off, so the
  // finished steps don't flash back to the loading spinner as the turn settles.
  useEffect(() => {
    setMsgs(null);
    setError(false);
  }, [toolUseId]);

  useEffect(() => {
    // Shared polling is covering this sub-agent — don't open a duplicate poll.
    if (shared) return;
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
  }, [fetchSubagent, toolUseId, live, Boolean(shared)]);

  // Prefer the shared live steps; fall back to this card's own lazy fetch. Keeping
  // the last-known list on either side means a card never flashes back to a spinner
  // as the turn settles and shared polling stops.
  const effective = shared ?? msgs;
  const turns = useMemo(() => historyToTurns(effective ?? []), [effective]);

  return (
    // `data-testid` is for the E2E (#725): "the expanded step list keeps
    // updating" has to be measured HERE and nowhere else. The running-sub-agents
    // bar renders the same latest step, so a page-wide scan for step text would
    // pass on the bar alone while this card stayed frozen — which is precisely
    // the half of the bug a naive assertion misses.
    <div
      data-testid="subagent-steps"
      className="border-t border-edge bg-surface-sunken px-3 py-3"
    >
      {error ? (
        <div className="text-2xs text-danger">couldn't load sub-agent steps</div>
      ) : effective == null ? (
        <div className="flex items-center gap-1.5 text-2xs text-fg-subtle">
          <Dot /> <Dot delay="150ms" /> <Dot delay="300ms" />
          <span className="ml-1">loading sub-agent steps…</span>
        </div>
      ) : turns.length === 0 ? (
        <div className="flex items-center gap-1.5 text-2xs text-fg-subtle">
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
        <div className="space-y-3 border-l-2 border-accent-edge pl-3">
          {turns.map((t) => (
            <TurnView key={t.id} turn={t} />
          ))}
          {live && (
            <div className="flex items-center gap-1.5 text-2xs text-accent">
              <Dot /> <Dot delay="150ms" /> <Dot delay="300ms" />
              <span className="ml-1">sub-agent working…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
