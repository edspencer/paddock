/**
 * The self-management MCP server def builder + trigger DTO projection, extracted
 * from ws.ts (#403). `buildSelfMcpServerDef` assembles the `paddock_manage` MCP
 * server (issue #214) bound to one turn's context; it takes a {@link
 * ChatHandlerContext} (the deps bag + the shared hub / startAgentTurn /
 * composePreloadedPrompt / fireTrigger closures) instead of closing over
 * makeChatHandler's scope, so it is independently testable.
 */
import type { InjectedMcpServerDef } from "@herdctl/core";
import type { ChatHandlerContext } from "./ws-context.js";
import { keeperAgentName } from "./herdctl.js";
import { isKnownModel, isKnownDriveMode, type DriveMode } from "./models.js";
import {
  selfMcpServerDef,
  type SelfMcpContext,
  type SelfMcpWriteContext,
  type SelfMcpTrigger,
} from "./self-mcp.js";
import { type RunProvenance, childOf } from "./run-provenance.js";
import type { MessageSender } from "./message-provenance.js";
import { resolveMaxSpawnDepth } from "./spawn-capability.js";
import { isCuratorTrigger, mergeTriggerUpdate, type TriggerDto } from "./trigger-config.js";

/**
 * Frame an agent-initiated FORK kickoff (issue #214 Phase 2). A fork inherits the
 * parent's transcript as context — and when the parent is the *live* chat doing
 * the forking, that snapshot is taken mid-turn, so the child would otherwise
 * inherit the parent's "I am still mid-task" identity and reject the seeded
 * instruction (observed in QA). This preamble tells the child the history above
 * is inherited background and that its job now is the given directive — which is
 * exactly the fan-out contract ("fork this chat N times, one work-item each").
 */
export function forkKickoffPrompt(directive: string): string {
  return (
    "[Paddock fan-out] You are a NEW chat forked from the conversation above. " +
    "That history is INHERITED CONTEXT — you are NOT in the middle of the prior " +
    "turn, and its final exchange may be truncated at the fork point; do not try " +
    "to continue it. Use it as background, then carry out this instruction as your " +
    "task now:\n\n" +
    directive
  );
}

/**
 * The slice of herdctl's `ScheduleInfo` the self-MCP schedule DTO surfaces (issue
 * #289) — live runtime state herdctl tracks for an armed schedule. Kept as a local
 * structural type (mirrors routes.ts's `ScheduleRuntimeInfo`) so this module stays
 * off `@herdctl/core`'s import surface.
 */
interface ScheduleRuntimeInfo {
  status?: "idle" | "running" | "disabled";
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastError?: string | null;
}

/**
 * Project a persisted {@link TriggerDto} (+ optional herdctl runtime state for a
 * schedule trigger) onto the flat {@link SelfMcpTrigger} shape the unified trigger
 * tools return (Epic T / T3). Flattens the discriminated `trigger` WHEN + the shared
 * `run` WHAT + null-normalises so the agent reads ONE flat record regardless of type;
 * `info` is only meaningful for an armed schedule trigger (absent for event/webhook).
 */
function toSelfMcpTrigger(dto: TriggerDto, info?: ScheduleRuntimeInfo): SelfMcpTrigger {
  const when = dto.trigger;
  const run = dto.run;
  const isSchedule = when.type === "schedule";
  return {
    name: dto.name,
    agentName: dto.agentName,
    type: when.type,
    cron: when.type === "schedule" ? when.cron ?? null : null,
    interval: when.type === "schedule" ? when.interval ?? null : null,
    event: when.type === "event" ? when.on : null,
    path: when.type === "webhook" ? when.path : null,
    prompt: run.prompt ?? null,
    promptFile: run.promptFile ?? null,
    session: run.session,
    tools: run.tools ?? [],
    maxSpawnDepth: run.maxSpawnDepth ?? null,
    permissionMode: run.permissionMode ?? null,
    model: run.model ?? null,
    maxTurns: run.maxTurns ?? null,
    enabled: dto.enabled === true,
    // Live runtime state is only tracked for an armed SCHEDULE trigger.
    status: isSchedule
      ? info?.status ?? (dto.enabled === false ? "disabled" : "idle")
      : null,
    lastRunAt: isSchedule ? info?.lastRunAt ?? null : null,
    nextRunAt: isSchedule ? info?.nextRunAt ?? null : null,
    lastError: isSchedule ? info?.lastError ?? null : null,
  };
}

