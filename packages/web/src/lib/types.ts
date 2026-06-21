// Shared DTO types mirroring the paddock-server API + WS protocol.
// Kept in sync by hand with packages/server/src/{routes,ws}.ts.

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
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  status?: ProjectStatus;
  domain?: string[];
  summary?: string;
}

export interface Chat {
  sessionId: string;
  workingDirectory: string;
  name: string;
  updatedAt: string;
  resumable: boolean;
  preview?: string;
}

// --- WS protocol (mirrors server/src/ws.ts) ---

export const ADHOC_TARGET = "__adhoc__";

export interface ChatSend {
  type: "chat:send";
  payload: { target: string; sessionId?: string; message: string };
}

export type ServerWsMessage =
  | {
      type: "chat:response";
      payload: { target: string; sessionId: string | null; jobId: string | null; chunk: string };
    }
  | {
      type: "chat:tool_call";
      payload: {
        target: string;
        sessionId: string | null;
        jobId: string | null;
        toolName: string;
        inputSummary?: string;
        output: string;
        isError: boolean;
      };
    }
  | {
      type: "chat:complete";
      payload: {
        target: string;
        sessionId: string | null;
        jobId: string | null;
        success: boolean;
        error?: string;
      };
    }
  | { type: "chat:error"; payload: { target: string; error: string } }
  | { type: "pong" };
