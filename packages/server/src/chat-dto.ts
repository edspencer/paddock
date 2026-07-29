/**
 * Chat DTO + chat-list helpers for the REST surface. Pure, module-level, and
 * shared by the chat/project route groups: the wire `ChatUsage` shape and its
 * `toChatUsage` builder, the `toChatDto` projection, the preview-cleaning
 * `buildProjectChats`, the `makeTriggerResolver` capability-descriptor resolver,
 * and the run-history page-size constants + `clampRunsLimit`.
 */
import type { DiscoveredSession } from "@herdctl/core";
import type { Project } from "./projects.js";
import { TRIGGER_AGENT_PREFIX, triggerAgentName } from "./herdctl.js";
import { getContextLimit, estimateCostUsdByModel } from "./models.js";
import { type SessionTokenUsage } from "./usage.js";
import type { RunProvenance } from "./run-provenance.js";
import { toTriggerDto } from "./triggers.js";
import { toChatTriggerInfo, type ChatTriggerInfo } from "./trigger-config.js";
import { readFirstUserText } from "./transcripts.js";
import { PRELOAD_CONTEXT_OPEN, stripPreloadWrapper } from "./preload.js";
import { stripAttachmentsWrapper, ATTACHMENTS_OPEN } from "./attachments-hint.js";

/** A session id safe to interpolate into a transcript file path (issue #329). */
export const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/**
 * The chat that created this one, as sent on the wire — what the sidebar files a
 * child under. `project` is carried because a parent can live in ANOTHER project
 * (a keeper spawning into a sibling repo); the list renders those as roots rather
 * than hiding a chat under a parent the user can't see from here.
 */
export interface ChatParentRef {
  project: string;
  sessionId: string;
  /** The parent's display name at creation time — a fallback label only. */
  name?: string;
}

/**
 * Origins that are, by definition, the ROOT of a chat tree — a human typed it, a
 * schedule fired it, or an event hook did. None of them is created BY another
 * chat, so none can acquire a parent.
 */
const ROOT_ORIGINS: ReadonlySet<RunProvenance["origin"]> = new Set([
  "human",
  "scheduled",
  "hook",
]);

/**
 * Does this recorded provenance describe a chat that is a root by construction?
 *
 * `depth` counts spawn hops from the human/scheduled root, so depth 0 IS the root
 * — and a root-origin marker says the same thing from the other direction. Either
 * one means "this chat has no parent", as opposed to "this chat's parent was
 * never recorded", which is the only case the inference tier exists to cover.
 */
export function isRecordedRoot(p: RunProvenance): boolean {
  return p.depth === 0 || ROOT_ORIGINS.has(p.origin);
}

/**
 * Build the `parentOf` resolver for {@link buildProjectChats} — the chat-list
 * parent edge, resolved in two tiers:
 *
 *  1. `RunProvenance.parentSessionId` — the RECORDED edge, stamped at creation.
 *  2. `MessageProvenanceStore.parentChat()` — a backfill for chats created before
 *     tier 1 existed, inferred from who injected the kickoff prompt.
 *
 * Tier 2 only applies to a chat whose parent is genuinely UNKNOWN. A chat with a
 * recorded root marker (#491) is skipped outright: it isn't missing an edge, it
 * has none. Without that guard, the documented report-back workflow re-parents a
 * human's own chat — manager spawns child, child `send_message`s its report home,
 * the manager now carries a `chat`-kind marker and infers its own child as its
 * parent. Both edges then point at each other and `buildChatTree`'s cycle guard
 * decides, per render, which of the two gets promoted to a root.
 *
 * All reads are in-memory sidecar lookups, so this is cheap enough to resolve
 * inline for every row (unlike the usage ring, #116). A chat with neither tier is
 * simply a root.
 */
