/**
 * The route dependency bag + the shared per-request context the route groups
 * close over.
 *
 * `RouteDeps` is the raw service bag `app.ts` hands to {@link registerRoutes}.
 * `buildRouteContext` constructs — ONCE — the handful of helper closures that the
 * original single `registerRoutes` defined inline (read-state user resolution,
 * slug→agent/dir resolution, attachment cleanup, the per-chat usage resolver) and
 * returns them alongside every dep as a {@link RouteCtx}. Each `registerXRoutes`
 * group then takes that context instead of relying on closure scope — which is
 * what lets the ~50 handlers live in per-group modules while sharing one wiring.
 */
import type { FastifyRequest } from "fastify";
import type { DiscoveredSession } from "@herdctl/core";
import type { ProjectStore } from "./projects.js";
import { AttachmentStore, collectAttachmentIds } from "./attachments.js";
import type { HerdctlService } from "./herdctl.js";
import { SCRATCH_SLUG, SCRATCH_AGENT, keeperAgentName } from "./herdctl.js";
import type { GitService } from "./git.js";
import type { GithubAuth } from "./github-auth.js";
import type { ArchiveStore } from "./archive.js";
import type { StarStore } from "./star.js";
import type { ReadStateStore } from "./read-state.js";
import type { RunProvenanceStore } from "./run-provenance.js";
import type { MessageProvenanceStore } from "./message-provenance.js";
import type { PaddockConfig } from "./config.js";
import { type Transcriber } from "./transcribe.js";
import { readSessionTokenUsageWithSubagents } from "./subagents.js";
import type { PaddockEventBus } from "./event-bus.js";
import type { TriggerService } from "./triggers.js";
import { type ChatUsage, toChatUsage } from "./chat-dto.js";

/**
 * The subset of @fastify/multipart's decorated request we use. The plugin
 * decorates `req.file()` at runtime; we model just what we need here rather than
 * rely on the plugin's global `declare module 'fastify'` augmentation, which is
 * brittle under workspace hoisting (fastify can resolve to a different physical
 * copy than the one the plugin augments).
 */
export interface UploadedFile {
  filename?: string;
  mimetype?: string;
  toBuffer(): Promise<Buffer>;
}
/** A streamed multipart part (issue #328 upload): a file or a form field. */
export interface MultipartPart {
  type: "file" | "field";
  filename?: string;
  mimetype?: string;
  toBuffer(): Promise<Buffer>;
}
export interface MultipartLimits {
  limits?: { fileSize?: number; files?: number };
}
export type MultipartRequest = FastifyRequest & {
  file(): Promise<UploadedFile | undefined>;
  parts(opts?: MultipartLimits): AsyncIterableIterator<MultipartPart>;
};

export interface RouteDeps {
  projects: ProjectStore;
  herdctl: HerdctlService;
  git: GitService;
  githubAuth: GithubAuth;
  transcriber: Transcriber;
  archive: ArchiveStore;
  /** Per-chat starred/pinned-flag sidecar (#373). Orthogonal to `archive`. */
  star: StarStore;
  readState: ReadStateStore;
  runProvenance: RunProvenanceStore;
  /**
   * Per-MESSAGE provenance sidecar (issue #290): who injected each machine-added
   * turn. Joined into a chat's message DTO so the history can attribute injected
   * turns ("↩ sent by …" / "⏰ scheduled by …"). Absence ⇒ human (the default).
   */
  messageProvenance: MessageProvenanceStore;
  attachments: AttachmentStore;
  /**
   * Manually fire a project's TRIGGER now (Epic T follow-up / #327), backing the
   * `POST …/triggers/:name/run` "Run now" route + the `run_trigger` self-MCP verb.
   * Supplied by the chat handler (`makeChatHandler(...).fireTrigger`) so a manual run
   * goes through the SAME hub path a cron / event fire uses — a first-class, badged
   * chat, indistinguishable from an automatic fire. Fires ANY trigger type regardless
   * of its `enabled` flag. Resolves the started chat's session id, or `null` if the
   * project/trigger is gone or nothing started. Optional so tests that don't exercise
   * triggers can omit it.
   */
  fireTrigger?: (slug: string, triggerName: string) => Promise<string | null>;
  /**
   * In-process lifecycle event bus (Epic T). The archive route emits `onArchive`
   * on it AFTER the archive commits, so the trigger dispatcher (wired in the chat
   * handler) fires the project's enabled onArchive event triggers. Optional so tests
   * that don't exercise triggers can omit it.
   */
  events?: PaddockEventBus;
  /**
   * Unified trigger CRUD service (Epic T "Unify Triggers" / T3). Backs the
   * `/api/projects/:slug/triggers[/:name]` REST surface the Triggers tab (T4) will
   * drive — list (with the capability-picker catalog), create/replace, edit,
   * enable/disable (just `set` with `enabled` flipped — GG-3), delete. Delegates
   * persistence to `project.yaml`'s single `triggers` block + herdctl arming to
   * {@link TriggerService}. Optional so tests that don't exercise triggers can omit it.
   */
  triggers?: TriggerService;
  cfg: PaddockConfig;
}