/**
 * Build the self-management MCP server def (issue #214) bound to one turn's
 * context, extracted (B1 / #262) so BOTH the human socket path AND the
 * server-initiated {@link startAgentTurn} spawn path share ONE builder.
 *
 * The READ tools (list_projects/list_chats/read_chat) close over turn-independent
 * services and are always present. When `includeWrite` is set, the four WRITE
 * tools (create/fork/message/fork_batch) are appended; each starts a real keeper
 * turn via {@link startAgentTurn}.
 *
 * `parentProvenance` is the provenance of the chat these tools run IN — so any
 * child they spawn is `childOf(parentProvenance)` (origin `spawned`, depth+1).
 * The human path passes {@link HUMAN_ROOT} (depth 0 → children depth 1); the
 * spawned path passes the current turn's own `{ origin, depth }` (so a depth-1
 * child's children are depth 2, and the `maxSpawnDepth` bound descends). The
 * child's `maxSpawnDepth` is resolved from ITS target project (override else
 * instance default), so the bound follows the project a child actually runs in.
 */
export function buildSelfMcpServerDef(
  ctx: ChatHandlerContext,
  params: {
  currentProjectSlug: string;
  currentSessionId: () => string | null;
  parentProvenance: RunProvenance;
  includeWrite: boolean;
  /**
   * Whether to additionally append the Epic T / T3 unified trigger-management
   * tools (list/set/remove_trigger). Resolved per-project by the caller from the
   * REUSED hooks-MCP gate (`hooksMcpEnabled` override else instance default). Only
   * meaningful when `includeWrite` is on — the trigger tools live in the write block.
   */
  includeTriggers: boolean;
}): InjectedMcpServerDef {
  const { currentProjectSlug, currentSessionId, parentProvenance, includeWrite, includeTriggers } =
    params;
  const { deps, hub, startAgentTurn, composePreloadedPrompt, fireTrigger } = ctx;

  const selfMcpContext: SelfMcpContext = {
    listProjects: async () => {
      const projects = await deps.projects.list();
      return projects.map((p) => ({
        slug: p.slug,
        name: p.name,
        area: p.group && p.group.length > 0 ? p.group : undefined,
        status: p.status,
      }));
    },
    listChats: async (projectSlug) => {
      const targets = projectSlug
        ? [await deps.projects.get(projectSlug)]
        : await deps.projects.list();
      const chats = [];
      for (const p of targets) {
        const sessions = await deps.herdctl.listSessions(p);
        for (const s of sessions) {
          chats.push({
            project: p.slug,
            sessionId: s.sessionId,
            name: s.customName ?? s.autoName ?? s.sessionId.slice(0, 8),
            updatedAt: s.mtime,
            running: hub.isRunning(s.sessionId),
          });
        }
      }
      return chats;
    },
    readChat: async (projectSlug, chatSessionId) => {
      const project = await deps.projects.get(projectSlug);
      const messages = await deps.herdctl.sessionMessages(
        keeperAgentName(project.slug),
        chatSessionId,
      );
      return messages.map((m) => ({
        role: m.role,
        text: m.content,
        timestamp: m.timestamp,
      }));
    },
  };

  // Write tools (issue #214 Phase 2) are gated by the caller (`includeWrite`).
  // Each callback resolves the target project (validating it exists), then starts
  // a real keeper turn via startAgentTurn — which streams through the shared hub,
  // so a spawned chat appears + streams live exactly like a human-started one.
  let writeCtx: SelfMcpWriteContext | undefined;
  if (includeWrite) {
    const driveModeFor = (p: Awaited<ReturnType<typeof deps.projects.get>>): DriveMode =>
      p.driveMode && isKnownDriveMode(p.driveMode) ? p.driveMode : deps.cfg.keeperDriveMode;
    // The child runs in its TARGET project, so its spawn bound comes from THAT
    // project's override (else the instance default), not the parent's (#262).
    const maxSpawnDepthFor = (p: Awaited<ReturnType<typeof deps.projects.get>>): number =>
      resolveMaxSpawnDepth(p.maxSpawnDepth, deps.cfg.maxSpawnDepth);
    // A child spawned from this chat is one hop deeper (origin spawned, depth+1);
    // see the method doc for why `parentProvenance` (not always HUMAN_ROOT).
    const spawnedChild: RunProvenance = childOf(parentProvenance);
    // #290: the SENDER of any message these tools inject is THIS chat (the one
    // calling the tool). Resolve its display name at injection time (best effort)
    // so the recipient's history can say "↩ sent by <name>" and deep-link back.
    const senderForCurrentChat = async (): Promise<MessageSender> => {
      const sid = currentSessionId();
      if (!sid) return { kind: "agent" };
      let name: string | undefined;
      try {
        const cur = await deps.projects.get(currentProjectSlug);
        const sessions = await deps.herdctl.listSessions(cur);
        const found = sessions.find((s) => s.sessionId === sid);
        name = found?.customName ?? found?.autoName ?? undefined;
      } catch {
        /* name is best-effort — the link still resolves without it */
      }
      return { kind: "chat", project: currentProjectSlug, sessionId: sid, name };
    };
    writeCtx = {
      currentProjectSlug,
      currentSessionId,
      createChat: async (projectSlug, kickoff, o) => {
        const p = await deps.projects.get(projectSlug);
        // Honor the same OVERVIEW+CHANGELOG preload the human New-Chat path
        // offers, when asked and available (issues #1/#188).
        const composed = o?.preloadContext
          ? await composePreloadedPrompt(projectSlug, kickoff)
          : kickoff;
        // Per-chat model override (#336): a valid requested model wins, else the
        // project default. Re-register the (shared) keeper at it BEFORE the turn —
        // the SAME mechanism (and single-user last-write-wins caveat) as the human
        // model picker (see ensureKeeperModel). The handler already validated it;
        // guard again defensively so an unknown id falls back, never reaches the fleet.
        const overrideModel = o?.model && isKnownModel(o.model) ? o.model : undefined;
        if (overrideModel) await deps.herdctl.ensureKeeperModel(p, overrideModel);
        const newId = await startAgentTurn({
          projectSlug,
          agentName: keeperAgentName(projectSlug),
          workingDir: p.workingDir,
          resume: null,
          prompt: composed,
          driveMode: driveModeFor(p),
          fallbackModel: overrideModel ?? p.model,
          origin: spawnedChild.origin,
          depth: spawnedChild.depth,
          maxSpawnDepth: maxSpawnDepthFor(p),
          sender: await senderForCurrentChat(),
        });
        // Apply the caller-supplied display name (C2 / #264). Without this the
        // `name` param was silently dropped and the title fell back to
        // Claude's ~15-word auto-summary. Mirrors forkSession's rename: best
        // effort, keyed by the target project's keeper agent.
        if (o?.name) {
          await deps.herdctl
            .renameSession(keeperAgentName(projectSlug), newId, o.name)
            .catch(() => undefined);
        }
        return { sessionId: newId };
      },
      forkChat: async ({ projectSlug, sourceSessionId, prompt: kickoff, name, model }) => {
        const p = await deps.projects.get(projectSlug);
        if (!(await deps.herdctl.sessionExists(p, sourceSessionId))) {
          throw new Error(`chat not found: ${sourceSessionId} in project ${projectSlug}`);
        }
        const newId = await deps.herdctl.forkSession(p, sourceSessionId, name);
        // Stamp the forked CHILD's provenance here (not via startAgentTurn,
        // which only stamps a brand-new `resume:null` chat): a fork with no
        // kickoff never calls startAgentTurn, so this covers both cases.
        await deps.runProvenance?.stamp(newId, spawnedChild).catch(() => undefined);
        if (kickoff && kickoff.trim().length > 0) {
          // Per-chat model override (#336): applies to the kickoff turn only (a
          // fork with no kickoff runs no turn). Same shared-keeper re-registration
          // + last-write-wins caveat as the human picker; handler pre-validated,
          // guard again so an unknown id falls back to the project default.
          const overrideModel = model && isKnownModel(model) ? model : undefined;
          if (overrideModel) await deps.herdctl.ensureKeeperModel(p, overrideModel);
          await startAgentTurn({
            projectSlug,
            agentName: keeperAgentName(projectSlug),
            workingDir: p.workingDir,
            resume: newId,
            // Frame the kickoff so the child treats the inherited transcript as
            // CONTEXT and runs its new directive. Without this, forking the
            // *live* chat snapshots it mid-turn, so the child inherits the
            // parent's "I'm mid-task" identity and may refuse the seed prompt
            // (QA #214). This is what makes the fan-out use case ("fork this
            // chat N times, one item each") actually work.
            prompt: forkKickoffPrompt(kickoff),
            driveMode: driveModeFor(p),
            fallbackModel: overrideModel ?? p.model,
            // Resume of the just-forked child: the child was already stamped
            // above, so startAgentTurn won't re-stamp; this just describes the
            // kickoff run honestly. Its self-MCP is gated on the child's own
            // recorded depth (the stamp above), resolved in startAgentTurn.
            origin: spawnedChild.origin,
            depth: spawnedChild.depth,
            maxSpawnDepth: maxSpawnDepthFor(p),
            sender: await senderForCurrentChat(),
          });
        }
        return { sessionId: newId };
      },
      sendMessage: async (projectSlug, targetSessionId, kickoff) => {
        const p = await deps.projects.get(projectSlug);
        if (!(await deps.herdctl.sessionExists(p, targetSessionId))) {
          throw new Error(`chat not found: ${targetSessionId} in project ${projectSlug}`);
        }
        await startAgentTurn({
          projectSlug,
          agentName: keeperAgentName(projectSlug),
          workingDir: p.workingDir,
          resume: targetSessionId,
          prompt: kickoff,
          driveMode: driveModeFor(p),
          fallbackModel: p.model,
          // Resume of an EXISTING chat: startAgentTurn won't stamp (only new
          // chats are stamped), so the target keeps its own creation provenance,
          // and its self-MCP is gated on THAT recorded depth (resolved in
          // startAgentTurn), not on these describe-the-run values.
          origin: spawnedChild.origin,
          depth: spawnedChild.depth,
          maxSpawnDepth: maxSpawnDepthFor(p),
          // #290: this injects into an EXISTING chat, so startAgentTurn also
          // emits a live `chat:injected` frame — the recipient (if open) sees
          // the "↩ sent by <this chat>" user bubble without a refresh (Part 2).
          sender: await senderForCurrentChat(),
        });
      },
      // C1 (#263). Archive/unarchive is presentational metadata only — no turn
      // is started — so it delegates straight to the ArchiveStore, keyed by the
      // target project's agent (mirrors the POST archive endpoints in
      // routes.ts). Enables the "work → archive myself on success" self-reporting
      // convention. `deps.projects.get` validates the slug (throws not_found),
      // matching the other write callbacks.
      setArchived: async (projectSlug, targetSessionId, archived) => {
        await deps.projects.get(projectSlug);
        const changed = await deps.archive.setArchived(
          keeperAgentName(projectSlug),
          targetSessionId,
          archived,
        );
        // Epic G / G1: after the archive COMMITS, emit the `onArchive` lifecycle
        // event (only on a real transition INTO archived) so the dispatcher fires
        // the project's enabled onArchive hooks. This is THE motivating path — a
        // keeper archiving ITSELF on success then triggers its cleanup hook. emit is
        // fire-and-forget, so it never blocks/fails the self-MCP archive tool.
        if (changed && archived) {
          deps.events?.emit("onArchive", { slug: projectSlug, sessionId: targetSessionId });
        }
      },
      // Unified trigger management (Epic T / T3). Delegates to the shared T1
      // TriggerService (persist to project.yaml's single `triggers` block, then
      // arm — an event trigger's own `trigger-<slug>-<name>` agent, a schedule
      // trigger's forwarded `schedules` entry) — the SAME two-step the REST routes
      // + Triggers tab (T4) use. The tools are only INJECTED when `includeTriggers`
      // (the project's REUSED hooks-MCP opt-in) is on, so this flag reflects that
      // resolved gate; the callbacks are wired unconditionally. Collapses the former
      // schedule (#289) + hook (G5) callbacks onto ONE service.
      triggersMcpEnabled: includeTriggers,
      listTriggers: async (projectSlug) => {
        if (!deps.triggers) return [];
        const dtos = await deps.triggers.list(projectSlug);
        // Merge best-effort live runtime state for SCHEDULE triggers (keyed by
        // trigger name — the same key the forwarded `schedules` block uses).
        const p = await deps.projects.get(projectSlug).catch(() => null);
        const runtime = p ? await deps.herdctl.listAgentSchedules(p).catch(() => []) : [];
        const byName = new Map(runtime.map((s) => [s.name, s]));
        return dtos.map((dto) => toSelfMcpTrigger(dto, byName.get(dto.name)));
      },
      setTrigger: async (projectSlug, name, incoming) => {
        if (!deps.triggers) throw new Error("trigger management is unavailable");
        // `set_trigger` is a PARTIAL update, but persistence full-REPLACES the named
        // record — so an edit that omits a field would silently wipe it (e.g. an
        // enable-only flip dropping the run). mergeTriggerUpdate overlays the caller-
        // supplied fields on the existing trigger (preserving omitted trigger/run/
        // enabled, clearing the prompt/promptFile counterpart) and safe-creates a new
        // trigger disabled — then TriggerService.set validates + arms.
        const existing = await deps.triggers.get(projectSlug, name).catch(() => null);
        const record = mergeTriggerUpdate(existing, incoming);
        const dto = await deps.triggers.set(projectSlug, name, record);
        // Best-effort runtime state for a schedule trigger it may have just armed.
        const p = await deps.projects.get(projectSlug).catch(() => null);
        const runtime = p ? await deps.herdctl.listAgentSchedules(p).catch(() => []) : [];
        const info = runtime.find((s) => s.name === name);
        return toSelfMcpTrigger(dto, info);
      },
      removeTrigger: async (projectSlug, name) => {
        if (!deps.triggers) return false;
        return deps.triggers.remove(projectSlug, name);
      },
      runTrigger: async (projectSlug, name) => {
        if (!deps.triggers) return null;
        // Reject the post-turn curator up front with a clear message (the generic
        // fire path can't run it — it has no scoped agent; see fireTrigger). Without
        // this the MCP verb would surface the opaque "did not start a chat" null.
        const p = await deps.projects.get(projectSlug).catch(() => null);
        const rec = p?.triggers?.[name];
        if (rec && isCuratorTrigger(rec)) {
          throw new Error(
            "the post-turn curator trigger runs automatically after each turn and can't be run on demand",
          );
        }
        return fireTrigger(projectSlug, name);
      },
    };
  }

  return selfMcpServerDef(selfMcpContext, writeCtx);
}
