/**
 * Wake-time injected-MCP resolution (edspencer/herdctl#390, wired in
 * @herdctl/core 5.22.1).
 *
 * ── The bug ───────────────────────────────────────────────────────────────────
 * Paddock injects in-process MCP servers — `mcp__paddock_manage__*` (self-
 * management, #214) and `mcp__paddock__*` (send_file, #113) — into keeper turns via
 * `injectedMcpServers`. These are per-turn runtime values Paddock supplies only when
 * IT drives a turn (the human socket path and every server-initiated `startAgentTurn`
 * fire). herdctl's session WAKE path — a `ScheduleWakeup` / `/loop` / `CronCreate`
 * re-fire of an idle/reaped session — drives the turn INSIDE herdctl and, before
 * 5.22.1, re-spawned the `claude` subprocess with the `mcp__paddock*__*` tools still
 * "allowed" (they're on `agent.allowed_tools`) but with NO in-process server behind
 * them. Result: the injected tools vanish from the catalog for the whole autonomous
 * stretch (observed multi-hour episodes; permanent after a host restart, since the
 * durable wake set re-fires MCP-less). See `/tmp/mcp-flap-investigation.md`.
 *
 * ── The fix ───────────────────────────────────────────────────────────────────
 * 5.22.1 added `FleetManager.setResolveInjectedMcpServers(resolve)` — a SYNCHRONOUS
 * resolver herdctl calls on each wake fire and threads into `openChatSession` before
 * the subprocess spawns. This module is Paddock's policy for that resolver.
 *
 * Because Paddock's live-turn builder is ASYNC (it awaits provenance + project state
 * for depth/trigger gating) but the herdctl resolver is SYNC, we resolve from an
 * in-memory cache of the last server set Paddock built for each session
 * ({@link WakeInjectionResolver.remember}, called on every live turn). A wake fire
 * ({@link WakeInjectionResolver.resolve}) replays the cached set synchronously. This
 * closes the LIVE flap fully — including the common case (a human/spawn turn sets up
 * a self-wake, so the cache is warm when that same session wakes).
 *
 * The cold-cache case (a durable wake re-firing after a server RESTART, before any
 * live turn re-populates the cache) can't be served synchronously — the source data
 * is async. On a miss we kick a background {@link WakeInjectionResolver.warm} that
 * rebuilds + caches the set, so the NEXT wake for that session is covered; the FIRST
 * post-restart wake still degrades to no-injection (the next human/Trigger turn — or
 * the next wake — restores it). This is the single documented residual.
 */
import type { InjectedMcpServerDef, SessionWakeEntry } from "@herdctl/core";
import { sendFileServerDef, SEND_FILE_SERVER_KEY } from "./send-file-mcp.js";
import { SELF_MCP_SERVER_KEY } from "./self-mcp.js";
import { spawnedSelfMcpDecision } from "./spawn-capability.js";
import { resolveHooksMcpEnabled } from "./hook-config.js";
import type { TurnOrigin } from "./run-provenance.js";

/** The per-turn context that decides which injected servers a turn receives. */
export interface InjectedMcpBuildArgs {
  /** Slug of the project this turn runs in (`scratch` gets send_file only). */
  projectSlug: string;
  /** Keeper cwd — resolves the send_file tool's relative `file_path`. */
  workingDir: string;
  /**
   * The session being resumed, or `null` for a new chat. On a resume, the CHAT's
   * OWN recorded depth (not the caller's describe-the-run value) governs self-MCP
   * gating — a depth-1 child reporting back to its depth-0 root must gate on 0.
   */
  resume: string | null;
  /** Origin stamped on any child this turn's self-MCP write tools spawn. */
  origin: TurnOrigin;
  /** The depth to gate on when there's no recorded provenance for {@link resume}. */
  depth: number;
  /** Effective spawn bound for the chat this turn runs in (resolved by the caller). */
  maxSpawnDepth: number;
  /** Late-bound accessor for the resolved session id (self-MCP tools attribute by it). */
  currentSessionId: () => string | null;
}