export function makeParentResolver(
  runProvenance: { get(sessionId: string): Promise<RunProvenance | undefined> },
  messageProvenance: {
    parentChat(sessionId: string): Promise<{ project: string; sessionId: string; name?: string } | null>;
  },
  projectSlug: string,
): (s: DiscoveredSession) => Promise<ChatParentRef | null> {
  return async (s: DiscoveredSession) => {
    const p = await runProvenance.get(s.sessionId).catch(() => undefined);
    // `parentProject` is a WORKSPACE KEY, and the root workspace's key is the
    // empty string — a falsy test here would discard every edge whose parent is
    // a root chat and silently fall through to the inference tier, rendering
    // those chats as orphan roots. Only ABSENCE means "no recorded edge".
    if (p?.parentSessionId && p.parentProject !== undefined)
      return { project: p.parentProject, sessionId: p.parentSessionId };
    // A recorded root never falls through to inference (#491).
    if (p && isRecordedRoot(p)) return null;
    const inferred = await messageProvenance.parentChat(s.sessionId).catch(() => null);
    if (!inferred) return null;
    // Defensive: a chat can't parent itself. The tree builder guards cycles, but
    // a self-edge here would silently drop the row from the roots.
    if (inferred.sessionId === s.sessionId) return null;
    return { ...inferred, project: inferred.project || projectSlug };
  };
}

/** Claude Code's own preview cap (mirrors extractFirstMessagePreview). */
export const PREVIEW_MAX = 100;

/**
 * Reserved read-state session id for the per-project, per-user "runs last seen"
 * watermark (the since-last-visit digest, #268). A real Claude Code session id is
 * a UUID (`/^[0-9a-f-]+$/`), so the double-underscore sentinel can never collide
 * with one — the watermark keys cleanly alongside per-chat read-state.
 */
export const RUNS_SEEN_SESSION = "__runs__";

/** Default + cap for the run-history page size. */
export const RUNS_LIMIT_DEFAULT = 100;
export const RUNS_LIMIT_MAX = 500;

/** Parse + clamp the `?limit=` query for the run-history endpoint. */
export function clampRunsLimit(raw: string | undefined): number {
  const n = raw === undefined ? RUNS_LIMIT_DEFAULT : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return RUNS_LIMIT_DEFAULT;
  return Math.min(n, RUNS_LIMIT_MAX);
}

/**
 * A chat's usage for the UI: the last-turn context fill (issue #77) plus the
 * chat's cumulative lifetime token totals and a ballpark dollar estimate at API
 * rates (issue #152). The cumulative totals and `costUsd` include every sub-agent
 * the chat spawned (issue #242); `contextTokens` stays main-only (last-turn
 * window fill). `costUsd` is null for a model with no known pricing.
 */
export type ChatUsage = {
  contextTokens: number;
  contextLimit: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number | null;
};

/**
 * Build the wire `ChatUsage` from a parsed {@link SessionTokenUsage} and the
 * chat's model. Returns null when the transcript has no usage yet, so the ring
 * simply hides. `totalTokens` is a headline "tokens this chat consumed" figure —
 * output plus the (context-growing) input/cache reads — while `costUsd` prices
 * each class separately (see {@link estimateCostUsd}).
 */
export function toChatUsage(u: SessionTokenUsage, model: string): ChatUsage | null {
  if (!u.hasData) return null;
  const totals = {
    inputTokens: u.inputTotal,
    outputTokens: u.outputTotal,
    cacheReadTokens: u.cacheReadTotal,
    cacheCreationTokens: u.cacheCreationTotal,
  };
  return {
    contextTokens: u.contextTokens,
    contextLimit: getContextLimit(model),
    ...totals,
    totalTokens:
      u.inputTotal + u.outputTotal + u.cacheReadTotal + u.cacheCreationTotal,
    // Price per the model each turn actually ran on (u.byModel), not the passed
    // project/chat default — a chat's turns can span models, so a single blended
    // rate misprices (a Haiku chat billed at the Opus default would be 5× high).
    costUsd: estimateCostUsdByModel(u.byModel),
  };
}

