// Typed REST client for the paddock-server API.
//
// Set VITE_API_BASE to point at a non-default server (defaults to same-origin,
// which is correct both behind the dev proxy and in production where the server
// serves the built SPA).
import {
  type AttachmentRef,
  type AttachmentsConfig,
  type Chat,
  type ChatUsage,
  type CreateProjectInput,
  type DeviceFlowStart,
  type DirListing,
  type GitCommitResult,
  type GitInfo,
  type GitProjectStatus,
  type GitPushResult,
  type HistoryMessage,
  type InstanceConfig,
  type ModelInfo,
  type PollResult,
  type Project,
  type ProjectDetail,
  type ProjectFile,
  type ProjectRuns,
  type RecoveryConfig,
  SCRATCH_SLUG,
  type SlashCommand,
  type Trigger,
  type TriggerInput,
  type TriggerRuntimeResponse,
  type TriggersResponse,
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

/** The authenticated principal (GET /api/me). Anonymous in `none` mode (#189). */
export interface Me {
  username: string;
  email?: string;
  groups?: string[];
  anonymous?: boolean;
}

export const api = {
  /**
   * The current user (#189). In `none` mode this is the anonymous principal
   * (`{ username: "anonymous", anonymous: true }`); behind a proxy/IdP it's the
   * real identity. Read-state is keyed by this user when it's non-anonymous.
   */
  async me(): Promise<Me> {
    return req<Me>("/api/me");
  },

  /**
   * Mark a chat SEEN (#189): persist the user's last-viewed moment server-side
   * so the unread affordance follows them across devices. Fire-and-forget from
   * the UI (the local mirror clears the cue optimistically). `when` defaults to
   * the server's now. Routes to the scratch endpoint for the scratch slug.
   */
  async markChatSeen(slug: string, sessionId: string, when?: number): Promise<void> {
    const path =
      slug === SCRATCH_SLUG
        ? `/api/chats/${encodeURIComponent(sessionId)}/seen`
        : `/api/projects/${encodeURIComponent(slug)}/chats/${encodeURIComponent(sessionId)}/seen`;
    await req<{ ok: boolean; lastSeen: number }>(path, {
      method: "POST",
      body: JSON.stringify(when !== undefined ? { when } : {}),
    });
  },

  /**
   * Run history for a project (#268 / E3): recent herdctl runs joined with their
   * provenance (human / scheduled / spawned) plus the viewer's since-last-visit
   * watermark + a count of new unattended runs. Powers the "while you were away"
   * tab. `limit` caps the page (server default 100).
   */
  async projectRuns(slug: string, limit?: number): Promise<ProjectRuns> {
    const q = limit !== undefined ? `?limit=${encodeURIComponent(limit)}` : "";
    return req<ProjectRuns>(`/api/projects/${encodeURIComponent(slug)}/runs${q}`);
  },

  /**
   * Advance the "runs last seen" watermark for a project (#268): clears the
   * since-last-visit digest. Fire-and-forget; `when` defaults to the server's now
   * and the store is monotonic (an older value is a no-op).
   */
  async markRunsSeen(slug: string, when?: number): Promise<void> {
    await req<{ ok: boolean; lastSeen: number }>(
      `/api/projects/${encodeURIComponent(slug)}/runs/seen`,
      {
        method: "POST",
        body: JSON.stringify(when !== undefined ? { when } : {}),
      },
    );
  },

  /** Selectable models + the keeper/sweeper defaults (drives the model picker). */
  async getModels(): Promise<{
    models: ModelInfo[];
    keeperDefault: string;
    sweeperDefault: string;
    /** Box-wide default drive mode (PADDOCK_KEEPER_DRIVE_MODE) a project inherits
     *  when its own `driveMode` is unset; shown as the effective value in the
     *  project Settings tab (issue #122). Optional for back-compat with older
     *  servers / test mocks. */
    keeperDriveModeDefault?: "batch" | "session";
    /** Box-wide default max spawn depth (PADDOCK_MAX_SPAWN_DEPTH) a project
     *  inherits when its own `maxSpawnDepth` is unset; shown as the effective
     *  value in Settings (issue #262). Optional for back-compat. */
    maxSpawnDepthDefault?: number;
    /** Box-wide keeper-chat recovery defaults (PADDOCK_RECOVERY_*) a project
     *  inherits when its own `recovery` fields are unset (issue #301). Optional
     *  for back-compat with older servers / test mocks. */
    recoveryDefault?: RecoveryConfig;
    /** Box-wide inbound-attachment defaults (PADDOCK_ATTACHMENTS_*) a project
     *  inherits when its own `attachments` fields are unset (issue #328). Optional
     *  for back-compat with older servers / test mocks. */
    attachmentsDefault?: AttachmentsConfig;
  }> {
    return req<{
      models: ModelInfo[];
      keeperDefault: string;
      sweeperDefault: string;
      keeperDriveModeDefault?: "batch" | "session";
      maxSpawnDepthDefault?: number;
      recoveryDefault?: RecoveryConfig;
      attachmentsDefault?: AttachmentsConfig;
    }>("/api/models");
  },

  // --- Instance-wide settings (issue #385) ----------------------------------

  /**
   * The instance-wide config surface (admin Settings screen): grouped fields,
   * each with its value/default/editable/sensitive/env-shadow flags. Read once
   * per screen mount. See {@link updateInstanceConfig} for writing.
   */
  async getInstanceConfig(): Promise<InstanceConfig> {
    return req<InstanceConfig>("/api/instance-config");
  },

  /**
   * Write a patch of editable instance-config fields to `paddock.config.yaml`
   * (comment-preserving, atomic). Keyed by the field's dotted `key`. Writes do
   * NOT hot-apply — the config is frozen at boot — so this resolves
   * `{ restartRequired: true }` and the UI shows a restart banner. A 4xx body
   * carries a human `error` (unknown/read-only key, or an invalid value).
   */
  async updateInstanceConfig(
    patch: Record<string, unknown>,
  ): Promise<{ restartRequired: boolean; configPath: string }> {
    return req<{ restartRequired: boolean; configPath: string }>("/api/instance-config", {
      method: "PUT",
      body: JSON.stringify({ patch }),
    });
  },

  /**
   * Upload composer attachments (issue #328) into a chat's attachment store,
   * returning the saved refs (id + kind + size). `sessionId` may be a
   * not-yet-created chat's placeholder (e.g. "new") — storage is flat and doesn't
   * need it. Validation (enabled/size/count/type) is server-authoritative; a 4xx
   * body carries a human `error` the composer surfaces as a toast.
   */
  async uploadAttachments(
    slug: string,
    sessionId: string,
    files: File[],
  ): Promise<{ files: AttachmentRef[] }> {
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);
    // Must NOT set content-type here — the browser sets the multipart boundary.
    const res = await fetch(
      `${BASE}/api/projects/${encodeURIComponent(slug)}/chats/${encodeURIComponent(sessionId)}/upload`,
      { method: "POST", body: form },
    );
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
    return (await res.json()) as { files: AttachmentRef[] };
  },

  /**
   * Slash commands available to a project's keeper (issue #103) — drives the
   * composer autocomplete. The list is stable per project, so callers load it
   * once and cache in state (the server also memoizes it).
   */
  async projectCommands(slug: string): Promise<SlashCommand[]> {
    const { commands } = await req<{ commands: SlashCommand[] }>(
      `/api/projects/${encodeURIComponent(slug)}/commands`,
    );
    return commands;
  },

  /** Slash commands for one-off (scratch) chats (issue #103). */
  async scratchCommands(): Promise<SlashCommand[]> {
    const { commands } = await req<{ commands: SlashCommand[] }>("/api/commands");
    return commands;
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

  /**
   * Promote a NOTEBOOK project into a REPO-BACKED one in place (issue #213):
   * clones `repo` into the project's nested checkout, flips the keeper's cwd to it,
   * and preserves the project's chats + sidecar metadata. Returns the updated
   * (now repo-backed) project DTO. A clone failure leaves the notebook intact.
   */
  async promoteProject(slug: string, repo: string): Promise<Project> {
    const { project } = await req<{ project: Project }>(
      `/api/projects/${encodeURIComponent(slug)}/promote`,
      { method: "POST", body: JSON.stringify({ repo }) },
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

  /** Archive or unarchive a project chat (issue #95). Non-destructive toggle. */
  async archiveProjectChat(slug: string, sessionId: string, archived: boolean): Promise<void> {
    await req<{ ok: boolean }>(
      `/api/projects/${encodeURIComponent(slug)}/chats/${encodeURIComponent(sessionId)}/archive`,
      { method: "POST", body: JSON.stringify({ archived }) },
    );
  },

  /** Archive or unarchive a one-off (scratch) chat (issue #95). */
  async archiveScratchChat(sessionId: string, archived: boolean): Promise<void> {
    await req<{ ok: boolean }>(`/api/chats/${encodeURIComponent(sessionId)}/archive`, {
      method: "POST",
      body: JSON.stringify({ archived }),
    });
  },

  /** Star or unstar a project chat (issue #373). Pins it to the top of its list. */
  async starProjectChat(slug: string, sessionId: string, starred: boolean): Promise<void> {
    await req<{ ok: boolean }>(
      `/api/projects/${encodeURIComponent(slug)}/chats/${encodeURIComponent(sessionId)}/star`,
      { method: "POST", body: JSON.stringify({ starred }) },
    );
  },

  /** Star or unstar a one-off (scratch) chat (issue #373). */
  async starScratchChat(sessionId: string, starred: boolean): Promise<void> {
    await req<{ ok: boolean }>(`/api/chats/${encodeURIComponent(sessionId)}/star`, {
      method: "POST",
      body: JSON.stringify({ starred }),
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

  /**
   * Resolve a Files-tab path (issue #259). `subpath` descends into a
   * subdirectory ("" = the project root). Returns a discriminated union: a
   * directory (`kind: "dir"`) carries its `entries` (each a file|dir); a file
   * (`kind: "file"`) carries no entries and the caller renders the viewer.
   */
  async listProjectDir(slug: string, subpath = ""): Promise<DirListing> {
    const qs = subpath ? `?path=${encodeURIComponent(subpath)}` : "";
    return req<DirListing>(`/api/projects/${encodeURIComponent(slug)}/files${qs}`);
  },

  /**
   * The project's top-level file NAMES (issue #259 keeps this convenience for the
   * Home tab's recent-files list, the pinned-tab validation, and the sticky-tab
   * redirect). Subdirectories are omitted; use `listProjectDir` to browse them.
   */
  async listProjectFiles(slug: string): Promise<string[]> {
    const { entries } = await this.listProjectDir(slug);
    return entries.filter((e) => e.kind === "file").map((e) => e.name);
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

  /**
   * The URL that streams the RAW BYTES of a file the agent shared via
   * `mcp__paddock__send_file` (issue #112). The bytes were copied into the
   * attachment store at send time and are addressed by an opaque id.
   */
  chatFileRawUrl(attachmentId: string): string {
    return `${BASE}/api/chat-files/${encodeURIComponent(attachmentId)}`;
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

  /**
   * Bulk context-window usage for every chat in a project, keyed by session id
   * (issue #116). Fetched separately from the chat list so the ProjectView can
   * render immediately and fill in the per-chat usage rings (issue #77)
   * afterwards — the per-session transcript parse this needs is what made project
   * switching slow. Sessions with no usage data are absent from the map.
   */
  async chatUsage(slug: string): Promise<Record<string, ChatUsage>> {
    const { usage } = await req<{
      usage: Record<string, ChatUsage>;
    }>(`/api/projects/${encodeURIComponent(slug)}/chats/usage`);
    return usage;
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
  async chatContext(slug: string, sessionId: string): Promise<ChatUsage | null> {
    const path =
      slug === SCRATCH_SLUG
        ? `/api/chats/${encodeURIComponent(sessionId)}/context`
        : `/api/projects/${encodeURIComponent(slug)}/chats/${encodeURIComponent(sessionId)}/context`;
    const { usage } = await req<{ usage: ChatUsage | null }>(path);
    return usage;
  },

  // --- Triggers (Epic T / T3–T4) -------------------------------------------

  /**
   * A project's unified triggers + the picker's catalog: the grantable tools, the
   * events an event-trigger can fire on, and the trigger types — so the Triggers tab
   * renders precise type/event/capability pickers without hard-coding them. The
   * single surface over both event and cron triggers (Epic T folds both in).
   */
  async listTriggers(slug: string): Promise<TriggersResponse> {
    return req<TriggersResponse>(`/api/projects/${encodeURIComponent(slug)}/triggers`);
  },

  /**
   * Create or replace one trigger (keyed by name). Persists to project.yaml's single
   * `triggers` block + arms it. Enabling/disabling is the SAME call with the `enabled`
   * field flipped — there is no separate enable/disable verb (GG-3).
   */
  async putTrigger(slug: string, name: string, input: TriggerInput): Promise<Trigger> {
    const { trigger } = await req<{ trigger: Trigger }>(
      `/api/projects/${encodeURIComponent(slug)}/triggers/${encodeURIComponent(name)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
    return trigger;
  },

  /** Delete one trigger (removes it from project.yaml + disarms its agent/schedule). */
  async deleteTrigger(slug: string, name: string): Promise<void> {
    await req<{ ok: boolean }>(
      `/api/projects/${encodeURIComponent(slug)}/triggers/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  },

  /**
   * A project's per-trigger RUNTIME state (Epic T follow-up / #327) — last-run /
   * next-run / running-state, joined from herdctl job records + the cron scheduler.
   * Served separately from {@link listTriggers} (config) so the tab can poll status
   * cheaply without re-fetching the picker catalog.
   */
  async triggerRuntime(slug: string): Promise<TriggerRuntimeResponse> {
    return req<TriggerRuntimeResponse>(
      `/api/projects/${encodeURIComponent(slug)}/triggers/runtime`,
    );
  },

  /**
   * Fire a trigger NOW — "Run now". Runs it through the same hub path a cron / event
   * fire uses, so the resulting chat is a first-class, badged run. Works for any
   * trigger type regardless of its `enabled` flag. Resolves the started chat's
   * session id.
   */
  async runTrigger(slug: string, name: string): Promise<string> {
    const { sessionId } = await req<{ ok: boolean; sessionId: string }>(
      `/api/projects/${encodeURIComponent(slug)}/triggers/${encodeURIComponent(name)}/run`,
      { method: "POST", body: "{}" },
    );
    return sessionId;
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

  /**
   * Commit a project's changes. `committed:false` ⇒ nothing to commit. Pass
   * `files` (project-relative paths) to commit ONLY those changes; omit it to
   * commit the whole subtree (#258).
   */
  async gitCommit(slug: string, message: string, files?: string[]): Promise<GitCommitResult> {
    return req<GitCommitResult>(`/api/projects/${encodeURIComponent(slug)}/git/commit`, {
      method: "POST",
      body: JSON.stringify(files ? { message, files } : { message }),
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
