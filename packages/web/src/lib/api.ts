// Typed REST client for the paddock-server API.
//
// Set VITE_API_BASE to point at a non-default server (defaults to same-origin,
// which is correct both behind the dev proxy and in production where the server
// serves the built SPA).
import {
  type Chat,
  type CreateProjectInput,
  type DeviceFlowStart,
  type GitCommitResult,
  type GitInfo,
  type GitProjectStatus,
  type GitPushResult,
  type HistoryMessage,
  type ModelInfo,
  type PollResult,
  type Project,
  type ProjectDetail,
  type ProjectFile,
  SCRATCH_SLUG,
  type UpdateProjectInput,
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

/**
 * Like `req`, but returns the raw response body as text rather than JSON-parsing
 * it. Used for the git diff endpoint, which serves `text/plain` unified diffs.
 * Errors still surface as `ApiError` (the server returns JSON `{ error }` on
 * failure, which we best-effort parse out of the text body).
 */
async function reqText(path: string, init?: RequestInit): Promise<string> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = JSON.parse(await res.text()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* not JSON — keep the status text */
    }
    throw new ApiError(detail, res.status);
  }
  return res.text();
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
  /** Selectable models + the keeper/sweeper defaults (drives the model picker). */
  async getModels(): Promise<{
    models: ModelInfo[];
    keeperDefault: string;
    sweeperDefault: string;
  }> {
    return req<{ models: ModelInfo[]; keeperDefault: string; sweeperDefault: string }>(
      "/api/models",
    );
  },

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

  /** Edit project metadata (status, summary, domain, name, visibility, model). */
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

  /**
   * Promote a one-off (scratch) chat into a new project (issue #20). Creates the
   * project and re-homes the chat's transcript into it. `promoted:false` means
   * the project was created but the transcript couldn't be moved.
   */
  async promoteChat(
    sessionId: string,
    input: { name: string; group?: string; summary?: string; domain?: string[] },
  ): Promise<{ project: Project; promoted: boolean }> {
    return req<{ project: Project; promoted: boolean }>(
      `/api/chats/${encodeURIComponent(sessionId)}/promote`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },

  /**
   * Fork a project chat: eagerly duplicates its transcript into a new session in
   * the same project (source untouched) and returns the new session id. The fork
   * is a real, resumable chat with the parent's full history from the start.
   * Optional `name` sets its title (e.g. "Fork of <parent>").
   */
  async forkChat(slug: string, sessionId: string, name?: string): Promise<string> {
    const { sessionId: newId } = await req<{ sessionId: string }>(
      `/api/projects/${encodeURIComponent(slug)}/chats/${encodeURIComponent(sessionId)}/fork`,
      { method: "POST", body: JSON.stringify({ name }) },
    );
    return newId;
  },

  /** List the freeform files in a project's directory. */
  async listProjectFiles(slug: string): Promise<string[]> {
    const { files } = await req<{ files: string[] }>(
      `/api/projects/${encodeURIComponent(slug)}/files`,
    );
    return files;
  },

  /** Fetch one project file + a render-kind hint (markdown | html | text | image). */
  async getProjectFile(slug: string, name: string): Promise<ProjectFile> {
    return req<ProjectFile>(
      `/api/projects/${encodeURIComponent(slug)}/files/${encodeURIComponent(name)}`,
    );
  },

  /**
   * The URL that streams a file's RAW BYTES with the correct Content-Type
   * (issue #61) — used as an <img src> for image files, so binary bytes aren't
   * mangled by the JSON/UTF-8 path.
   */
  projectFileRawUrl(slug: string, name: string): string {
    return `${BASE}/api/projects/${encodeURIComponent(slug)}/files/${encodeURIComponent(name)}?raw=1`;
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

  /**
   * Nested steps of a sub-agent launched from a Task/Agent tool block (issue
   * #37). `toolUseId` comes off the enriched tool call; sub-agents are flat under
   * the session, so the same session id resolves every depth. Routes to the
   * scratch endpoint when the slug is the scratch slug.
   */
  async subagentMessages(
    slug: string,
    sessionId: string,
    toolUseId: string,
  ): Promise<HistoryMessage[]> {
    const base =
      slug === SCRATCH_SLUG
        ? `/api/chats/${encodeURIComponent(sessionId)}`
        : `/api/projects/${encodeURIComponent(slug)}/chats/${encodeURIComponent(sessionId)}`;
    const { messages } = await req<{ messages: HistoryMessage[] }>(
      `${base}/subagents/${encodeURIComponent(toolUseId)}/messages`,
    );
    return messages;
  },

  /**
   * Context-window usage for a chat, read from its transcript — drives the
   * context meter for a chat opened from history (before any new turn streams a
   * fresh usage). Returns null when the transcript carries no usage data.
   * Routes to the scratch endpoint when the slug is the scratch slug.
   */
  async chatContext(
    slug: string,
    sessionId: string,
  ): Promise<{ contextTokens: number; contextLimit: number } | null> {
    const path =
      slug === SCRATCH_SLUG
        ? `/api/chats/${encodeURIComponent(sessionId)}/context`
        : `/api/projects/${encodeURIComponent(slug)}/chats/${encodeURIComponent(sessionId)}/context`;
    const { usage } = await req<{
      usage: { contextTokens: number; contextLimit: number } | null;
    }>(path);
    return usage;
  },

  // --- Git backing store ----------------------------------------------------

  /**
   * Fleet-wide git state. `repo:false` ⇒ the projects dir isn't a git repo and
   * the entire git UI should be hidden.
   */
  async gitInfo(): Promise<GitInfo> {
    return req<GitInfo>("/api/git");
  },

  /** A project's working-tree status (changed files, branch, clean flag). */
  async gitStatus(slug: string): Promise<GitProjectStatus> {
    return req<GitProjectStatus>(`/api/projects/${encodeURIComponent(slug)}/git/status`);
  },

  /**
   * A project's unified diff. Pass `file` (repo-relative) for one file's diff,
   * or omit it for the whole project's tracked diff. Returns the raw diff text
   * (`text/plain`, not JSON). Untracked files have no diff (they're in status).
   */
  async gitDiff(slug: string, file?: string): Promise<string> {
    const qs = file ? `?file=${encodeURIComponent(file)}` : "";
    return reqText(`/api/projects/${encodeURIComponent(slug)}/git/diff${qs}`);
  },

  /** Commit a project's changes. `committed:false` ⇒ nothing to commit. */
  async gitCommit(slug: string, message: string): Promise<GitCommitResult> {
    return req<GitCommitResult>(`/api/projects/${encodeURIComponent(slug)}/git/commit`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  },

  /** Push the projects repo to its remote. */
  async gitPush(): Promise<GitPushResult> {
    return req<GitPushResult>("/api/git/push", { method: "POST" });
  },

  /** Start the GitHub OAuth device flow. HTTP 400 ⇒ no client id configured. */
  async githubConnect(): Promise<DeviceFlowStart> {
    return req<DeviceFlowStart>("/api/git/github/connect", { method: "POST" });
  },

  /** Poll the device flow for completion (call every `interval` seconds). */
  async githubPoll(deviceCode: string): Promise<PollResult> {
    return req<PollResult>("/api/git/github/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode }),
    });
  },

  /** Disconnect GitHub (drop the stored token). */
  async githubDisconnect(): Promise<void> {
    await req<{ ok: boolean }>("/api/git/github/disconnect", { method: "POST" });
  },

  // --- Voice dictation (Whisper) --------------------------------------------

  /**
   * Whether this instance has voice dictation enabled (mode !== off and, for
   * remote mode, an endpoint is configured). Drives whether the composer shows a
   * mic button at all.
   */
  async transcriptionStatus(): Promise<{
    available: boolean;
    mode: "off" | "local" | "remote";
    model: string;
  }> {
    return req<{ available: boolean; mode: "off" | "local" | "remote"; model: string }>(
      "/api/transcription",
    );
  },

  /**
   * Transcribe a recorded audio blob to text via the server's whisper backend.
   * Uses raw `fetch` (not `req`) so the browser sets the multipart boundary — do
   * NOT force a JSON content-type here.
   */
  async transcribe(blob: Blob, filename = "dictation.webm", signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append("file", blob, filename);
    const res = await fetch(`${BASE}/api/transcribe`, { method: "POST", body: form, signal });
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
    const { text } = (await res.json()) as { text: string };
    return text;
  },
};
