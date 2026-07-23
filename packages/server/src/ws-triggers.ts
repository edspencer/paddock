/**
 * Trigger / schedule / event firing cluster, extracted from ws.ts (#403).
 *
 * `makeTriggerCluster(deps, startAgentTurn)` returns the shared firing surface and
 * wires the herdctl schedule handler + the onArchive / afterTurn event listeners.
 * Every trigger type funnels through ONE `startAgentTurn` call (the shared engine,
 * passed in) so a cron / event / manual "Run now" fire is indistinguishable.
 *
 * Also holds two helpers historically co-located with the firing code: the
 * post-turn `emitAfterTurn` curation signal (T5 sweeper) and `composePreloadedPrompt`
 * (the OVERVIEW+CHANGELOG new-chat preload, shared by the human path + self-MCP).
 */
import { promises as fs } from "node:fs";
import type { TriggerInfo } from "@herdctl/core";
import type { DriveMode } from "./models.js";
import { isKnownDriveMode } from "./models.js";
import {
  keeperAgentName,
  keeperSlugFromAgent,
  triggerAgentName,
  SCRATCH_SLUG,
} from "./herdctl.js";
import { resolveMaxSpawnDepth } from "./spawn-capability.js";
import { wrapPreload, composePreloadContext } from "./preload.js";
import {
  triggerPromptFileAbsPath,
  triggerRunsOnOwnAgent,
  isCuratorTrigger,
  type TriggerDto,
  type TriggerEvent,
} from "./trigger-config.js";
import type { ChatHandlerDeps, StartAgentTurn } from "./ws-context.js";

/**
 * The context a fired lifecycle event carries into an EVENT trigger's prompt (Epic T /
 * T1). v1 (`onArchive`) supplies the archived chat's session id so the trigger knows
 * what to act on.
 */
export interface TriggerEventContext {
  /** The session id of the chat whose lifecycle event fired the trigger. */
  sessionId: string;
}

/** The shared trigger-firing surface `makeChatHandler` consumes + returns. */
export interface TriggerCluster {
  /** Post-turn curation signal (T5): emit `afterTurn` so the sweeper runs once. */
  emitAfterTurn(slug: string, sessionId: string | null): void;
  /** Prepend the OVERVIEW+CHANGELOG preload block for a new chat (issues #1/#188). */
  composePreloadedPrompt(projectSlug: string, baseMessage: string): Promise<string>;
  /** Fire a named trigger on demand (Run-now / run_trigger); resolves its chat id or null. */
  fireTrigger(slug: string, triggerName: string): Promise<string | null>;
  /** Run one fire of a resolved trigger record as a first-class chat on the hub. */
  fireTriggerForProject(
    project: Awaited<ReturnType<ChatHandlerDeps["projects"]["get"]>>,
    trigger: TriggerDto,
    ctx?: TriggerEventContext,
  ): Promise<string | null>;
  /** Fire every enabled EVENT trigger matching `event` for a project (after-commit). */
  dispatchEventTriggers(slug: string, event: TriggerEvent, ctx: TriggerEventContext): Promise<void>;
}

/**
 * Build the trigger-firing cluster bound to the handler's deps + the shared
 * `startAgentTurn` engine, and wire its schedule/event listeners.
 */