export function toChatDto(
  s: DiscoveredSession,
  previewOverride?: string,
  usage?: ChatUsage | null,
  archived = false,
  lastTurnCompletedAt?: string,
  lastSeen?: number,
  provenance?: RunProvenance | null,
  trigger?: ChatTriggerInfo | null,
  starred = false,
  unread = false,
  parent?: ChatParentRef | null,
) {
  const preview = previewOverride ?? s.preview;
  return {
    sessionId: s.sessionId,
    workingDirectory: s.workingDirectory,
    name: s.customName ?? s.autoName ?? preview ?? s.sessionId.slice(0, 8),
    updatedAt: s.mtime,
    resumable: s.resumable,
    preview,
    // Whether this chat is filed away in the Archived section (#95). Always
    // present so the client can partition the list without a fallback.
    archived,
    // Whether this chat is starred/pinned (#373) — sorts to the top of its
    // population (active or archived). Always present, orthogonal to `archived`.
    starred,
    // ISO timestamp of the last turn the agent FINISHED (from job records, not
    // mtime) — the unread signal (#160). Absent when no completed job record
    // exists yet (session-mode chats, or a brand-new chat still on turn 1).
    ...(lastTurnCompletedAt ? { lastTurnCompletedAt } : {}),
    // Epoch-ms the user last viewed this chat (server-side read-state, #189) —
    // the source of truth for the unread affordance, so it follows the user
    // across devices. 0/absent means never seen on this instance.
    ...(lastSeen ? { lastSeen } : {}),
    // Whether the user MANUALLY flagged this chat unread (#458) — a per-user
    // override on top of the derived unread signal, so a chat resurfaces its cue
    // even after its last turn was seen. Only emitted when set (absent ⇒ false),
    // keeping the payload compact like `lastSeen`.
    ...(unread ? { unread: true } : {}),
    // The context-window fill as of the session's last completed turn (for the
    // per-chat usage ring) plus the chat's cumulative token totals and cost
    // estimate (issue #152), so the list can render both without opening the
    // chat. Only present when the transcript has usage data.
    ...(usage ?? {}),
    // How this chat was created (#267): A1's provenance marker (#261) — origin
    // (human / scheduled / spawned / hook) + spawn depth — so the list can badge the
    // "ran without me" cases. Absent when no marker was recorded (older chats,
    // or ones created before A1). Human origin renders no badge (the default).
    ...(provenance ? { provenance } : {}),
    // The chat that created this one, so the list can nest it under its parent
    // instead of only badging it "spawned". Recorded at creation on newer chats
    // (RunProvenance.parentSessionId) and backfilled from the first injected-message
    // sender on older ones. Absent for roots and for chats with no recoverable edge.
    ...(parent ? { parent } : {}),
    // For a TRIGGER chat (Epic T / T4): the truthful-from-config capability
    // descriptor — trigger type (schedule/event/webhook) + WHEN it fires + granted
    // tools — read from the same `trigger-<slug>-<name>` agent config herdctl
    // enforces. Drives the floating capability banner atop the chat. Absent for
    // non-trigger chats.
    ...(trigger ? { trigger } : {}),
  };
}

/**
 * Build the chat DTOs for a PROJECT's sessions, cleaning names polluted by the
 * preload wrapper (issue #62). When a chat has no better name (no user rename,
 * no Claude-generated summary) AND its preview is the injected `<project-context>`
 * block, we read the untruncated first user message and strip the wrapper so the
 * name reflects the user's actual request. Only preload chats trigger the extra
 * (head-of-file) read; everything else maps straight through.
 */
