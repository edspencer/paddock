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
    {
      schema: {
        tags: ["Triggers"],
        summary: "List a project's triggers plus the picker catalog",
        description:
          "Returns the project's trigger DTOs together with the Triggers-tab picker catalog. " +
          "Success (200) is an object with `triggers` (array of trigger DTOs, each combining the " +
          "`trigger` when-clause, the `run` definition, `enabled`, and derived fields like `agentName`), " +
          "`grantableTools` (the tools an event/webhook trigger may be granted), `events` (the lifecycle " +
          "events an event trigger can fire on), and `triggerTypes` (the supported trigger kinds).",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
        response: {
          200: {
            description:
              "The trigger DTO list plus picker catalog (`triggers`, `grantableTools`, `events`, `triggerTypes`).",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
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
    {
      schema: {
        tags: ["Triggers"],
        summary: "Get one trigger by name",
        description:
          "Fetches a single trigger's config by name. Success (200) is an object with a `trigger` field " +
          "holding the trigger DTO (`trigger` when-clause + `run` + `enabled` + derived fields). Returns 404 " +
          "when the project declares no trigger with that name.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            name: { type: "string", description: "Trigger name." },
          },
          required: ["slug", "name"],
        },
        response: {
          200: {
            description: "An object with a `trigger` field holding the trigger DTO.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
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
    {
      schema: {
        tags: ["Triggers"],
        summary: "Create or replace one trigger",
        description:
          "Creates or fully replaces a trigger keyed by name, persisting it to project.yaml then arming it. " +
          "Enabling/disabling is this same route with `enabled` flipped. The body is the FULL trigger record: " +
          "`trigger` is the WHEN clause — a discriminated union on `trigger.type` (`schedule` with `cron` xor " +
          "`interval`; `event` with an `on` value such as `onArchive`/`afterTurn`; `webhook` with a `path`, " +
          "shape-reserved) — `run` is the shared agent-run definition (prompt/promptFile, model, tools, etc.), " +
          "and `enabled` is the on/off flag. Success (200) is an object with a `trigger` field holding the " +
          "persisted trigger DTO. Returns 400 for an invalid name or malformed trigger definition.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            name: { type: "string", description: "Trigger name." },
          },
          required: ["slug", "name"],
        },
        body: {
          // Documentation-only (no validation/coercion): accept any/empty body.
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            trigger: {
              description:
                "The WHEN clause: a discriminated union on `trigger.type` (`schedule`/`event`/`webhook`) with type-specific fields.",
            },
            run: {
              description:
                "The WHAT clause: the shared agent-run definition (prompt/promptFile, model, tools, session mode, etc.).",
            },
            enabled: { description: "Whether the trigger is armed; new triggers default disabled." },
          },
        },
        response: {
          200: {
            description: "An object with a `trigger` field holding the persisted trigger DTO.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
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
    {
      schema: {
        tags: ["Triggers"],
        summary: "Delete one trigger",
        description:
          "Removes a trigger from project.yaml AND disarms it (an event trigger's agent is torn down; a " +
          "schedule trigger's forwarded entry is dropped). Success (200) is an object with `ok: true`, the " +
          "`name`, and `removed` describing what was removed.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            name: { type: "string", description: "Trigger name." },
          },
          required: ["slug", "name"],
        },
        response: {
          200: {
            description: "An object with `ok`, `name`, and `removed`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
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
    {
      schema: {
        tags: ["Triggers"],
        summary: "Live runtime state for a project's triggers",
        description:
          "Per-trigger live last-run / next-run / status, joining each trigger's config with herdctl runtime " +
          "state (the cron scheduler's next-fire + status for schedule triggers, plus job records for last run). " +
          "This is a static path segment, matched BEFORE `/:name`, so no trigger name shadows it. It is served " +
          "as its own pollable endpoint (separate from the config list). Success (200) is an object with a " +
          "`runtime` field describing each trigger's live state.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
        response: {
          200: {
            description: "An object with a `runtime` field describing each trigger's live last-run/next-run/status.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
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
    {
      schema: {
        tags: ["Triggers"],
        summary: "Run a trigger now",
        description:
          "Fires a trigger immediately (\"Run now\") through the same hub path a cron/event fire uses, producing " +
          "a first-class badged run. Fires any trigger type regardless of its `enabled` flag. Success is 202 with " +
          "an object containing `ok: true`, the `name`, and the started `sessionId`. Returns 503 when firing is " +
          "unavailable, 404 for an unknown trigger, 409 for the post-turn curator trigger (not runnable on demand), " +
          "and 502 if the fire started no chat.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            name: { type: "string", description: "Trigger name." },
          },
          required: ["slug", "name"],
        },
        response: {
          202: {
            description: "An object with `ok`, `name`, and the started `sessionId`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
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