export function makeTriggerCluster(
  deps: ChatHandlerDeps,
  startAgentTurn: StartAgentTurn,
): TriggerCluster {
/** Resolve a project's effective keeper drive mode (override else instance default). */
function resolveDriveMode(project: Awaited<ReturnType<typeof deps.projects.get>>): DriveMode {
  return project.driveMode && isKnownDriveMode(project.driveMode)
    ? project.driveMode
    : deps.cfg.keeperDriveMode;
}

// Drive scheduler-fired chats onto the hub (issue #265 / DD-1, DD-2). herdctl's
// cron engine fires a project keeper's declared schedule and routes it HERE
// (setScheduleTriggerHandler) instead of running it headless.
deps.herdctl.onScheduleTrigger(async (info: TriggerInfo) => {
  const slug = keeperSlugFromAgent(info.agent.name);
  // Only keeper agents carry Paddock schedules; a non-keeper trigger (there are
  // none today) has nowhere sensible to route, so ignore it rather than guess.
  if (!slug) return;
  const project = await deps.projects.get(slug).catch(() => null);
  if (!project) return;
  // Every armed keeper schedule belongs to a SCHEDULE-type trigger (forwarded into
  // the keeper `schedules` block under its trigger name). Resolve + fire it via the
  // single trigger fire path.
  const trig = project.triggers?.[info.scheduleName];
  if (trig && trig.trigger.type === "schedule" && trig.enabled === true) {
    await fireTriggerForProject(project, {
      name: info.scheduleName,
      agentName: triggerAgentName(slug, info.scheduleName),
      ...trig,
    });
  }
  // A fired keeper schedule with no matching enabled SCHEDULE trigger is ignored:
  // triggers are the only thing forwarded into the keeper's `schedules` block.
});

// --- unified triggers (Epic T / T1) ------------------------------------

/**
 * Resolve the prompt a fired trigger should run. A trigger's `promptFile`
 * (Paddock-only, `.paddock/triggers/*.md`, git-tracked + keeper-editable) is read
 * FRESH here at fire time — so an edit takes effect on the very next fire with no
 * agent re-register — and falls back to the inline `run.prompt` when there's no file
 * or it can't be read. For an EVENT trigger, a short machine preamble naming the
 * event + archived chat is prepended (so the trigger knows WHAT to act on); a
 * schedule trigger gets no preamble. Mirrors {@link resolveSchedulePrompt} /
 * {@link resolveHookPrompt}.
 */
async function resolveTriggerPrompt(
  project: Awaited<ReturnType<typeof deps.projects.get>>,
  trigger: TriggerDto,
  ctx?: TriggerEventContext,
): Promise<string> {
  let body = typeof trigger.run.prompt === "string" ? trigger.run.prompt : "";
  if (trigger.run.promptFile) {
    const abs = triggerPromptFileAbsPath(project.workingDir, trigger.run.promptFile);
    if (abs) {
      const content = await fs.readFile(abs, "utf8").catch(() => null);
      if (content !== null) body = content;
    }
  }
  if (trigger.trigger.type === "event" && ctx) {
    const preamble =
      `A \`${trigger.trigger.on}\` event trigger fired for project \`${project.slug}\`: ` +
      `chat \`${ctx.sessionId}\` was just archived.\n\n`;
    return preamble + body;
  }
  return body;
}

/**
 * Run one fire of a trigger as a first-class chat on the hub — the ONE fire path for
 * every trigger type (Epic T), replacing the separate schedule + hook fire paths with
 * a single `startAgentTurn` call. Whether the fired turn runs on the trigger's OWN
 * scoped `trigger-<slug>-<name>` agent (tool config = `run.tools`) or on the keeper is
 * decided by {@link triggerRunsOnOwnAgent}: an EVENT trigger always runs scoped; a
 * SCHEDULE trigger runs scoped ONLY when it declares a non-empty `run.tools` allow-list
 * (T2 — #307), otherwise it runs as the keeper with the project-agent default toolset
 * (pre-T2 behaviour, unchanged). `run.maxSpawnDepth` gates this fire's self-MCP spawn
 * capability regardless of which agent runs it.
 *
 * `run.session` drives new-vs-accrete: `"new"` → a FRESH chat every fire
 * (`resume: null`); `"resume"` → resume the trigger's ONE owned session (recorded on
 * first fire in the {@link TriggerSessionStore}, rebound after a restart) so a
 * "manager" accretes a single transcript. A stale owned id (its transcript deleted)
 * is forgotten so the next fire re-creates one. FIRE-AND-FORGET: a rejection (the
 * turn never produced a session id — its own failure frame already emitted) is
 * swallowed so a transient failure never wedges the trigger. Resolves the
 * created/resumed session id, or `null`.
 */
async function fireTriggerForProject(
  project: Awaited<ReturnType<typeof deps.projects.get>>,
  trigger: TriggerDto,
  ctx?: TriggerEventContext,
): Promise<string | null> {
  const slug = project.slug;
  const isSchedule = trigger.trigger.type === "schedule";
  // T2: a scoped trigger (every event; a schedule with a `run.tools` allow-list) runs
  // on its OWN `trigger-<slug>-<name>` agent so herdctl enforces its capability; an
  // unscoped schedule runs as the keeper (project-agent default toolset, unchanged).
  const onOwnAgent = triggerRunsOnOwnAgent(trigger);
  const agentName = onOwnAgent ? triggerAgentName(slug, trigger.name) : keeperAgentName(slug);
  const prompt = await resolveTriggerPrompt(project, trigger, ctx);

  // run.session: "resume" accretes into an owned session; "new" starts fresh.
  let resume: string | null = null;
  if (trigger.run.session === "resume" && deps.triggerSessions) {
    const owned = await deps.triggerSessions.get(slug, trigger.name).catch(() => undefined);
    if (owned && (await deps.herdctl.sessionExists(project, owned).catch(() => false))) {
      resume = owned;
    } else if (owned) {
      await deps.triggerSessions.clear(slug, trigger.name).catch(() => undefined);
    }
  }

  try {
    const sessionId = await startAgentTurn({
      projectSlug: slug,
      agentName,
      workingDir: project.workingDir,
      resume,
      prompt,
      driveMode: resolveDriveMode(project),
      fallbackModel: trigger.run.model ?? project.model,
      // Provenance (A1/#261): a schedule fire is a root `scheduled` trigger; an event
      // trigger reuses the `hook` origin (its E1 badge surface) — both depth 0.
      origin: isSchedule ? "scheduled" : "hook",
      depth: 0,
      // A per-trigger `run.maxSpawnDepth` (design §2.3, T2) gates this fire's self-MCP
      // spawn capability; it wins over the project override, which wins over the
      // instance default (reuses B1's resolver).
      maxSpawnDepth: resolveMaxSpawnDepth(
        trigger.run.maxSpawnDepth ?? project.maxSpawnDepth,
        deps.cfg.maxSpawnDepth,
      ),
      // Attribute the injected kickoff turn to the trigger that fired it (#290).
      sender: {
        kind: isSchedule ? "schedule" : "hook",
        name: trigger.name,
        project: slug,
      },
    });
    // First fire of an accreting trigger: remember the chat it created so the next
    // fire resumes THIS transcript (a resume already had an id).
    if (trigger.run.session === "resume" && !resume && deps.triggerSessions) {
      await deps.triggerSessions.set(slug, trigger.name, sessionId).catch(() => undefined);
    }
    return sessionId;
  } catch {
    return null;
  }
}

/**
 * Resolve a project's ENABLED event triggers for `event` and fire each (after-commit,
 * non-blocking — after-commit, non-blocking). Concurrent +
 * independent; one trigger's failure never affects another. No-op when the trigger
 * system isn't wired ({@link makeChatHandler} dep `triggers` absent) or the project
 * has no matching enabled event trigger.
 */
async function dispatchEventTriggers(
  slug: string,
  event: TriggerEvent,
  ctx: TriggerEventContext,
): Promise<void> {
  if (!deps.triggers) return;
  const project = await deps.projects.get(slug).catch(() => null);
  if (!project) return;
  const matching = await deps.triggers.enabledForEvent(slug, event).catch(() => []);
  await Promise.all(matching.map((trigger) => fireTriggerForProject(project, trigger, ctx)));
}

// Dispatch enabled EVENT triggers on the SAME lifecycle events hooks fire on — the
// event-bus supports multiple listeners, so this rides alongside the hook dispatcher
// (they read disjoint config blocks). onArchive is the wired event; afterTurn is
// reserved for the sweeper fold-in (T5) and not emitted yet.
deps.events?.on("onArchive", (payload) => {
  void dispatchEventTriggers(payload.slug, "onArchive", { sessionId: payload.sessionId });
});

/**
 * Signal a completed turn's post-turn CURATION (Epic T / T5) — the sweeper, folded in
 * as the default `curate-overview` (event/afterTurn) trigger. Emits the `afterTurn`
 * lifecycle event so the curator dispatches EXACTLY ONCE per turn (its enabled gate +
 * per-project prompt extension resolved inside SweepService). Scratch never curates.
 * Falls back to a direct `sweep.enqueue` when the event bus isn't wired (older
 * callers / tests), so behaviour is identical with or without the bus. Called from
 * every post-turn commit site (a human chat turn, a session-mode wake, and every
 * server-initiated `startAgentTurn`) — the ONE place the sweeper is now triggered.
 */
function emitAfterTurn(slug: string, sessionId: string | null): void {
  if (slug === SCRATCH_SLUG) return;
  if (deps.events) deps.events.emit("afterTurn", { slug, sessionId });
  else deps.sweep?.enqueue(slug);
}

// The folded-in sweeper (T5): `afterTurn` drives the default post-turn curator. Unlike
// `onArchive`, afterTurn is NOT fanned out to generic `trigger-<slug>-<name>` agents —
// the curator is tool-less and executed by SweepService (returns marked text, Paddock
// writes OVERVIEW.md/CHANGELOG.md). So this is the SOLE afterTurn consumer, which is
// what guarantees the sweeper runs exactly once per turn (no double-curation).
deps.events?.on("afterTurn", (payload) => {
  if (payload.slug === SCRATCH_SLUG) return;
  deps.sweep?.enqueue(payload.slug);
});

/**
 * Fire a TRIGGER now (Epic T / T1), reused by the "Run now" REST route + `run_trigger`
 * self-MCP verb (#327) and shared with the cron path below. Resolves the live project +
 * its trigger record and fires via {@link fireTriggerForProject} — through the SAME hub
 * path a cron/event fire uses, so a manual run is indistinguishable from an automatic
 * one. Fires ANY trigger type on demand (a schedule, an event trigger, or a reserved
 * webhook trigger you want to smoke-test before its ingress lands) regardless of its
 * `enabled` flag — a manual run is a deliberate act (mirrors the schedule DD-1 rule).
 * Returns the started chat's session id, or `null` if the project/trigger is gone or
 * the turn never produced a session.
 */
async function fireTrigger(slug: string, triggerName: string): Promise<string | null> {
  const project = await deps.projects.get(slug).catch(() => null);
  if (!project) return null;
  const rec = project.triggers?.[triggerName];
  if (!rec) return null;
  // The post-turn CURATOR (any `event`/`afterTurn` trigger — the folded-in sweeper, T5)
  // is NOT fireable on the generic path: it registers no scoped `trigger-<slug>-<name>`
  // agent and runs via SweepService on `afterTurn`. Refuse rather than firing a turn on
  // a non-existent agent (defence-in-depth — the REST route + run_trigger MCP reject it
  // up front with a clear message; this guards any other caller).
  if (isCuratorTrigger(rec)) return null;
  return fireTriggerForProject(project, { name: triggerName, agentName: triggerAgentName(slug, triggerName), ...rec });
}

/**
 * Compose the OVERVIEW.md + CHANGELOG.md preload block onto `baseMessage` for
 * a NEW chat (issues #1/#188), shared (C2 / #264) by the human New-Chat path
 * and the self-MCP `create_chat` spawn path so both inject the SAME context.
 * Injects only when the project has an OVERVIEW.md (the signal that a sweep
 * has curated real state); when it fires it prepends BOTH the overview
 * (current state) AND the CHANGELOG.md (cross-session history), matching the
 * UI checkbox. Returns `baseMessage` unchanged when there's no overview yet.
 */
async function composePreloadedPrompt(projectSlug: string, baseMessage: string): Promise<string> {
  const overview = await deps.projects.readOverview(projectSlug).catch(() => "");
  if (overview.trim().length === 0) return baseMessage;
  const changelog = await deps.projects.readChangelog(projectSlug).catch(() => "");
  // Single-sourced wrapper (see preload.ts) so the chat-list can strip it back
  // off for display (issue #62).
  return wrapPreload(composePreloadContext(overview, changelog), baseMessage);
}
  return {
    emitAfterTurn,
    composePreloadedPrompt,
    fireTrigger,
    fireTriggerForProject,
    dispatchEventTriggers,
  };
}
