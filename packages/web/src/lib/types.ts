// Shared DTO types mirroring the paddock-server API + WS protocol.
// Kept in sync by hand with packages/server/src/{routes,ws}.ts and the
// @herdctl/core ChatMessage / DiscoveredSession shapes.

export type ProjectStatus =
  | "idea"
  | "active"
  | "paused"
  | "blocked"
  | "done"
  | "abandoned";

export interface ProjectLink {
  label: string;
  url: string;
}

export interface Project {
  name: string;
  slug: string;
  status: ProjectStatus;
  domain: string[];
  visibility: "public" | "private";
  started: string;
  updated: string;
  created: string;
  summary: string;
  links?: ProjectLink[];
  dir: string;
  /** True once a sweep has written OVERVIEW.md (drives the preload checkbox + Overview hint). */
  hasOverview: boolean;
  /** Pinned file names rendered as sibling tabs (order-preserving). Default []. */
  pinned: string[];
  /** The keeper model this project runs on. Always concrete (server resolves the default). */
  model: string;
}

/** A selectable model (GET /api/models). `contextLimit` drives the context meter. */
export interface ModelInfo {
  id: string;
  label: string;
  contextLimit: number;
}

/** Render-kind hint for a project file, derived server-side from its extension. */
export type FileKind = "markdown" | "html" | "text";

/** A single project file's content + how it should be rendered (GET /files/:name). */
export interface ProjectFile {
  name: string;
  kind: FileKind;
  content: string;
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  status?: ProjectStatus;
  domain?: string[];
  summary?: string;
}

/** Editable project metadata (slug + dates are immutable server-side). */
export interface UpdateProjectInput {
  name?: string;
  status?: ProjectStatus;
  domain?: string[];
  summary?: string;
  visibility?: "public" | "private";
  /** The keeper model id; server re-registers the keeper on change (must be a known model). */
  model?: string;
}

/** A chat = one Claude Code session, surfaced by the server's session discovery. */
export interface Chat {
  sessionId: string;
  workingDirectory: string;
  name: string;
  updatedAt: string;
  resumable: boolean;
  preview?: string;
}

/** A persisted message hydrated from a session's transcript (core ChatMessage). */
export interface ChatToolCall {
  toolName: string;
  inputSummary?: string;
  output: string;
  isError: boolean;
  durationMs?: number;
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  toolCall?: ChatToolCall;
}

/** Enriched single-project response from GET /api/projects/:slug. */
export interface ProjectDetail {
  project: Project;
  changelog: string;
  chats: Chat[];
}

// --- WS protocol (mirrors server/src/ws.ts) ---

/** The slug used to address one-off chats. The server routes it to the scratch agent. */
export const SCRATCH_SLUG = "scratch";

/** Routing fields present on every server->client chat event. */
interface Routing {
  projectSlug: string;
  /** Legacy alias for `projectSlug`; the server emits both. */
  target?: string;
  sessionId: string | null;
  jobId: string | null;
}

/** Per-turn token usage surfaced on chat:complete (camelCase; drives the context meter). */
export interface ChatCompleteUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input + cacheRead + cacheCreation (what the context window holds). */
  contextTokens: number;
  /** The model's context window size (getContextLimit(model) server-side). */
  contextLimit: number;
}

export type ServerWsMessage =
  | { type: "chat:response"; payload: Routing & { chunk: string } }
  | {
      type: "chat:tool_call";
      payload: Routing & {
        toolName: string;
        inputSummary?: string;
        output: string;
        isError: boolean;
        durationMs?: number;
      };
    }
  | { type: "chat:message_boundary"; payload: Routing }
  | {
      type: "chat:complete";
      payload: Routing & {
        success: boolean;
        error?: string;
        /** The model this turn ran on (server: lastModel ?? effectiveModel). Omitted if unknown. */
        model?: string;
        /** Last per-turn usage observed; omitted (with model) if none was seen. */
        usage?: ChatCompleteUsage;
      };
    }
  | { type: "chat:error"; payload: { projectSlug: string; target?: string; error: string } }
  | { type: "pong" };
