import { type ToolCall } from "../../lib/ws";
import { api } from "../../lib/api";
import { BranchIcon, ChatIcon, FolderIcon, PlusIcon, SendIcon } from "../icons";
import type { ReadInfo, SearchInfo, SentFile, SentFileEnvelope } from "../../lib/types";

/** Tool names that launch a sub-agent: `Task` (classic Claude Code), `Agent` (SDK). */
export const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/** The send_file MCP tool; its payload renders as a rich `file` turn (issue #112). */
export const SEND_FILE_TOOL_NAME = "mcp__paddock__send_file";

/** Background-task *ops* (badge only) — they operate on an already-detached task. */
export const BACKGROUND_OP_TOOLS = new Set(["BashOutput", "TaskOutput", "TaskStop", "KillShell"]);
/** A `run_in_background` launch echoes this in its output ("…with ID: <id>"). */
export const BG_LAUNCH_RE = /running in (?:the )?background with ID: [A-Za-z0-9]+/i;

/**
 * True when a tool call ran detached: a `Monitor`, a background-task op, or a
 * `run_in_background` launch (issue #230). Prefers the server-enriched `background`
 * flag (history), and falls back to sniffing the tool name/output so the live path
 * — whose WS frame carries no enrichment — still gets the badge.
 */
export function isBackgroundTool(tool: ToolCall): boolean {
  if (tool.background) return true;
  if (tool.toolName === "Monitor" || BACKGROUND_OP_TOOLS.has(tool.toolName)) return true;
  return BG_LAUNCH_RE.test(tool.output ?? "");
}

/** Tailwind classes for a background task's status chip, by terminal state. */
export function statusChipClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300";
    case "killed":
    case "timed out":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300";
    case "running":
    case "persistent":
      return "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300";
    default:
      return "bg-paddock-200/70 text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300";
  }
}

/** Per-tool icon for a Paddock `paddock_manage` tool segment (issue #253). */
export function paddockMcpIcon(tool: string) {
  switch (tool) {
    case "list_projects":
      return FolderIcon;
    case "create_chat":
      return PlusIcon;
    case "fork_chat":
    case "fork_chat_batch":
      return BranchIcon;
    case "send_message":
      return SendIcon;
    default:
      // list_chats, read_chat, and any future paddock tool.
      return ChatIcon;
  }
}

/**
 * Resolve a `mcp__paddock__send_file` tool call into a renderable SentFile by
 * parsing the JSON envelope the tool returns as its `output` (issue #112). This
 * is the single path for both live (`onToolCall`) and reload (`historyToTurn`):
 * the tool output is preserved verbatim on the live event AND by herdctl's
 * history parser, so a refresh renders identically. A real-file send carries an
 * opaque `attachmentId`; we point `rawUrl` at Paddock's attachment endpoint.
 * Returns null if the tool isn't ours or the output isn't a valid envelope
 * (caller falls back to the generic tool widget).
 */
export function sentFileFromToolCall(tc: ToolCall): SentFile | null {
  if (tc.toolName !== SEND_FILE_TOOL_NAME || !tc.output) return null;
  let env: SentFileEnvelope;
  try {
    env = JSON.parse(tc.output) as SentFileEnvelope;
  } catch {
    return null;
  }
  if (!env || env.paddockSendFile !== 1 || typeof env.filename !== "string") return null;
  return {
    filename: env.filename,
    kind: env.kind,
    language: env.language,
    message: env.message,
    source: env.source,
    content: env.source === "inline" ? env.content : undefined,
    rawUrl:
      env.source === "file" && env.attachmentId
        ? api.chatFileRawUrl(env.attachmentId)
        : undefined,
  };
}

/** Line coloring for a diff line by its kind (`+` add, `-` del, ` ` context). */
export function diffLineClass(t: "+" | "-" | " "): string {
  if (t === "+") return "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300";
  if (t === "-") return "bg-rose-50 text-rose-800 dark:bg-rose-950/30 dark:text-rose-300";
  return "text-paddock-600 dark:text-paddock-400";
}

/** Right-align a line number into the fixed-width gutter cell (blank when absent). */
export function gutter(n?: number): string {
  return n === undefined ? "" : String(n);
}

/** Tailwind classes for a task-status pill, by state (issue #237). */
export function taskStatusPillClass(status: string): string {
  switch (status) {
    case "completed":
    case "done":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300";
    case "in_progress":
      return "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300";
    case "blocked":
    case "failed":
    case "cancelled":
      return "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300";
    default: // pending & anything else
      return "bg-paddock-200/70 text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300";
  }
}

/** The count chip text for a Grep/Glob search result (issue #237). */
export function searchCountLabel(s: SearchInfo): string | null {
  const parts: string[] = [];
  if (s.kind === "grep") {
    if (s.numLines !== undefined) parts.push(`${s.numLines} line${s.numLines === 1 ? "" : "s"}`);
    if (s.numFiles !== undefined) parts.push(`${s.numFiles} file${s.numFiles === 1 ? "" : "s"}`);
  } else {
    const n = s.totalMatches ?? s.numFiles;
    if (n !== undefined) parts.push(`${n} match${n === 1 ? "" : "es"}`);
  }
  if (!parts.length) return null;
  return (s.truncated ? "≥" : "") + parts.join(" · ");
}

/** The `lines a–b of N` range chip text for a Read (issue #237). */
export function readRangeLabel(r: ReadInfo): string | null {
  if (r.startLine === undefined || r.numLines === undefined) return null;
  const end = r.startLine + Math.max(0, r.numLines - 1);
  const of = r.totalLines !== undefined ? ` of ${r.totalLines}` : "";
  return `lines ${r.startLine}–${end}${of}`;
}
