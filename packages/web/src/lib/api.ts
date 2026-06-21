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
  ProjectFile,
  UpdateProjectInput,
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

  /** Edit project metadata (status, summary, domain, name, visibility). */
  async updateProject(slug: string, patch: UpdateProjectInput): Promise<Project> {
    const { project } = await req<{ project: Project }>(
      `/api/projects/${encodeURIComponent(slug)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    return project;
  },

  /** Delete a project (dir + keeper agent). */
  async deleteProject(slug: string): Promise<void> {
    await req<{ ok: boolean }>(`/api/projects/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
  },

  /** Delete a project chat (session transcript). */
  async deleteProjectChat(slug: string, sessionId: string): Promise<void> {
    await req<{ ok: boolean }>(
      `/api/projects/${encodeURIComponent(slug)}/chats/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
  },

  /** Delete a one-off (scratch) chat. */
  async deleteScratchChat(sessionId: string): Promise<void> {
    await req<{ ok: boolean }>(`/api/chats/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  },

  /** Rename a project chat (set/clear its custom display name). */
  async renameProjectChat(slug: string, sessionId: string, name: string | null): Promise<void> {
    await req<{ ok: boolean }>(
      `/api/projects/${encodeURIComponent(slug)}/chats/${encodeURIComponent(sessionId)}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
    );
  },

  /** Rename a one-off (scratch) chat. */
  async renameScratchChat(sessionId: string, name: string | null): Promise<void> {
    await req<{ ok: boolean }>(`/api/chats/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  },

  /** List the freeform files in a project's directory. */
  async listProjectFiles(slug: string): Promise<string[]> {
    const { files } = await req<{ files: string[] }>(
      `/api/projects/${encodeURIComponent(slug)}/files`,
    );
    return files;
  },

  /** Fetch one project file + a render-kind hint (markdown | html | text). */
  async getProjectFile(slug: string, name: string): Promise<ProjectFile> {
    return req<ProjectFile>(
      `/api/projects/${encodeURIComponent(slug)}/files/${encodeURIComponent(name)}`,
    );
  },

  /** Pin a file as a sibling tab. Returns the updated project (with pinned[]). */
  async pinFile(slug: string, file: string): Promise<Project> {
    const { project } = await req<{ project: Project }>(
      `/api/projects/${encodeURIComponent(slug)}/pins`,
      { method: "PUT", body: JSON.stringify({ file }) },
    );
    return project;
  },

  /** Unpin a file. Returns the updated project (with pinned[]). */
  async unpinFile(slug: string, file: string): Promise<Project> {
    const { project } = await req<{ project: Project }>(
      `/api/projects/${encodeURIComponent(slug)}/pins/${encodeURIComponent(file)}`,
      { method: "DELETE" },
    );
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
