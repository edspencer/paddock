/**
 * Hook CRUD service (Epic G, ticket G1 — hook foundation).
 *
 * The server-side module BOTH the future Hooks tab (G4) and the hook-management MCP
 * (G5) consume, so neither re-implements the "persist to project.yaml + register the
 * hook agent" two-step. It is the hook analogue of the schedule CRUD (which lives on
 * `ProjectStore` + `HerdctlService`), lifted into one small orchestration surface
 * because the design calls it out as the shared foundation those tickets build on.
 *
 * Layering (each piece independently testable):
 *   - {@link import("./hook-config.js").sanitizeHook} et al. — pure validation +
 *     capability→agent-config projection (`hook-config.ts`).
 *   - `ProjectStore.setHook`/`removeHook` — persistence to `project.yaml` (source of
 *     truth, re-armed on restart).
 *   - `HerdctlService.ensureHookAgent`/`removeHookAgent` — the live-arming half (the
 *     `hook-<slug>-<name>` agent).
 *   - THIS service composes them into {@link HookService.set}/{@link HookService.remove}
 *     and exposes read helpers ({@link HookService.list}/{@link HookService.get}).
 *
 * The persist-then-arm order mirrors the shipped schedule CRUD: project.yaml is the
 * source of truth (so a restart re-arms), and the runtime arm is best-effort —
 * re-registered from the record on the next boot / `ensureProjectAgent` if it hiccups.
 */
import type { ProjectStore, Project } from "./projects.js";
import type { HerdctlService } from "./herdctl.js";
import { hookAgentName } from "./herdctl.js";
import type { HookDto, PaddockHook } from "./hook-config.js";

/** Project a persisted {@link PaddockHook} + its name/slug onto the CRUD {@link HookDto}. */
export function toHookDto(slug: string, name: string, hook: PaddockHook): HookDto {
  return { name, agentName: hookAgentName(slug, name), ...hook };
}

/**
 * List/get/set/remove a project's event hooks — the frozen surface G4 (Hooks tab) and
 * G5 (hook MCP) build on. Reads come straight off the live project record (project.yaml
 * is the source of truth); writes persist THEN arm the hook's agent.
 */
export class HookService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly herdctl: HerdctlService,
  ) {}

  /** Every hook declared by `slug`, as DTOs (empty when the project has none). */
  async list(slug: string): Promise<HookDto[]> {
    const project = await this.projects.get(slug); // throws not_found
    return this.dtosOf(project);
  }

  /** One hook by name, or `null` if the project declares no such hook. */
  async get(slug: string, name: string): Promise<HookDto | null> {
    const project = await this.projects.get(slug); // throws not_found
    const hook = project.hooks?.[name];
    return hook ? toHookDto(slug, name, hook) : null;
  }

  /**
   * The hook whose registered agent is `agentName` (`hook-<slug>-<name>`), or `null`
   * — the G3 visibility reverse-map (GG-5/GG-6). Resolved by matching the project's
   * DECLARED hooks rather than by PARSING the agent string: a slug may contain
   * hyphens, so `hook-<slug>-<name>` isn't unambiguously splittable, and the design
   * (GG-1) is explicit that the reverse mapping is done against declared hooks. Used
   * to attach a hook chat's truthful-from-config capability descriptor to its chat
   * DTO (the capability banner) and never throws (a missing project → `null`).
   */
  async getByAgentName(slug: string, agentName: string): Promise<HookDto | null> {
    const project = await this.projects.get(slug).catch(() => null);
    if (!project) return null;
    for (const [name, hook] of Object.entries(project.hooks ?? {})) {
      if (hookAgentName(slug, name) === agentName) return toHookDto(slug, name, hook);
    }
    return null;
  }

  /**
   * Create or update a hook: persist it to `project.yaml` (validates the name +
   * sanitises the record, throwing `ProjectError` on a malformed hook), then register
   * (replace) its `hook-<slug>-<name>` agent so it's immediately fireable. Returns the
   * persisted hook's DTO. The runtime arm is best-effort — re-armed from the record on
   * the next restart / `ensureProjectAgent` if it fails — so a transient fleet hiccup
   * never loses the persisted definition.
   */
  async set(slug: string, name: string, hook: unknown): Promise<HookDto> {
    const project = await this.projects.setHook(slug, name, hook);
    const rec = project.hooks?.[name];
    if (!rec) throw new Error(`hook not persisted: ${name}`);
    await this.herdctl.ensureHookAgent(project, name, rec).catch(() => undefined);
    return toHookDto(slug, name, rec);
  }

  /**
   * Remove a hook: delete it from `project.yaml` and unregister its agent. Returns
   * whether a hook actually existed (so a caller can echo `removed: false`).
   */
  async remove(slug: string, name: string): Promise<boolean> {
    const before = await this.projects.get(slug); // throws not_found
    const existed = Boolean(before.hooks?.[name]);
    await this.projects.removeHook(slug, name);
    await this.herdctl.removeHookAgent(slug, name).catch(() => undefined);
    return existed;
  }

  /** The enabled hooks a project declares for `event` (the dispatcher's resolver). */
  async enabledForEvent(slug: string, event: PaddockHook["event"]): Promise<HookDto[]> {
    const project = await this.projects.get(slug).catch(() => null);
    if (!project) return [];
    return this.dtosOf(project).filter((h) => h.event === event && h.enabled === true);
  }

  private dtosOf(project: Project): HookDto[] {
    return Object.entries(project.hooks ?? {}).map(([name, hook]) =>
      toHookDto(project.slug, name, hook),
    );
  }
}
