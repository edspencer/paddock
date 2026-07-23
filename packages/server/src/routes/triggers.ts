/**
 * Trigger routes (Epic T "Unify Triggers" / T3) — the per-project UNIFIED trigger
 * management surface the Triggers tab drives, the sole successor that collapses the
 * retired hooks + schedules REST/verbs onto ONE `TriggerService` over
 * `project.yaml`'s single `triggers` block. A trigger is WHEN (`trigger`, a
 * discriminated union `schedule|event|webhook`) + WHAT (`run`, the shared agent-run
 * definition) + `enabled`. Each route delegates to TriggerService, which persists to
 * project.yaml FIRST (the source of truth, re-armed on restart) THEN arms it,
 * warning-but-not-failing if the runtime arm hiccups.
 *
 * Verb collapse (GG-3): enable/disable is NOT a separate route — it's `set` (PUT)
 * with the `enabled` field flipped; new triggers default disabled.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { keeperAgentName } from "../herdctl.js";
import { GRANTABLE_TOOLS } from "../hook-config.js";
import { buildTriggerRuntime } from "../trigger-runtime.js";
import {
  TRIGGER_EVENTS,
  TRIGGER_TYPES,
  isValidTriggerName,
  isCuratorTrigger,
  sanitizeTrigger,
} from "../trigger-config.js";
import { sendProjectError } from "../route-errors.js";
import type { RouteCtx } from "../route-context.js";

export function registerTriggerRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { projects, herdctl, triggers, fireTrigger } = ctx;

  const triggersGuard = (reply: FastifyReply): boolean => {
    if (!triggers) {
      reply.code(503).send({ error: "Trigger management is unavailable", code: "unavailable" });
      return false;
    }
    return true;
  };

  // List a project's triggers (DTOs) + the picker catalog: the grantable tools, the
  // events an event-trigger can fire on, and the trigger types — so the Triggers tab
  // renders a precise capability + type picker without hard-coding them client-side
  // (folds in the G4 `GRANTABLE_TOOLS` list).
  app.get<{ Params: { slug: string } }>(
    "/api/projects/:slug/triggers",
    async (req, reply) => {
      if (!triggersGuard(reply)) return reply;
      try {
        const list = await triggers!.list(req.params.slug); // throws not_found
        return {
          triggers: list,
          grantableTools: GRANTABLE_TOOLS,
          events: [...TRIGGER_EVENTS],
          triggerTypes: [...TRIGGER_TYPES],
        };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Get one trigger by name (404 when the project declares no such trigger).
  app.get<{ Params: { slug: string; name: string } }>(
    "/api/projects/:slug/triggers/:name",
    async (req, reply) => {
      if (!triggersGuard(reply)) return reply;
      const { slug, name } = req.params;
      try {
        const trigger = await triggers!.get(slug, name); // throws not_found (project)
        if (!trigger) {
          return reply.code(404).send({ error: `No such trigger: ${name}`, code: "not_found" });
        }
        return { trigger };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Create or replace one trigger (keyed by name). Persists to project.yaml, then
  // arms it so it's immediately fireable. Enabling/disabling is this same route with
  // `enabled` flipped (GG-3). The body is the FULL record `{ trigger, run, enabled }`
  // — a full replace (unlike the self-MCP set_trigger, which patches partial edits).
  app.put<{ Params: { slug: string; name: string }; Body: unknown }>(
    "/api/projects/:slug/triggers/:name",
    async (req, reply) => {
      if (!triggersGuard(reply)) return reply;
      const { slug, name } = req.params;
      if (!isValidTriggerName(name)) {
        return reply.code(400).send({ error: `Invalid trigger name: ${name}`, code: "invalid" });
      }
      // Reject a malformed record early (bad discriminant, both/neither cron+interval,
      // unknown event, both/neither prompt+promptFile) so the client gets a 400
      // instead of the store's generic error; TriggerService.set re-validates.
      if (!sanitizeTrigger(req.body)) {
        return reply.code(400).send({ error: "Invalid trigger definition", code: "invalid" });
      }
      try {
        const trigger = await triggers!.set(slug, name, req.body); // throws not_found/invalid
        return { trigger };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Delete one trigger. Removes it from project.yaml AND disarms it (an event
  // trigger's agent is torn down; a schedule trigger's forwarded entry is dropped).
  app.delete<{ Params: { slug: string; name: string } }>(
    "/api/projects/:slug/triggers/:name",
    async (req, reply) => {
      if (!triggersGuard(reply)) return reply;
      const { slug, name } = req.params;
      try {
        const removed = await triggers!.remove(slug, name); // throws not_found (project)
        return reply.code(200).send({ ok: true, name, removed });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Per-trigger RUNTIME state (Epic T follow-up / #327) — the live "last-run / next-run
  // / status" the Triggers tab renders alongside each trigger's config. `TriggerDto`
  // carries config only, so this JOINS it with herdctl runtime state the tab lost when
  // the Schedules section folded in: the cron scheduler's `ScheduleInfo` (next-fire,
  // status — schedule triggers) + job records (last run, per the E3/#268 pattern) for
  // each trigger's own scoped agent. Served as its OWN endpoint (not folded into the
  // config list) so the tab can POLL it cheaply without re-fetching the config + picker
  // catalog. A static path segment — matched before `/:name` — so no trigger shadows it.
  app.get<{ Params: { slug: string } }>(
    "/api/projects/:slug/triggers/runtime",
    async (req, reply) => {
      if (!triggersGuard(reply)) return reply;
      try {
        const project = await projects.get(req.params.slug); // throws not_found
        const dtos = await triggers!.list(project.slug);
        // The agents a trigger's runs land under: the keeper (unscoped schedule
        // triggers) + every trigger's own scoped `trigger-<slug>-<name>` agent.
        const agents = [keeperAgentName(project.slug), ...dtos.map((d) => d.agentName)];
        const [runs, schedules] = await Promise.all([
          herdctl.listRunsForAgents(agents).catch(() => []),
          herdctl.listAgentSchedules(project).catch(() => []),
        ]);
        return { runtime: buildTriggerRuntime(dtos, runs, schedules, project.slug) };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Fire a trigger NOW (Epic T follow-up / #327) — "Run now". Runs it through the same
  // hub path a cron / event fire uses, so the resulting chat is a first-class, badged
  // run (indistinguishable from an automatic fire). Fires ANY trigger type regardless
  // of its `enabled` flag — a manual run is deliberate (mirrors the schedule DD-1 rule).
  // 503 when the trigger fire entrypoint isn't wired (tests may omit it); 404 for an
  // unknown trigger; 502 if the fire started no chat. Responds 202 with the session id.
  app.post<{ Params: { slug: string; name: string } }>(
    "/api/projects/:slug/triggers/:name/run",
    async (req, reply) => {
      if (!triggersGuard(reply)) return reply;
      const { slug, name } = req.params;
      if (!fireTrigger) {
        return reply.code(503).send({ error: "Trigger firing is unavailable", code: "unavailable" });
      }
      try {
        const project = await projects.get(slug); // throws not_found
        const rec = project.triggers?.[name];
        if (!rec) {
          return reply.code(404).send({ error: `No such trigger: ${name}`, code: "not_found" });
        }
        // The post-turn CURATOR (the folded-in sweeper — any `event`/`afterTurn` trigger,
        // T5) is NOT a generic fireable trigger: it has no scoped `trigger-<slug>-<name>`
        // agent (it runs via SweepService on the `afterTurn` event, needing a just-
        // completed turn's context), so the generic fire path can't run it. Reject it with
        // a clear 409 rather than letting the fire fail opaquely as a 502.
        if (isCuratorTrigger(rec)) {
          return reply.code(409).send({
            error:
              "The post-turn curator trigger runs automatically after each turn and can't be run on demand.",
            code: "not_runnable",
          });
        }
        const sessionId = await fireTrigger(slug, name);
        if (!sessionId) {
          return reply
            .code(502)
            .send({ error: "Trigger fire did not start a chat", code: "trigger_failed" });
        }
        return reply.code(202).send({ ok: true, name, sessionId });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );
}
