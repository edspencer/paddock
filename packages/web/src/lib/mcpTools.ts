// Prettify + parse Paddock's own injected MCP tools so they render as first-class
// UI instead of a raw `mcp__paddock_manage__create_chat` name over a JSON blob
// (issue #253). Pure/parse helpers live here (unit-testable); the React bodies
// live in components/PaddockManageBlock.tsx.
//
// Two levers, both derivable from data the web already has:
//   1. The tool NAME (`mcp__<server>__<tool>`) → a humanized label + provenance.
//   2. The tool OUTPUT (a JSON string the tool returns) → structured content,
//      parsed client-side exactly like send_file's `sentFileFromToolCall`.

/** Result of splitting an `mcp__<server>__<tool>` name into readable parts. */
export interface McpToolInfo {
  /** True when the name is an MCP tool (`mcp__…`). */
  isMcp: boolean;
  /** The MCP server segment, e.g. `paddock_manage` (empty for a non-mcp name). */
  server: string;
  /** True for one of Paddock's own servers (`paddock` / `paddock_manage`). */
  isPaddock: boolean;
  /** Humanized tool label, e.g. `create_chat` → "Create chat". */
  display: string;
  /** The bare tool segment, e.g. `create_chat` (for keyed dispatch). */
  tool: string;
}

/** Paddock's own injected MCP servers. */
const PADDOCK_SERVERS = new Set(["paddock", "paddock_manage"]);

/** `create_chat` → "Create chat"; leaves an already-spaced label alone. */
function humanize(segment: string): string {
  const spaced = segment.replace(/_/g, " ").trim();
  if (!spaced) return segment;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Split `mcp__<server>__<tool>` into a humanized label + provenance. Non-mcp
 * names pass through unchanged (`isMcp:false`, `display` = the raw name).
 */
export function mcpToolInfo(toolName: string): McpToolInfo {
  if (!toolName.startsWith("mcp__")) {
    return { isMcp: false, server: "", isPaddock: false, display: toolName, tool: toolName };
  }
  // The server segment is everything up to the next `__`; the tool is the rest
  // (a tool segment may itself contain single underscores, e.g. `create_chat`).
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  const server = sep === -1 ? rest : rest.slice(0, sep);
  const tool = sep === -1 ? "" : rest.slice(sep + 2);
  return {
    isMcp: true,
    server,
    isPaddock: PADDOCK_SERVERS.has(server),
    display: humanize(tool || server),
    tool,
  };
}

// ── paddock_manage result shapes (mirror the server `ok(...)` payloads) ────────

export interface PmProject {
  slug: string;
  name: string;
  area?: string;
  status?: string;
}
export interface PmChat {
  project: string;
  sessionId: string;
  name: string;
  updatedAt?: string;
  running?: boolean;
}
export interface PmMessage {
  role: string;
  text: string;
  timestamp?: string;
}
export interface PmFork {
  sessionId: string;
  prompt: string;
}

/** Parsed, discriminated `paddock_manage` result (from the tool's JSON output). */
export type PaddockManage =
  | { tool: "list_projects"; count: number; projects: PmProject[] }
  | { tool: "list_chats"; count: number; project: string | null; chats: PmChat[] }
  | {
      tool: "read_chat";
      project: string;
      sessionId: string;
      total: number;
      returned: number;
      messages: PmMessage[];
    }
  | { tool: "create_chat"; project: string; sessionId: string }
  | { tool: "fork_chat"; project: string; sessionId: string; from?: string }
  | { tool: "send_message"; project: string; sessionId: string }
  | { tool: "fork_chat_batch"; count: number; source: string; forks: PmFork[] };

const PM_PREFIX = "mcp__paddock_manage__";

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * Parse a `mcp__paddock_manage__*` tool call's JSON `output` into a typed shape,
 * or null when the name isn't ours / the output isn't a valid payload (caller
 * falls back to the generic tool body). Mirrors `sentFileFromToolCall`.
 */
export function parsePaddockManage(
  toolName: string,
  output: string | undefined,
): PaddockManage | null {
  if (!toolName.startsWith(PM_PREFIX) || !output) return null;
  const tool = toolName.slice(PM_PREFIX.length);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(output) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  switch (tool) {
    case "list_projects": {
      if (!Array.isArray(data.projects)) return null;
      const projects = data.projects as PmProject[];
      return { tool, count: num(data.count, projects.length), projects };
    }
    case "list_chats": {
      if (!Array.isArray(data.chats)) return null;
      const chats = data.chats as PmChat[];
      return {
        tool,
        count: num(data.count, chats.length),
        project: (data.project as string) ?? null,
        chats,
      };
    }
    case "read_chat": {
      if (!Array.isArray(data.messages)) return null;
      const messages = data.messages as PmMessage[];
      return {
        tool,
        project: String(data.project ?? ""),
        sessionId: String(data.sessionId ?? ""),
        total: num(data.total, messages.length),
        returned: num(data.returned, messages.length),
        messages,
      };
    }
    case "create_chat":
    case "send_message": {
      if (!data.sessionId) return null;
      return { tool, project: String(data.project ?? ""), sessionId: String(data.sessionId) };
    }
    case "fork_chat": {
      if (!data.sessionId) return null;
      return {
        tool,
        project: String(data.project ?? ""),
        sessionId: String(data.sessionId),
        from: data.from ? String(data.from) : undefined,
      };
    }
    case "fork_chat_batch": {
      if (!Array.isArray(data.forks)) return null;
      const forks = data.forks as PmFork[];
      return { tool, count: num(data.count, forks.length), source: String(data.source ?? ""), forks };
    }
    default:
      return null;
  }
}

/** A one-line header subtitle for a parsed paddock_manage result. */
export function paddockManageSummary(pm: PaddockManage): string {
  switch (pm.tool) {
    case "list_projects":
      return `${pm.count} ${pm.count === 1 ? "project" : "projects"}`;
    case "list_chats":
      return (
        `${pm.count} ${pm.count === 1 ? "chat" : "chats"}` +
        (pm.project ? ` in ${pm.project}` : " across all projects")
      );
    case "read_chat":
      return `${pm.project} · ${pm.returned}/${pm.total} messages`;
    case "create_chat":
      return `new chat in ${pm.project}`;
    case "fork_chat":
      return `forked into ${pm.project}`;
    case "send_message":
      return `message to ${pm.project}`;
    case "fork_chat_batch":
      return `fanned out ${pm.count} ${pm.count === 1 ? "chat" : "chats"}`;
  }
}
