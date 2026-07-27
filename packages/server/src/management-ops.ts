/**
 * The transport-agnostic Management API ops layer (issue #312 M1).
 *
 * This is the single place every management operation is implemented, and the
 * single place policy is enforced. Two exports carry that:
 *
 *   - {@link buildManagementOps} — constructs the operation callbacks (the
 *     `SelfMcpContext` read bag + `SelfMcpWriteContext` write bag) over the
 *     shared {@link ChatHandlerContext}. Extracted from `ws-self-mcp.ts`, which
 *     previously built the ops AND assembled the MCP server def in one function.
 *     Splitting them is what lets a NON-MCP caller (HTTP now, REST parity in
 *     #465) reach the same operations.
 *   - {@link enforceManagementPolicy} — wraps a built ops bag with a
 *     {@link ManagementPrincipal}, so every call is scope-checked centrally.
 *
 * ── Why enforcement is HERE and not in the transport ────────────────────────
 * The load-bearing decision on #312. If the MCP handler enforced scope, the REST
 * endpoints of #465 would have to reimplement it, and the two would drift — a
 * drift whose failure mode is an unchecked write path, i.e. code execution. By
 * enforcing on the ops themselves, any transport that obtains a principal
 * inherits the identical checks for free, and a new transport cannot forget.
 *
 * ── The in-process keeper path is unchanged ─────────────────────────────────
 * A keeper is bounded by DEPTH (`maxSpawnDepth`, #278), not by auth+scope: it is
 * not a distinct identity. It therefore runs under {@link INTERNAL_PRINCIPAL},
 * whose full scope makes every check below short-circuit to allow. This module
 * is a pure refactor for keepers — no behaviour change.
 *
 * ── Enumerate vs. address ───────────────────────────────────────────────────
 * A scoped principal listing projects/chats gets a FILTERED view rather than a
 * denial: "show me what I can see" is a reasonable request, and erroring would
 * make a narrowly-scoped client useless. Operations that NAME a target are
 * asserted instead, so an out-of-scope slug is refused loudly.
 */
import type { ChatHandlerContext } from "./ws-context.js";
import { keeperAgentName } from "./herdctl.js";
import { isKnownModel, isKnownDriveMode, type DriveMode } from "./models.js";
import type {
  SelfMcpContext,
  SelfMcpWriteContext,
  SelfMcpTrigger,
} from "./self-mcp.js";
import type { CreateProjectInput } from "./projects.js";
import { type RunProvenance, childOf } from "./run-provenance.js";
import type { MessageSender } from "./message-provenance.js";
import { resolveMaxSpawnDepth } from "./spawn-capability.js";
import { isCuratorTrigger, mergeTriggerUpdate, type TriggerDto } from "./trigger-config.js";
import {
  assertOperation,
  assertProject,
  isOperationAllowed,
  isProjectAllowed,
  isInternalPrincipal,
  TRIGGER_OPERATIONS,
  WRITE_OPERATIONS,
  type ManagementPrincipal,
} from "./management-policy.js";

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
 * tools return (Epic T / T3).
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
    status: isSchedule ? info?.status ?? (dto.enabled === false ? "disabled" : "idle") : null,
    lastRunAt: isSchedule ? info?.lastRunAt ?? null : null,
    nextRunAt: isSchedule ? info?.nextRunAt ?? null : null,
    lastError: isSchedule ? info?.lastError ?? null : null,
  };
}

/** The built ops. `write` is absent when the caller isn't granted write access. */
export interface ManagementOps {
  read: SelfMcpContext;
  write?: SelfMcpWriteContext;
}

export interface ManagementOpsParams {
  currentProjectSlug: string;
  currentSessionId: () => string | null;
  parentProvenance: RunProvenance;
  includeWrite: boolean;
  includeTriggers: boolean;
  /**
   * Whether to expose `create_project` (#467). Its OWN gate, separate from the
   * other write tools, because it creates INSTANCE-level state and clones
   * caller-supplied git URLs.
   */
  includeProjects: boolean;
  /**
   * Optional ceiling on the spawn depth granted to turns these ops start
   * (a scoped external principal's `scope.maxSpawnDepth`). Applied as a MINIMUM
   * against the target project's resolved bound, so a scope can only ever
   * NARROW what the project would allow, never widen it.
   */
  spawnDepthCap?: number;
}