/** The (mostly injected) collaborators {@link buildInjectedMcpServers} needs. */
export interface InjectedMcpBuildContext {
  /** The reserved scratch slug (`SCRATCH_SLUG`) — scratch turns get no self-MCP. */
  scratchSlug: string;
  /** Instance self-MCP gates (resolved from `PaddockConfig`). */
  cfg: { selfMcpEnabled: boolean; selfMcpWriteEnabled: boolean; hooksMcpEnabled: boolean };
  /** Persist a file's bytes into the attachment store (send_file's snapshot). */
  saveAttachment: (bytes: Buffer, filenameForExt: string) => Promise<string>;
  /**
   * Resolve a chat's recorded provenance for injection-depth on a resume. Optional
   * (mirrors the optional `runProvenance` dep on the socket handler): absent ⇒ the
   * caller's `depth` is used unchanged, exactly like the pre-extraction inline path.
   */
  getProvenance?: (sessionId: string) => Promise<{ depth: number } | undefined>;
  /**
   * Resolve a project's `hooksMcpEnabled` OVERRIDE (undefined when unset/unknown),
   * for the T3 trigger-tool gate. Only consulted when write tools are on.
   */
  getProjectHooksMcp: (slug: string) => Promise<boolean | undefined>;
  /**
   * Build the self-management MCP server def. Provided by ws.ts because it closes
   * over the hub / `startAgentTurn` spawn path; injected here so this module stays
   * pure + unit-testable.
   */
  buildSelfMcp: (params: {
    currentProjectSlug: string;
    currentSessionId: () => string | null;
    parentProvenance: { origin: TurnOrigin; depth: number };
    includeWrite: boolean;
    includeTriggers: boolean;
  }) => InjectedMcpServerDef;
}

/**
 * Build the injected-MCP server set for one keeper turn — the SINGLE source of the
 * per-turn injection policy, shared by the live `startAgentTurn` path and the wake
 * rebuild so they can never drift. send_file is ALWAYS present (parity with the human
 * path); the self-management MCP is appended iff the depth-gated
 * {@link spawnedSelfMcpDecision} says so, and its T3 trigger tools iff writes are on
 * AND the project's reused hooks-MCP gate is enabled. Semantics are identical to the
 * previously-inline construction in `startAgentTurn`.
 */
export async function buildInjectedMcpServers(
  args: InjectedMcpBuildArgs,
  ctx: InjectedMcpBuildContext,
): Promise<Record<string, InjectedMcpServerDef>> {
  const { projectSlug, workingDir, resume, origin, depth, maxSpawnDepth, currentSessionId } = args;

  // Always-on send_file (parity with the human path).
  const servers: Record<string, InjectedMcpServerDef> = {
    [SEND_FILE_SERVER_KEY]: sendFileServerDef({
      workingDirectory: workingDir,
      saveAttachment: ctx.saveAttachment,
    }),
  };

  // A resume runs in an EXISTING chat whose own recorded depth governs it; fall back
  // to the caller's `depth` when the chat has no marker (or provenance isn't wired).
  let injectionDepth = depth;
  if (resume !== null && ctx.getProvenance) {
    const rec = await ctx.getProvenance(resume).catch(() => undefined);
    if (rec) injectionDepth = rec.depth;
  }

  const selfMcp = spawnedSelfMcpDecision({
    isScratch: projectSlug === ctx.scratchSlug,
    selfMcpEnabled: ctx.cfg.selfMcpEnabled,
    selfMcpWriteEnabled: ctx.cfg.selfMcpWriteEnabled,
    depth: injectionDepth,
    maxSpawnDepth,
  });
  if (selfMcp.inject) {
    // Trigger-management tools (T3) follow the TARGET project's reused hooks-MCP
    // opt-in (override else instance default) — only meaningful with write tools.
    let includeTriggers = false;
    if (selfMcp.includeWrite) {
      const override = await ctx.getProjectHooksMcp(projectSlug).catch(() => undefined);
      includeTriggers = resolveHooksMcpEnabled(override, ctx.cfg.hooksMcpEnabled);
    }
    servers[SELF_MCP_SERVER_KEY] = ctx.buildSelfMcp({
      currentProjectSlug: projectSlug,
      currentSessionId,
      parentProvenance: { origin, depth: injectionDepth },
      includeWrite: selfMcp.includeWrite,
      includeTriggers,
    });
  }
  return servers;
}

