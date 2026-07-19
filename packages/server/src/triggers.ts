/**
 * Unified trigger CRUD/registry service (Epic T "Unify Triggers", ticket T1).
 *
 * ONE registry over the single `startAgentTurn` execution core that subsumes what
 * were two services — the Epic G `HookService` (event hooks) and the Epic D schedule
 * registration (spread across `ProjectStore` + `HerdctlService`). A trigger is
 * persisted per project (`project.yaml` `triggers` map) and armed against herdctl by
 * type:
 *
 *   - **event** trigger → its OWN herdctl agent `trigger-<slug>-<name>` (tool config
 *     = capability), fired by the in-process event bus (`onArchive` today).
 *   - **schedule** trigger → forwarded into the keeper agent's `schedules` block (the
 *     herdctl cron engine arms it), fired via `setScheduleTriggerHandler`. In T1 it
 *     executes as the keeper (full tools); per-trigger tool-scoping for schedules is
 *     T2.
 *   - **webhook** trigger → shape reserved; persisted + validated but NOT armed and
 *     never fired (the ingress is the deferred T6/#311).
 *
 * The service is the FROZEN surface T2–T5 build on (the analogue of the shipped
 * `HookService`): reads come straight off the live project record (project.yaml is the
 * source of truth, re-armed on restart); writes persist THEN arm (best-effort — a
 * transient fleet hiccup never loses the persisted definition, it's re-armed from the
 * record on the next boot / `ensureProjectAgent`).
 */
import type { ProjectStore, Project } from "./projects.js";
import type { HerdctlService } from "./herdctl.js";
import { triggerAgentName } from "./herdctl.js";
import type { PaddockTrigger, TriggerDto, TriggerEvent } from "./trigger-config.js";

/** Project a persisted {@link PaddockTrigger} + its name/slug onto the {@link TriggerDto}. */
export function toTriggerDto(slug: string, name: string, trigger: PaddockTrigger): TriggerDto {
  return { name, agentName: triggerAgentName(slug, name), ...trigger };
}

/**
 * List/get/set/remove a project's triggers — the frozen surface T2 (schedule tool
 * allow-list), T3 (REST + self-MCP verb collapse), T4 (Triggers tab) and T5 (sweeper
 * fold-in) build on. Reads come off the live project record; writes persist THEN arm
 * the trigger's herdctl agent / schedule.
 */
export class TriggerService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly herdctl: HerdctlService,
  ) {}

  /** Every trigger declared by `slug`, as DTOs (empty when the project has none). */
  async list(slug: string): Promise<TriggerDto[]> {
    const project = await this.projects.get(slug); // throws not_found
    return this.dtosOf(project);
  }

  /** One trigger by name, or `null` if the project declares no such trigger. */
  async get(slug: string, name: string): Promise<TriggerDto | null> {
    const project = await this.projects.get(slug); // throws not_found
    const trigger = project.triggers?.[name];
    return trigger ? toTriggerDto(slug, name, trigger) : null;
  }

  /**
   * The trigger whose registered agent is `agentName` (`trigger-<slug>-<name>`), or
   * `null` — the reverse-map (mirrors `HookService.getByAgentName`). Resolved by
   * matching the project's DECLARED triggers rather than by PARSING the agent string
   * (a slug may contain hyphens, so `trigger-<slug>-<name>` isn't unambiguously
   * splittable). Never throws (a missing project → `null`).
   */
  async getByAgentName(slug: string, agentName: string): Promise<TriggerDto | null> {
    const project = await this.projects.get(slug).catch(() => null);
    if (!project) return null;
    for (const [name, trigger] of Object.entries(project.triggers ?? {})) {
      if (triggerAgentName(slug, name) === agentName) return toTriggerDto(slug, name, trigger);
    }
    return null;
  }

  /**
   * Create or update a trigger: persist it to `project.yaml` (validates the name +
   * sanitises the record via the Zod schema, throwing `ProjectError` on a malformed
   * trigger), then arm it so it's immediately fireable. Returns the persisted
   * trigger's DTO. The arm is best-effort — re-armed from the record on the next
   * restart / `ensureProjectAgent` if it fails — so a transient fleet hiccup never
   * loses the persisted definition.
   */
  async set(slug: string, name: string, trigger: unknown): Promise<TriggerDto> {
    const project = await this.projects.setTrigger(slug, name, trigger);
    const rec = project.triggers?.[name];
    if (!rec) throw new Error(`trigger not persisted: ${name}`);
    await this.arm(project, name, rec).catch(() => undefined);
    return toTriggerDto(slug, name, rec);
  }

  /**
   * Remove a trigger: delete it from `project.yaml` and unregister/disarm it. Returns
   * whether a trigger actually existed (so a caller can echo `removed: false`).
   */
  async remove(slug: string, name: string): Promise<boolean> {
    const before = await this.projects.get(slug); // throws not_found
    const existed = Boolean(before.triggers?.[name]);
    const rec = before.triggers?.[name];
    const project = await this.projects.removeTrigger(slug, name);
    // Disarm: an event/webhook trigger's own agent is torn down; a schedule trigger's
    // forwarded entry is dropped by re-registering the keeper from the updated record.
    if (rec && rec.trigger.type !== "schedule") {
      await this.herdctl.removeTriggerAgent(slug, name).catch(() => undefined);
    } else if (rec) {
      await this.herdctl.ensureProjectAgent(project).catch(() => undefined);
    }
    return existed;
  }

  /**
   * The enabled EVENT triggers a project declares for `event` (the dispatcher's
   * resolver — the analogue of `HookService.enabledForEvent`). Schedule/webhook
   * triggers are never returned here (they fire on cron / an ingress, not the bus).
   */
  async enabledForEvent(slug: string, event: TriggerEvent): Promise<TriggerDto[]> {
    const project = await this.projects.get(slug).catch(() => null);
    if (!project) return [];
    return this.dtosOf(project).filter(
      (t) => t.trigger.type === "event" && t.trigger.on === event && t.enabled === true,
    );
  }

  /**
   * Arm a single trigger against herdctl (best-effort): an event trigger becomes its
   * own `trigger-<slug>-<name>` agent; a schedule trigger is (re-)forwarded into the
   * keeper's `schedules` block via a keeper re-register; a webhook trigger is reserved
   * (nothing to arm — no ingress in T1).
   */
  private async arm(project: Project, name: string, trigger: PaddockTrigger): Promise<void> {
    if (trigger.trigger.type === "event") {
      await this.herdctl.ensureTriggerAgent(project, name, trigger);
    } else if (trigger.trigger.type === "schedule") {
      // Re-register the keeper so its forwarded `schedules` block picks up the new /
      // edited schedule trigger (un-gated, unlike setAgentSchedule). Idempotent.
      await this.herdctl.ensureProjectAgent(project);
    }
    // webhook: shape reserved — nothing armed (deferred T6).
  }

  private dtosOf(project: Project): TriggerDto[] {
    return Object.entries(project.triggers ?? {}).map(([name, trigger]) =>
      toTriggerDto(project.slug, name, trigger),
    );
  }
}
