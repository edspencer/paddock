// Typed REST client for the paddock-server API.
//
// Set VITE_API_BASE to point at a non-default server (defaults to same-origin,
// which is correct both behind the dev proxy and in production where the server
// serves the built SPA).
import type {
  Chat,
  CreateProjectInput,
  HistoryMessage,
  Project,
  ProjectDetail,
} from "./types";

const BASE = import.meta.env.VITE_API_BASE ?? "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const api = {
  async listProjects(): Promise<Project[]> {
    const { projects } = await req<{ projects: Project[] }>("/api/projects");
    return projects;
  },

  /** Enriched single-project payload: metadata + changelog + its chats. */
  async getProjectDetail(slug: string): Promise<ProjectDetail> {
    return req<ProjectDetail>(`/api/projects/${encodeURIComponent(slug)}`);
  },

  async createProject(input: CreateProjectInput): Promise<Project> {
    const { project } = await req<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return project;
  },

  async listProjectChats(slug: string): Promise<Chat[]> {
    const { chats } = await req<{ chats: Chat[] }>(
      `/api/projects/${encodeURIComponent(slug)}/chats`,
    );
    return chats;
  },

  async listScratchChats(): Promise<Chat[]> {
    const { chats } = await req<{ chats: Chat[] }>("/api/chats");
    return chats;
  },

  /** Hydrate a project chat's transcript. */
  async projectChatMessages(slug: string, sessionId: string): Promise<HistoryMessage[]> {
    const { messages } = await req<{ messages: HistoryMessage[] }>(
      `/api/projects/${encodeURIComponent(slug)}/chats/${encodeURIComponent(sessionId)}/messages`,
    );
    return messages;
  },

  /** Hydrate a one-off (scratch) chat's transcript. */
  async scratchChatMessages(sessionId: string): Promise<HistoryMessage[]> {
    const { messages } = await req<{ messages: HistoryMessage[] }>(
      `/api/chats/${encodeURIComponent(sessionId)}/messages`,
    );
    return messages;
  },
};