/** Public surface of the wake-injection cache/resolver. */
export interface WakeInjectionResolver {
  /**
   * Record the server set Paddock built for a live turn, keyed by its session id, so
   * a later wake of that session can replay it. Idempotent; a null/blank id is a
   * no-op; the newest entry is most-recently-used for eviction.
   */
  remember(
    sessionId: string | null | undefined,
    servers: Record<string, InjectedMcpServerDef>,
  ): void;
  /**
   * The SYNCHRONOUS resolver registered with herdctl. On a cache hit it replays the
   * remembered set (refreshing recency); on a miss it kicks a background
   * {@link warm} (so the NEXT wake is covered) and returns `undefined` — no injection
   * for THIS fire. NEVER throws.
   */
  resolve(entry: SessionWakeEntry): Record<string, InjectedMcpServerDef> | undefined;
  /**
   * Rebuild + cache the server set for a woken session (cold-cache warm after a
   * restart). Deduplicates concurrent warms and is non-throwing.
   */
  warm(entry: SessionWakeEntry): Promise<Record<string, InjectedMcpServerDef> | undefined>;
  /** True if a session's set is currently cached (test/introspection). */
  has(sessionId: string): boolean;
  /** Number of cached sessions (test/introspection). */
  size(): number;
}

export interface WakeInjectionDeps {
  /**
   * Rebuild the injected servers for a woken session — resolves the project + its
   * config and delegates to {@link buildInjectedMcpServers}. Returns `undefined` when
   * the session should receive no injection (scratch / unknown project). Should not
   * reject (the cache catches defensively regardless).
   */
  rebuild: (entry: SessionWakeEntry) => Promise<Record<string, InjectedMcpServerDef> | undefined>;
  /** Soft cap on cached sessions; oldest (LRU) evicted past it. Default 1024. */
  limit?: number;
}

/** Default cap — generous vs. any realistic live-session count, bounds memory. */
export const DEFAULT_WAKE_INJECTION_LIMIT = 1024;

/**
 * Create the wake-injection cache/resolver. Holds an LRU-ish map of the last server
 * set built per session; the sync {@link WakeInjectionResolver.resolve} replays it on
 * a wake, and a background {@link WakeInjectionResolver.warm} rebuilds a cold entry.
 */
export function createWakeInjectionCache(deps: WakeInjectionDeps): WakeInjectionResolver {
  const limit = deps.limit && deps.limit > 0 ? deps.limit : DEFAULT_WAKE_INJECTION_LIMIT;
  const cache = new Map<string, Record<string, InjectedMcpServerDef>>();
  const inflight = new Map<string, Promise<Record<string, InjectedMcpServerDef> | undefined>>();

  const remember: WakeInjectionResolver["remember"] = (sessionId, servers) => {
    if (!sessionId) return;
    // delete-then-set moves the key to the newest position (Map preserves insertion
    // order), so eviction below drops the genuinely least-recently-touched entry.
    cache.delete(sessionId);
    cache.set(sessionId, servers);
    while (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const warm: WakeInjectionResolver["warm"] = (entry) => {
    const id = entry?.sessionId;
    if (!id) return Promise.resolve(undefined);
    const cached = cache.get(id);
    if (cached) return Promise.resolve(cached);
    const existing = inflight.get(id);
    if (existing) return existing;
    const p = (async () => {
      try {
        const servers = await deps.rebuild(entry);
        if (servers) remember(id, servers);
        return servers;
      } catch {
        return undefined; // a rebuild failure degrades to no-injection, never throws
      } finally {
        inflight.delete(id);
      }
    })();
    inflight.set(id, p);
    return p;
  };

  const resolve: WakeInjectionResolver["resolve"] = (entry) => {
    try {
      const id = entry?.sessionId;
      if (!id) return undefined;
      const hit = cache.get(id);
      if (hit) {
        cache.delete(id);
        cache.set(id, hit); // refresh recency
        return hit;
      }
      // Cold cache (e.g. post-restart): warm for the NEXT fire, no injection now.
      void warm(entry);
      return undefined;
    } catch {
      return undefined; // resolve is called sync by herdctl — must never throw
    }
  };

  return {
    remember,
    resolve,
    warm,
    has: (sessionId) => cache.has(sessionId),
    size: () => cache.size,
  };
}
