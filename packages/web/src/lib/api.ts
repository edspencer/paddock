// Typed REST client for the paddock-server API.
//
// Set VITE_API_BASE to point at a non-default server (defaults to same-origin,
// which is correct both behind the dev proxy and in production where the server
// serves the built SPA).
import {
  type AdoptChatsResult,
  type AdoptableChats,
  type UnadoptChatsResult,
  type AttachmentRef,
  type AttachmentsConfig,
  type Chat,
  type CurationConfig,
  type ChatUsage,
  type ChatUsageScope,
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
  type AttentionChats,
  type ProjectFile,
  type ProjectRuns,
  type RecoveryConfig,
  type SlashCommand,
  type Trigger,
  type TriggerInput,
  type TriggerRuntimeResponse,
  type TriggersResponse,
  type UpdateProjectInput,
} from "./types";
import { apiBase } from "../routes/ProjectView/urls";

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
   * the server's now.
   *
   * `keepUnread` marks the seen as INFERRED rather than intentional (#608): the
   * watermark still advances, but the server leaves any manual "mark unread"
   * override (#458) alone, so an explicit flag outlives a turn that lands while
   * the user happens to be looking at the chat.
   */
  async markChatSeen(
    slug: string,
    sessionId: string,
    when?: number,
    opts?: { keepUnread?: boolean },
  ): Promise<void> {
    const path = `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}/seen`;
    await req<{ ok: boolean; lastSeen: number; unread: boolean }>(path, {
      method: "POST",
      body: JSON.stringify({
        ...(when !== undefined ? { when } : {}),
        ...(opts?.keepUnread ? { keepUnread: true } : {}),
      }),
    });
  },

  /**
   * Set (or clear) a chat's MANUAL unread override (#458) — the "mark as unread"
   * action, so a chat resurfaces its unread cue after its last turn was seen.
   * `unread:false` is equivalent to marking it seen.
   */
  async markChatUnread(slug: string, sessionId: string, unread: boolean): Promise<void> {
    const path = `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}/unread`;
    await req<{ ok: boolean; unread: boolean }>(path, {
      method: "POST",
      body: JSON.stringify({ unread }),
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
    return req<ProjectRuns>(`${apiBase(slug)}/runs${q}`);
  },

  /**
   * Advance the "runs last seen" watermark for a project (#268): clears the
   * since-last-visit digest. Fire-and-forget; `when` defaults to the server's now
   * and the store is monotonic (an older value is a no-op).
   */
  async markRunsSeen(slug: string, when?: number): Promise<void> {
    await req<{ ok: boolean; lastSeen: number }>(
      `${apiBase(slug)}/runs/seen`,
      {
        method: "POST",
        body: JSON.stringify(when !== undefined ? { when } : {}),
      },
    );
  },

  /** Selectable models + the instance default model (drives the model picker). */
  async getModels(): Promise<{
    models: ModelInfo[];
    defaultModel: string;
    /** Box-wide default drive mode (PADDOCK_DRIVE_MODE) a project inherits
     *  when its own `driveMode` is unset; shown as the effective value in the
     *  project Settings tab (issue #122). */
    driveModeDefault: "batch" | "session";
    /** Box-wide default max spawn depth (PADDOCK_MAX_SPAWN_DEPTH) a project
     *  inherits when its own `maxSpawnDepth` is unset; shown as the effective
     *  value in Settings (issue #262). */
    maxSpawnDepthDefault: number;
    /** Box-wide keeper-chat recovery defaults (PADDOCK_RECOVERY_*) a project
     *  inherits when its own `recovery` fields are unset (issue #301). */
    recoveryDefault: RecoveryConfig;
    /** Box-wide inbound-attachment defaults (PADDOCK_ATTACHMENTS_*) a project
     *  inherits when its own `attachments` fields are unset (issue #328). */
    attachmentsDefault: AttachmentsConfig;
    /** Box-wide sweeper-curation budgets (PADDOCK_CURATION_*) a project inherits
     *  when its own `curation` fields are unset (issue #384). */
    curationDefault: CurationConfig;
  }> {
    return req<{
      models: ModelInfo[];
      defaultModel: string;
      driveModeDefault: "batch" | "session";
      maxSpawnDepthDefault: number;
      recoveryDefault: RecoveryConfig;
      attachmentsDefault: AttachmentsConfig;
      curationDefault: CurationConfig;
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
   * (comment-preserving, atomic). Keyed by the field's dotted `key`; a `null`
   * clears that key back to its built-in default. Writes do NOT hot-apply — the
   * config is frozen at boot — so this resolves `{ restartRequired: true }` and
   * the UI shows a restart banner. A 4xx body carries a human `error`
   * (unknown/read-only/env-shadowed key, or an invalid value).
   *
   * `expectedVersion` is the `configVersion` of the snapshot the edits were made
   * against; the server 409s rather than overwrite a file some other tab has
   * changed in the meantime (#722).
   */
  async updateInstanceConfig(
    patch: Record<string, unknown>,
    expectedVersion?: string | null,
  ): Promise<{ restartRequired: boolean; configPath: string; configVersion: string | null }> {
    return req<{ restartRequired: boolean; configPath: string; configVersion: string | null }>(
      "/api/instance-config",
      {
        method: "PUT",
        body: JSON.stringify(
          expectedVersion === undefined ? { patch } : { patch, expectedVersion },
        ),
      },
    );
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
      `${BASE}${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}/upload`,
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
      `${apiBase(slug)}/commands`,
    );
    return commands;
  },

  /**
   * The sidebar's whole world in one call: the root workspace's CHILDREN plus
   * the ROOT workspace itself.
   *
   * The root is deliberately NOT a member of `projects` (that list is its
   * children, and the root belongs in neither the grid nor the sidebar project
   * list) but it rides on the same response, carrying the same `chatTurns`
   * field — that is what lets Home and a project row share one badge
   * computation instead of two (#553). `root` is null only if the server could
   * not read the root record.
   */
  async listProjects(): Promise<{ projects: Project[]; root: Project | null }> {
    const { projects, root } = await req<{ projects: Project[]; root?: Project | null }>(
      "/api/projects",
    );
    return { projects, root: root ?? null };
  },

  /**
   * Enriched single-workspace payload: metadata + CHANGELOG.md + OVERVIEW.md +
   * its chats.
   */
  async getProjectDetail(slug: string): Promise<ProjectDetail> {
    return req<ProjectDetail>(`${apiBase(slug)}`);
  },

  /**
   * The Home attention feed (#599): the chats in this workspace's SUBTREE that
   * are running or unread.
   *
   * Called with the ROOT key (`""`) it is fleet-wide, because the root's key
   * prefixes every workspace key; called with a project slug it is that project
   * alone. Home does not branch on which — it asks its own workspace and
   * renders what comes back — so the two views cannot drift apart.
   */
  async attentionChats(slug: string): Promise<AttentionChats> {
    const res = await req<Partial<AttentionChats>>(`${apiBase(slug)}/chats/attention`);
    return { running: res.running ?? [], unread: res.unread ?? [] };
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
      `${apiBase(slug)}`,
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
      `${apiBase(slug)}/promote`,
      { method: "POST", body: JSON.stringify({ repo }) },
    );
    return project;
  },

  /** Delete a project (dir + keeper agent). */
  async deleteProject(slug: string): Promise<void> {
    await req<{ ok: boolean }>(`${apiBase(slug)}`, {
      method: "DELETE",
    });
  },

  /** Delete a project chat (session transcript). */
  async deleteProjectChat(slug: string, sessionId: string): Promise<void> {
    await req<{ ok: boolean }>(
      `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
  },

  /** Rename a project chat (set/clear its custom display name). */
  async renameProjectChat(slug: string, sessionId: string, name: string | null): Promise<void> {
    await req<{ ok: boolean }>(
      `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
    );
  },

  /** Archive or unarchive a project chat (issue #95). Non-destructive toggle. */
  async archiveProjectChat(slug: string, sessionId: string, archived: boolean): Promise<void> {
    await req<{ ok: boolean }>(
      `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}/archive`,
      { method: "POST", body: JSON.stringify({ archived }) },
    );
  },

  /** Star or unstar a project chat (issue #373). Pins it to the top of its list. */
  async starProjectChat(slug: string, sessionId: string, starred: boolean): Promise<void> {
    await req<{ ok: boolean }>(
      `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}/star`,
      { method: "POST", body: JSON.stringify({ starred }) },
    );
  },

  /**
   * Archive or unarchive a WHOLE subtree in one call (#508) — the chat list's
   * Shift-click archive. One request rather than N, so a parent and its
   * descendants can't end up on different sides of the Archived divider when a
   * call fails halfway.
   */
  async archiveProjectChats(
    slug: string,
    sessionIds: string[],
    archived: boolean,
  ): Promise<void> {
    await req<{ ok: boolean; changed: string[] }>(
      `${apiBase(slug)}/chats/batch/archive`,
      { method: "POST", body: JSON.stringify({ sessionIds, archived }) },
    );
  },

  /**
   * Mark a WHOLE subtree read or unread in one call (#508). `unread: false` is
   * "mark read" and does both halves server-side (clears the manual override AND
   * advances last-seen), so the derived unread signal can't immediately re-raise
   * the cue.
   */
  async markChatsUnread(slug: string, sessionIds: string[], unread: boolean): Promise<void> {
    await req<{ ok: boolean; changed: string[] }>(
      `${apiBase(slug)}/chats/batch/unread`,
      { method: "POST", body: JSON.stringify({ sessionIds, unread }) },
    );
  },

  /**
   * Delete a WHOLE subtree in one call (#508). Filesystem deletes can't be
   * atomic, so the server attempts every id and reports which ones it couldn't
   * remove — the caller surfaces a partial failure rather than assuming the
   * family is gone.
   */
  async deleteProjectChats(
    slug: string,
    sessionIds: string[],
  ): Promise<{ removed: string[]; failed: string[] }> {
    const res = await req<{ ok: boolean; removed: string[]; failed: string[] }>(
      `${apiBase(slug)}/chats/batch/delete`,
      { method: "POST", body: JSON.stringify({ sessionIds }) },
    );
    return { removed: res.removed ?? [], failed: res.failed ?? [] };
  },

  /**
   * Detach a chat from its parent (#508), promoting it — with its own nested
   * chats — to the top level of the chat tree. Persisted as an override that
   * beats both parent-resolution tiers, so it survives a reload; `detached:false`
   * re-attaches.
   */
  async detachProjectChat(slug: string, sessionId: string, detached: boolean): Promise<void> {
    await req<{ ok: boolean; detached: boolean }>(
      `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}/detach`,
      { method: "POST", body: JSON.stringify({ detached }) },
    );
  },

  /**
   * Promote a chat into a new project (issue #20). Creates the project and
   * re-homes the chat's transcript into it. `promoted:false` means the project
   * was created but the transcript couldn't be moved.
   */
  async promoteChat(
    slug: string,
    sessionId: string,
    input: { name: string; group?: string; summary?: string; domain?: string[] },
  ): Promise<{ project: Project; promoted: boolean }> {
    return req<{ project: Project; promoted: boolean }>(
      `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}/promote`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },

  /**
   * Fork a project chat: eagerly duplicates its transcript into a new session in
   * the same project (source untouched) and returns the new session id. The fork
   * is a real, resumable chat with the parent's full history from the start.
   * Optional `name` sets its title (e.g. "Fork of <parent>"). Optional `fromUuid`
   * (issue #451) branches at an earlier message — the fork inherits only the
   * prefix up to that turn instead of the whole history.
   */
  async forkChat(
    slug: string,
    sessionId: string,
    name?: string,
    fromUuid?: string,
  ): Promise<string> {
    const { sessionId: newId } = await req<{ sessionId: string }>(
      `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}/fork`,
      { method: "POST", body: JSON.stringify({ name, fromUuid }) },
    );
    return newId;
  },

  /**
   * Revert a project chat back to an earlier message (issue #451): truncate the
   * session's transcript at `uuid`, in place (same session id), so it continues
   * as if the later turns never happened. The dropped tail is backed up
   * server-side (recoverable). Returns the number of transcript records dropped.
   * NOTE: rolls back the conversation only — real side-effects are NOT undone.
   */
  async revertChat(slug: string, sessionId: string, uuid: string): Promise<number> {
    const { removed } = await req<{ removed: number }>(
      `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}/revert`,
      { method: "POST", body: JSON.stringify({ uuid }) },
    );
    return removed;
  },

  /**
   * Resolve a Files-tab path (issue #259). `subpath` descends into a
   * subdirectory ("" = the project root). Returns a discriminated union: a
   * directory (`kind: "dir"`) carries its `entries` (each a file|dir); a file
   * (`kind: "file"`) carries no entries and the caller renders the viewer.
   */
  async listProjectDir(slug: string, subpath = ""): Promise<DirListing> {
    const qs = subpath ? `?path=${encodeURIComponent(subpath)}` : "";
    return req<DirListing>(`${apiBase(slug)}/files${qs}`);
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
      `${apiBase(slug)}/files/${encodeURIComponent(name)}`,
    );
  },

  /**
   * The URL that streams a file's RAW BYTES with the correct Content-Type
   * (issue #61) — used as an <img src> for image files, so binary bytes aren't
   * mangled by the JSON/UTF-8 path.
   */
  projectFileRawUrl(slug: string, name: string): string {
    return `${BASE}${apiBase(slug)}/files/${encodeURIComponent(name)}?raw=1`;
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
      `${apiBase(slug)}/pins`,
      { method: "PUT", body: JSON.stringify({ file }) },
    );
    return project;
  },

  /** Unpin a file. Returns the updated project (with pinned[]). */
  async unpinFile(slug: string, file: string): Promise<Project> {
    const { project } = await req<{ project: Project }>(
      `${apiBase(slug)}/pins/${encodeURIComponent(file)}`,
      { method: "DELETE" },
    );
    return project;
  },

  async listProjectChats(slug: string): Promise<Chat[]> {
    const { chats } = await req<{ chats: Chat[] }>(
      `${apiBase(slug)}/chats`,
    );
    return chats;
  },

  /**
   * How many native Claude Code CLI chats this workspace could import right now
   * (#588) — the sessions the user ran in a terminal against the same working
   * directory, which paddock cannot see until they are adopted.
   *
   * Cheap enough to call after every import, and that is the point: the button it
   * drives is gated on a LIVE count rather than a dismissed flag, so it vanishes
   * only when there is genuinely nothing left and reappears by itself once the
   * user accrues more terminal history.
   */
  async getAdoptableChats(slug: string): Promise<AdoptableChats> {
    return req<AdoptableChats>(`${apiBase(slug)}/adoptable-chats`);
  },

  /**
   * Import the workspace's adoptable native CLI chats (#588). Copies the source
   * transcripts in — the user's own `~/.claude` is never mutated — so the imported
   * chats become real, resumable chats in this workspace.
   *
   * With neither option this takes EVERYTHING on offer; `sourceCwd` narrows it to
   * a single source directory (the CLI's `--from`), and `sessionIds` to the
   * subset the user ticked in the confirmation dialog (#660). A partly-skipped
   * import still resolves: the caller reports `adopted` and `skipped` rather than
   * treating it as a failure.
   */
  async adoptChats(
    slug: string,
    opts?: { sourceCwd?: string; sessionIds?: string[] },
  ): Promise<AdoptChatsResult> {
    return req<AdoptChatsResult>(`${apiBase(slug)}/adopt-chats`, {
      method: "POST",
      // `{}` rather than no body at all: the contract accepts an empty object or
      // null, and every other POST here sends JSON, so the content-type header
      // `req` always sets stays honest.
      body: JSON.stringify(opts ?? {}),
    });
  },

  /**
   * Undo the most recent native-chat import into this workspace (#660).
   *
   * Releases the adoptions and deletes the copies that import placed; the user's
   * own `~/.claude` history is never touched. Which sessions those are is decided
   * SERVER-side from what it actually did — this call carries no paths, so an
   * undo can never be talked into deleting something the import did not create.
   *
   * `released: []` is a normal outcome, not an error: the offer is in-memory and
   * expires with a restart, so an undo pressed late simply finds nothing to do.
   */
  async unadoptChats(slug: string, opts?: { sessionIds?: string[] }): Promise<UnadoptChatsResult> {
    return req<UnadoptChatsResult>(`${apiBase(slug)}/unadopt-chats`, {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    });
  },

  /**
   * Bulk context-window usage for a project's chats, keyed by session id (issue
   * #116). Fetched separately from the chat list so the ProjectView can render
   * immediately and fill in the per-chat usage rings (issue #77) afterwards — the
   * per-session transcript parse this needs is what made project switching slow.
   * Sessions with no usage data are absent from the map.
   *
   * `scope` picks WHICH chats to pay for (issue #537). The server defaults to
   * `active`; archived rings live inside a collapsed group, so we only ask for
   * them once it is expanded. On a live-scale project the archived chats are ~72%
   * of the transcript bytes streamed.
   */
  async chatUsage(slug: string, scope?: ChatUsageScope): Promise<Record<string, ChatUsage>> {
    const qs = scope ? `?scope=${scope}` : "";
    const { usage } = await req<{
      usage: Record<string, ChatUsage>;
    }>(`${apiBase(slug)}/chats/usage${qs}`);
    return usage;
  },

  /** Hydrate a project chat's transcript. */
  async projectChatMessages(slug: string, sessionId: string): Promise<HistoryMessage[]> {
    const { messages } = await req<{ messages: HistoryMessage[] }>(
      `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}/messages`,
    );
    return messages;
  },

  /**
   * Nested steps of a sub-agent launched from a Task/Agent tool block (issue
   * #37). `toolUseId` comes off the enriched tool call; sub-agents are flat under
   * the session, so the same session id resolves every depth.
   */
  async subagentMessages(
    slug: string,
    sessionId: string,
    toolUseId: string,
  ): Promise<HistoryMessage[]> {
    const base = `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}`;
    const { messages } = await req<{ messages: HistoryMessage[] }>(
      `${base}/subagents/${encodeURIComponent(toolUseId)}/messages`,
    );
    return messages;
  },

  /**
   * Context-window usage for a chat, read from its transcript — drives the
   * context meter for a chat opened from history (before any new turn streams a
   * fresh usage). Returns null when the transcript carries no usage data.
   */
  async chatContext(slug: string, sessionId: string): Promise<ChatUsage | null> {
    const path = `${apiBase(slug)}/chats/${encodeURIComponent(sessionId)}/context`;
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
    return req<TriggersResponse>(`${apiBase(slug)}/triggers`);
  },

  /**
   * Create or replace one trigger (keyed by name). Persists to project.yaml's single
   * `triggers` block + arms it. Enabling/disabling is the SAME call with the `enabled`
   * field flipped — there is no separate enable/disable verb (GG-3).
   */
  async putTrigger(slug: string, name: string, input: TriggerInput): Promise<Trigger> {
    const { trigger } = await req<{ trigger: Trigger }>(
      `${apiBase(slug)}/triggers/${encodeURIComponent(name)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
    return trigger;
  },

  /** Delete one trigger (removes it from project.yaml + disarms its agent/schedule). */
  async deleteTrigger(slug: string, name: string): Promise<void> {
    await req<{ ok: boolean }>(
      `${apiBase(slug)}/triggers/${encodeURIComponent(name)}`,
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
      `${apiBase(slug)}/triggers/runtime`,
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
      `${apiBase(slug)}/triggers/${encodeURIComponent(name)}/run`,
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
    return req<GitProjectStatus>(`${apiBase(slug)}/git/status`);
  },

  /**
   * A project's unified diff. Pass `file` (repo-relative) for one file's diff,
   * or omit it for the whole project's tracked diff. Returns the raw diff text
   * (`text/plain`, not JSON). Untracked files have no diff (they're in status).
   */
  async gitDiff(slug: string, file?: string): Promise<string> {
    const qs = file ? `?file=${encodeURIComponent(file)}` : "";
    return reqText(`${apiBase(slug)}/git/diff${qs}`);
  },

  /**
   * Commit a project's changes. `committed:false` ⇒ nothing to commit. Pass
   * `files` (project-relative paths) to commit ONLY those changes; omit it to
   * commit the whole subtree (#258).
   */
  async gitCommit(slug: string, message: string, files?: string[]): Promise<GitCommitResult> {
    return req<GitCommitResult>(`${apiBase(slug)}/git/commit`, {
      method: "POST",
      body: JSON.stringify(files ? { message, files } : { message }),
    });
  },

  /**
   * A PROJECT's own remote + ahead/behind, with the fleet-level GitHub
   * connection state folded in (issue #710). Same shape as {@link gitInfo},
   * which speaks for the backing store; this one speaks for the directory the
   * project actually works in — a linked checkout or worktree has its own
   * origin and its own branch, and the Changes header must describe one repo.
   */
  async gitProjectInfo(slug: string): Promise<GitInfo> {
    return req<GitInfo>(`${apiBase(slug)}/git/remote`);
  },

  /** Push a project's working directory to its remote. */
  async gitPush(slug: string): Promise<GitPushResult> {
    return req<GitPushResult>(`${apiBase(slug)}/git/push`, { method: "POST" });
  },

  /**
   * Fetch an UNTRACKED file's content from the project's WORKING directory
   * (issue #710) — what the Changes tab renders in place of a diff for a new
   * file. Distinct from {@link getProjectFile}, which browses the project's
   * NOTES directory; for a repo-backed or linked project those differ, and the
   * pane used to ask the wrong one and get a 404 for every new file.
   */
  async gitUntrackedFile(slug: string, path: string): Promise<ProjectFile> {
    return req<ProjectFile>(`${apiBase(slug)}/git/file?path=${encodeURIComponent(path)}`);
  },

  /** The URL streaming an untracked file's RAW BYTES (an `<img src>` for a new image). */
  gitUntrackedFileRawUrl(slug: string, path: string): string {
    return `${BASE}${apiBase(slug)}/git/file?path=${encodeURIComponent(path)}&raw=1`;
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