/**
 * `RouteDeps` plus the shared helper closures built once by
 * {@link buildRouteContext}. This is what every `registerXRoutes(app, ctx)` group
 * receives.
 */
export interface RouteCtx extends RouteDeps {
  /**
   * Resolve the read-state key's user segment from the authenticated principal:
   * a REAL identity (trusted-header / jwt) keys read-state by username; an
   * anonymous principal (`none` mode) uses the shared bucket (null → no user
   * segment). This is the ONLY place user identity is consumed — read-state is
   * user-keyed-when-present; chat VISIBILITY is deliberately not gated (#189).
   */
  readStateUser(req: FastifyRequest): string | null;
  /** Resolve a slug to the agent name whose sessions back it. */
  agentForSlug(slug: string): Promise<string>;
  /** Resolve a slug to the on-disk project directory holding its `.chats/`. */
  projectDirForSlug(slug: string): Promise<string>;
  /**
   * Remove the attachments a chat referenced, before its transcript is deleted
   * (we read the transcript to find the ids). Best-effort — a failure here must
   * never block the chat delete.
   */
  cleanupAttachments(agent: string, sessionId: string): Promise<void>;
  /**
   * A per-session usage lookup for building a chat list's usage rings (issue
   * #77) + cumulative token/cost figures (issue #152, incl. sub-agents #242):
   * reads each session's transcript plus its sub-agent transcripts (both memoized
   * on mtime) and pairs the parsed totals with the model. Returns null for a
   * session with no usage data yet — the ring simply hides. Keyed on `projectDir`
   * (not the agent name) because paddock resolves transcripts directly under
   * `<projectDir>/.chats/`.
   */
  chatUsageResolver(
    projectDir: string,
    model: string,
  ): (s: DiscoveredSession) => Promise<ChatUsage | null>;
}

/** Construct the shared route context (deps + the helper closures) once. */
export function buildRouteContext(deps: RouteDeps): RouteCtx {
  const { projects, herdctl, attachments } = deps;

  const readStateUser = (req: FastifyRequest): string | null =>
    req.user && !req.user.anonymous ? req.user.username : null;

  async function agentForSlug(slug: string): Promise<string> {
    if (slug === SCRATCH_SLUG) return SCRATCH_AGENT;
    await projects.get(slug); // throws not_found for unknown slug
    return keeperAgentName(slug);
  }

  async function projectDirForSlug(slug: string): Promise<string> {
    if (slug === SCRATCH_SLUG) return herdctl.scratchDir;
    return (await projects.get(slug)).dir;
  }

  async function cleanupAttachments(agent: string, sessionId: string): Promise<void> {
    try {
      const messages = await herdctl.sessionMessages(agent, sessionId);
      await attachments.remove(collectAttachmentIds(messages));
    } catch {
      /* best-effort: orphaned attachment files are harmless */
    }
  }

  function chatUsageResolver(projectDir: string, model: string) {
    return async (s: DiscoveredSession): Promise<ChatUsage | null> => {
      const u = await readSessionTokenUsageWithSubagents(projectDir, s.sessionId).catch(
        () => null,
      );
      return u ? toChatUsage(u, model) : null;
    };
  }

  return {
    ...deps,
    readStateUser,
    agentForSlug,
    projectDirForSlug,
    cleanupAttachments,
    chatUsageResolver,
  };
}