export async function buildProjectChats(
  projectDir: string,
  sessions: DiscoveredSession[],
  usageOf?: (s: DiscoveredSession) => Promise<ChatUsage | null>,
  archivedOf?: (s: DiscoveredSession) => Promise<boolean>,
  lastTurnAt?: ReadonlyMap<string, string>,
  lastSeenOf?: (s: DiscoveredSession) => Promise<number>,
  provenanceOf?: (s: DiscoveredSession) => Promise<RunProvenance | undefined>,
  triggerOf?: (s: DiscoveredSession) => Promise<ChatTriggerInfo | undefined>,
  starredOf?: (s: DiscoveredSession) => Promise<boolean>,
  unreadOf?: (s: DiscoveredSession) => Promise<boolean>,
  parentOf?: (s: DiscoveredSession) => Promise<ChatParentRef | null>,
) {
  return Promise.all(
    sessions.map(async (s) => {
      // Resolve the usage ring, archived flag, read-state, provenance, trigger, star, unread, name.
      const usage = usageOf ? await usageOf(s).catch(() => null) : null;
      const archived = archivedOf ? await archivedOf(s).catch(() => false) : false;
      const turnAt = lastTurnAt?.get(s.sessionId);
      const lastSeen = lastSeenOf ? await lastSeenOf(s).catch(() => 0) : 0;
      const provenance = provenanceOf ? await provenanceOf(s).catch(() => null) : null;
      const trigger = triggerOf ? await triggerOf(s).catch(() => undefined) : undefined;
      const starred = starredOf ? await starredOf(s).catch(() => false) : false;
      const unread = unreadOf ? await unreadOf(s).catch(() => false) : false;
      const parent = parentOf ? await parentOf(s).catch(() => null) : null;
      // A preview polluted by a machine-prepended wrapper: the preload context
      // block (#1) and/or the composer-attachment block (#328). Either makes the
      // raw first message a poor display name, so recover the real request below.
      const pollutedPreview =
        !s.customName &&
        !s.autoName &&
        (s.preview?.startsWith(PRELOAD_CONTEXT_OPEN) || s.preview?.startsWith(ATTACHMENTS_OPEN));
      if (!pollutedPreview)
        return toChatDto(s, undefined, usage, archived, turnAt, lastSeen, provenance, trigger, starred, unread, parent);

      const full = await readFirstUserText(projectDir, s.sessionId).catch(() => undefined);
      // Strip preload FIRST (it wraps the whole thing), then the attachment block
      // nested inside it, leaving just the user's typed request.
      const cleaned = stripAttachmentsWrapper(stripPreloadWrapper(full ?? s.preview ?? "")).trim();
      // couldn't recover
      if (!cleaned)
        return toChatDto(s, undefined, usage, archived, turnAt, lastSeen, provenance, trigger, starred, unread, parent);
      const preview =
        cleaned.length > PREVIEW_MAX ? `${cleaned.slice(0, PREVIEW_MAX)}...` : cleaned;
      return toChatDto(s, preview, usage, archived, turnAt, lastSeen, provenance, trigger, starred, unread, parent);
    }),
  );
}

/**
 * Build the `triggerOf` resolver for {@link buildProjectChats} (Epic T / T4): for
 * a chat whose attributed agent is a `trigger-<slug>-<name>` agent, resolve its
 * trigger's truthful-from-config capability descriptor for the floating capability
 * banner. Returns `undefined` for every non-trigger chat (the common case).
 *
 * Built from the ALREADY-LOADED project record (no extra disk reads): the project's
 * declared triggers are projected ONCE into an `agentName -> ChatTriggerInfo` map
 * (via the same `toTriggerDto` → `toChatTriggerInfo` projection the trigger service
 * uses, so the descriptor is truthful from config), and each trigger chat is an O(1)
 * map lookup. The `TRIGGER_AGENT_PREFIX` fast-path skips even the lookup for the
 * keeper chats that dominate the list.
 */
export function makeTriggerResolver(
  project: Project,
): (s: DiscoveredSession) => Promise<ChatTriggerInfo | undefined> {
  const byAgentName = new Map<string, ChatTriggerInfo>();
  for (const [name, trigger] of Object.entries(project.triggers ?? {})) {
    byAgentName.set(
      triggerAgentName(project.slug, name),
      toChatTriggerInfo(toTriggerDto(project.slug, name, trigger)),
    );
  }
  return async (s) => {
    if (!s.agentName || !s.agentName.startsWith(TRIGGER_AGENT_PREFIX)) return undefined;
    return byAgentName.get(s.agentName);
  };
}