/**
 * Build the management operations bound to one caller's context.
 *
 * `parentProvenance` is the provenance of the chat these ops run IN — so any
 * child they spawn is `childOf(parentProvenance)` (origin `spawned`, depth+1).
 * The human path passes a human root (depth 0 → children depth 1); the spawned
 * path passes the current turn's own `{ origin, depth }`, so the `maxSpawnDepth`
 * bound descends and the tree can't run away.
 */
export function buildManagementOps(
  ctx: ChatHandlerContext,
  params: ManagementOpsParams,
): ManagementOps {
  const {
    currentProjectSlug,
    currentSessionId,
    parentProvenance,
    includeWrite,
    includeTriggers,
    includeProjects,
    spawnDepthCap,
  } = params;
  const { deps, hub, startAgentTurn, composePreloadedPrompt, fireTrigger } = ctx;

  const read: SelfMcpContext = {
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
        // Hoisted: every session in this project is keyed by the SAME keeper agent.
        const agent = keeperAgentName(p.slug);
        for (const s of sessions) {
          chats.push({
            project: p.slug,
            sessionId: s.sessionId,
            name: s.customName ?? s.autoName ?? s.sessionId.slice(0, 8),
            updatedAt: s.mtime,
            running: hub.isRunning(s.sessionId),
            // #489: the archived flag the web UI has always had (`chat-dto.ts`) but
            // the MCP surface never reported — so the two disagreed about what "the
            // chat list" is. Cost is nil: ArchiveStore lazy-loads once and caches,
            // so this is a `Set.has()` per chat, not a read per chat.
            archived: await deps.archive.isArchived(agent, s.sessionId),
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

  if (!includeWrite) return { read };

  const driveModeFor = (p: Awaited<ReturnType<typeof deps.projects.get>>): DriveMode =>
    p.driveMode && isKnownDriveMode(p.driveMode) ? p.driveMode : deps.cfg.keeperDriveMode;
  // The child runs in its TARGET project, so its spawn bound comes from THAT
  // project's override (else the instance default), not the parent's (#262) —
  // then narrowed by any caller-scoped cap (never widened).
  const maxSpawnDepthFor = (p: Awaited<ReturnType<typeof deps.projects.get>>): number => {
    const resolved = resolveMaxSpawnDepth(p.maxSpawnDepth, deps.cfg.maxSpawnDepth);
    return spawnDepthCap === undefined ? resolved : Math.min(resolved, spawnDepthCap);
  };
  const spawnedChild: RunProvenance = childOf(parentProvenance);
  // #290: the SENDER of any message these ops inject is THIS chat. Resolve its
  // display name at injection time (best effort) so the recipient's history can
  // say "↩ sent by <name>" and deep-link back.
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

  /**
   * THIS chat, as the parent edge to record on anything it creates (#509).
   * Deliberately id-only and name-free: unlike the message sender above, a
   * lineage edge is resolved against the live chat list at render time, so
   * caching a display name here would just go stale.
   *
   * Null when there is no calling chat — the external `/mcp` transport binds
   * `currentSessionId: () => null`, and a schedule/hook fire has no parent.
   */
  const parentRefForCurrentChat = (): { project: string; sessionId: string } | undefined => {
    const sid = currentSessionId();
    return sid ? { project: currentProjectSlug, sessionId: sid } : undefined;
  };

  const write: SelfMcpWriteContext = {
    currentProjectSlug,
    currentSessionId,
    createChat: async (projectSlug, kickoff, o) => {
      const p = await deps.projects.get(projectSlug);
      const composed = o?.preloadContext
        ? await composePreloadedPrompt(projectSlug, kickoff)
        : kickoff;
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
        parent: parentRefForCurrentChat(),
        maxSpawnDepth: maxSpawnDepthFor(p),
        sender: await senderForCurrentChat(),
      });
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
      // Stamp the forked CHILD's provenance here (not via startAgentTurn, which
      // only stamps a brand-new `resume:null` chat): a fork with no kickoff never
      // calls startAgentTurn, so this covers both cases.
      //
      // A fork's parent is the chat it was forked FROM, not the chat that called
      // the tool — a fork belongs under its source in the tree. This is the only
      // record of that edge: forkSession rewrites the source id out of the child's
      // transcript, and a kickoff-less fork injects no message to infer it from.
      await deps.runProvenance
        ?.stamp(newId, childOf(parentProvenance, { project: projectSlug, sessionId: sourceSessionId }))
        .catch(() => undefined);
      if (kickoff && kickoff.trim().length > 0) {
        const overrideModel = model && isKnownModel(model) ? model : undefined;
        if (overrideModel) await deps.herdctl.ensureKeeperModel(p, overrideModel);
        await startAgentTurn({
          projectSlug,
          agentName: keeperAgentName(projectSlug),
          workingDir: p.workingDir,
          resume: newId,
          prompt: forkKickoffPrompt(kickoff),
          driveMode: driveModeFor(p),
          fallbackModel: overrideModel ?? p.model,
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
        origin: spawnedChild.origin,
        depth: spawnedChild.depth,
        maxSpawnDepth: maxSpawnDepthFor(p),
        sender: await senderForCurrentChat(),
      });
    },
    setArchived: async (projectSlug, targetSessionId, archived) => {
      await deps.projects.get(projectSlug);
      const changed = await deps.archive.setArchived(
        keeperAgentName(projectSlug),
        targetSessionId,
        archived,
      );
      // Epic G / G1: after the archive COMMITS, emit the `onArchive` lifecycle
      // event (only on a real transition INTO archived) so the dispatcher fires
      // the project's enabled onArchive hooks.
      if (changed && archived) {
        deps.events?.emit("onArchive", { slug: projectSlug, sessionId: targetSessionId });
      }
    },
    // Project provisioning (#467). Behind its OWN gate, separate from the other
    // write tools, because this is the one that creates INSTANCE-level state. The
    // body is deliberately the SAME two calls, in the same order, that
    // `POST /api/projects` makes — store create, then keeper registration — so the
    // REST and MCP paths can't drift: all validation, the #187 repo clone and its
    // rollback live in `ProjectStore.create`.
    projectsMcpEnabled: includeProjects,
    createProject: async (input) => {
      // The handler already validated `status` against PROJECT_STATUSES (the same
      // list ProjectStatus is derived from), so narrowing it here is sound — it's
      // only `string` on the MCP input type to keep that module free of the
      // project layer's types.
      const project = await deps.projects.create({
        ...input,
        status: input.status as CreateProjectInput["status"],
      });
      // Mirror the route's non-fatal treatment: the project IS created even if
      // registering its keeper/sweeper agents fails. Unlike the route (which only
      // logs) we report it, since the agent's very next step is usually a
      // `create_chat` into this project, which needs a live keeper.
      let keeperRegistered = true;
      try {
        await deps.herdctl.ensureProjectAgent(project);
      } catch {
        keeperRegistered = false;
      }
      return {
        slug: project.slug,
        name: project.name,
        dir: project.dir,
        workingDir: project.workingDir,
        repoBacked: project.repoBacked === true,
        ...(project.repo ? { repo: project.repo } : {}),
        keeperRegistered,
      };
    },
    triggersMcpEnabled: includeTriggers,
    listTriggers: async (projectSlug) => {
      if (!deps.triggers) return [];
      const dtos = await deps.triggers.list(projectSlug);
      const p = await deps.projects.get(projectSlug).catch(() => null);
      const runtime = p ? await deps.herdctl.listAgentSchedules(p).catch(() => []) : [];
      const byName = new Map(runtime.map((s) => [s.name, s]));
      return dtos.map((dto) => toSelfMcpTrigger(dto, byName.get(dto.name)));
    },
    setTrigger: async (projectSlug, name, incoming) => {
      if (!deps.triggers) throw new Error("trigger management is unavailable");
      const existing = await deps.triggers.get(projectSlug, name).catch(() => null);
      const record = mergeTriggerUpdate(existing, incoming);
      const dto = await deps.triggers.set(projectSlug, name, record);
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
      // fire path can't run it — it has no scoped agent; see fireTrigger).
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

  return { read, write };
}

/**
 * Wrap built ops so every call is checked against `principal`.
 *
 * Returns the ops UNCHANGED for the internal principal — the keeper path must be
 * byte-for-byte identical to its pre-#312 behaviour, and skipping the wrapper
 * entirely is the most honest way to guarantee that.
 *
 * The write bag is dropped wholesale when the principal is granted no write
 * operation, so a read-only client's write tools are ABSENT rather than
 * present-and-refusing — matching how the existing capability gates behave.
 */
export function enforceManagementPolicy(
  ops: ManagementOps,
  principal: ManagementPrincipal,
): ManagementOps {
  if (isInternalPrincipal(principal)) return ops;
  const { scope } = principal;

  const read: SelfMcpContext = {
    listProjects: async () => {
      assertOperation(principal, "list_projects");
      // Enumeration filters rather than denies — see the module header.
      return (await ops.read.listProjects()).filter((p) => isProjectAllowed(scope, p.slug));
    },
    listChats: async (projectSlug) => {
      assertOperation(principal, "list_chats");
      if (projectSlug !== undefined) assertProject(principal, "list_chats", projectSlug);
      return (await ops.read.listChats(projectSlug)).filter((c) =>
        isProjectAllowed(scope, c.project),
      );
    },
    readChat: async (projectSlug, sessionId) => {
      assertOperation(principal, "read_chat");
      assertProject(principal, "read_chat", projectSlug);
      return ops.read.readChat(projectSlug, sessionId);
    },
  };

  const grantsAnyWrite = WRITE_OPERATIONS.some((op) => isOperationAllowed(scope, op));
  const grantsAnyTrigger = TRIGGER_OPERATIONS.some((op) => isOperationAllowed(scope, op));
  if (!ops.write || (!grantsAnyWrite && !grantsAnyTrigger)) return { read };

  const w = ops.write;
  // `async` so a denial surfaces as a REJECTED PROMISE, never a synchronous
  // throw: these callbacks are typed as returning promises, and a caller that
  // only attaches `.catch()` (rather than awaiting inside a try) would otherwise
  // see the error escape as an unhandled exception.
  const guard = async <T>(
    operation: string,
    projectSlug: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    assertOperation(principal, operation);
    assertProject(principal, operation, projectSlug);
    return run();
  };

  const write: SelfMcpWriteContext = {
    currentProjectSlug: w.currentProjectSlug,
    currentSessionId: w.currentSessionId,
    // Instance-level, so there is no project to scope-check — only the verb.
    projectsMcpEnabled: w.projectsMcpEnabled && isOperationAllowed(scope, "create_project"),
    createProject: (input) => {
      assertOperation(principal, "create_project");
      return w.createProject(input);
    },
    createChat: (projectSlug, prompt, o) =>
      guard("create_chat", projectSlug, () => w.createChat(projectSlug, prompt, o)),
    // NOTE: `fork_chat_batch` is a convenience wrapper that calls this same
    // callback N times, so it is gated on `fork_chat` here AND on
    // `fork_chat_batch` at tool-assembly time (see managementToolFilter).
    forkChat: (args) => guard("fork_chat", args.projectSlug, () => w.forkChat(args)),
    sendMessage: (projectSlug, sessionId, prompt) =>
      guard("send_message", projectSlug, () => w.sendMessage(projectSlug, sessionId, prompt)),
    setArchived: (projectSlug, sessionId, archived) =>
      guard(archived ? "archive_chat" : "unarchive_chat", projectSlug, () =>
        w.setArchived(projectSlug, sessionId, archived),
      ),
    // Only offer the trigger tools when the principal is granted at least one.
    triggersMcpEnabled: w.triggersMcpEnabled && grantsAnyTrigger,
    listTriggers: (projectSlug) =>
      guard("list_triggers", projectSlug, () => w.listTriggers(projectSlug)),
    setTrigger: (projectSlug, name, trigger) =>
      guard("set_trigger", projectSlug, () => w.setTrigger(projectSlug, name, trigger)),
    removeTrigger: (projectSlug, name) =>
      guard("remove_trigger", projectSlug, () => w.removeTrigger(projectSlug, name)),
    runTrigger: (projectSlug, name) =>
      guard("run_trigger", projectSlug, () => w.runTrigger(projectSlug, name)),
  };

  return { read, write };
}

/**
 * A predicate selecting which MCP tools a principal should even SEE.
 *
 * Tool-list filtering is presentation, not enforcement — the ops wrapper above
 * is what actually refuses a call. But hiding out-of-scope tools means a client
 * never offers its model a verb it cannot use, which avoids a whole class of
 * confusing "the tool exists but always errors" behaviour.
 */
export function managementToolFilter(
  principal: ManagementPrincipal,
): (toolName: string) => boolean {
  if (isInternalPrincipal(principal)) return () => true;
  return (toolName: string) => {
    if (!isOperationAllowed(principal.scope, toolName)) return false;
    // The batch fan-out executes through `fork_chat`, so offering it without
    // that grant would produce a tool that is present but denied on every call.
    if (toolName === "fork_chat_batch") return isOperationAllowed(principal.scope, "fork_chat");
    return true;
  };
}
