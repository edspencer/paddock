/**
 * project-types — the project layer's type surface + link normaliser.
 *
 * Extracted from projects.ts (issue #403): the on-disk `project.yaml` schema
 * ({@link ProjectYaml}), the API-facing {@link Project} DTO, the create/update
 * input shapes, the small render/listing enums, and the pure {@link normalizeLinks}
 * read-boundary coercion. These are declarations only (plus one pure function), so
 * they carry no coupling to `ProjectStore`. projects.ts re-exports everything here
 * (a barrel) so every existing `import { ... } from "./projects.js"` keeps resolving.
 */
import { type PaddockSchedule } from "./schedule-config.js";
import { type PaddockHook } from "./hook-config.js";
import { type PaddockTrigger } from "./trigger-config.js";
import { type RecoveryOverride } from "./recovery-config.js";
import { type CurationOverride } from "./curation-config.js";
import { type AttachmentsOverride } from "./attachments-config.js";

// Re-export the config types so importers reaching through projects.js (which
// re-exports this module) keep finding them in one place, as before.
export type {
  PaddockSchedule,
  PaddockHook,
  PaddockTrigger,
  RecoveryOverride,
  AttachmentsOverride,
};

/** project.yaml status enum (matches the documented standard). */
export type ProjectStatus =
  | "idea"
  | "active"
  | "paused"
  | "blocked"
  | "done"
  | "abandoned";

export type ProjectVisibility = "public" | "private";

/** Render-kind hint for a project file (drives the UI renderer choice). */
export type FileKind = "markdown" | "html" | "text" | "image";

/**
 * One entry in a project directory listing (issue #259): a name plus whether
 * it's a file or a subdirectory, so the Files tab can distinguish the two and
 * let the user descend into folders. Listed one level at a time.
 */
export interface FileEntry {
  name: string;
  kind: "file" | "dir";
}

export interface ProjectLink {
  label: string;
  url: string;
}

/**
 * Coerce a raw parsed `links` value into well-formed {label,url} objects.
 *
 * A legacy / hand-edited `project.yaml` may declare `links` as a bare YAML
 * string list (the natural shorthand — `- https://example.com`) rather than the
 * {label,url} object form. Passing those through untouched yields a `string[]`
 * DTO, which crashes the Settings pane (its `cleanedLinks` memo calls
 * `l.url.trim()` / `l.label.trim()` on what is actually a string → TypeError
 * during render). So normalize here at the read boundary: a bare string becomes
 * `{label:"", url:<string>}`, an object entry is trimmed and kept, and any entry
 * without a usable url (or of an unexpected type) is dropped. Because this runs
 * in `normalize`, the next save round-trips the file into the object form — the
 * project self-heals.
 */
export function normalizeLinks(raw: unknown): ProjectLink[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectLink[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const url = item.trim();
      if (url) out.push({ label: "", url });
    } else if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const url = typeof rec.url === "string" ? rec.url.trim() : "";
      const label = typeof rec.label === "string" ? rec.label.trim() : "";
      if (url) out.push({ label, url });
    }
  }
  return out;
}

// Scheduled-chat declaration (issue #265 / DD-2). The `PaddockSchedule` type +
// its sanitiser / herdctl-mapping / prompt-file helpers live in
// schedule-config.ts (a small, unit-testable surface); the type is re-exported
// above so existing `projects.js` importers keep finding it in one place.

/**
 * The on-disk project.yaml shape.
 *
 * Note on dates: the documented standard uses `started` + `updated`. The
 * paddock spec referred to `created`/`updated`; we treat `started` as the
 * creation date and keep `updated` as last-touched. We surface both names on
 * the API DTO for convenience but persist the standard field names.
 */
export interface ProjectYaml {
  name: string;
  slug: string;
  status: ProjectStatus;
  domain: string[];
  visibility: ProjectVisibility;
  started: string; // YYYY-MM-DD
  updated: string; // YYYY-MM-DD (maintained automatically)
  summary: string;
  /**
   * The project's "area" — its single, exclusive home (Homelab / House / Side
   * Projects). One per project (unlike the many cross-cutting `domain` tags);
   * drives the sectioned landing page. Optional on disk: an absent/empty value
   * means "Unsorted" and is rendered in its own section. Free-form so new areas
   * can be added without a schema change; the UI knows the canonical set.
   */
  group?: string;
  links?: ProjectLink[];
  /**
   * Files (relative names within the project dir) the user has pinned as
   * sibling tabs in the UI. Order-preserving, deduped. Default [].
   */
  pinned?: string[];
  /**
   * The Claude model the project's keeper agent runs on. Optional on disk: an
   * absent value resolves to KEEPER_DEFAULT_MODEL in the DTO. (CONTRACT-v3 §4.)
   */
  model?: string;
  /**
   * Per-project keeper-agent overrides (issue #12). All optional on disk — an
   * absent value inherits the fleet default and resolves to the concrete default
   * in the DTO. `permissionMode`/`maxTurns`/`docker` (Docker isolation on/off).
   */
  permissionMode?: string;
  maxTurns?: number;
  docker?: boolean;
  /**
   * How the keeper's chat turns are driven — `batch` (one-shot trigger) or
   * `session` (persistent managed openChatSession, enabling cross-turn autonomy;
   * Paddock#111). Optional on disk: absent inherits the global default
   * (`PADDOCK_KEEPER_DRIVE_MODE`, else KEEPER_DEFAULT_DRIVE_MODE).
   */
  driveMode?: string;
  /**
   * How deep a spawn tree rooted at this project's chats may grow before spawned
   * children stop receiving the self-management MCP (issue #262 / DD-3). A spawned
   * turn at depth `d` gets the self-MCP (incl. `send_message`, so a child can
   * report back) iff `d <= maxSpawnDepth`. Optional on disk: absent inherits the
   * instance default (`PADDOCK_MAX_SPAWN_DEPTH`, else DEFAULT_MAX_SPAWN_DEPTH = 1),
   * resolved at dispatch — the same inherit/override discipline as `driveMode`.
   */
  maxSpawnDepth?: number;
  /**
   * Per-project override for the hook-management MCP gate (Epic G / G5, GG-4) —
   * whether this project's turns get the `mcp__paddock_manage__{list,set,remove}_hook`
   * tools. Optional on disk: absent inherits the instance default
   * (`PADDOCK_HOOKS_MCP`, else OFF), resolved at dispatch via
   * {@link import("./hook-config.js").resolveHooksMcpEnabled} — the same
   * inherit/override discipline as `driveMode`/`maxSpawnDepth`. `true` opts this
   * project agent in; `false` opts it out even when the instance default is on.
   */
  hooksMcpEnabled?: boolean;
  /**
   * Per-project keeper-chat recovery override (issue #301). Every field optional;
   * an absent field inherits the instance default (`cfg.recovery`, itself
   * `PADDOCK_RECOVERY_*` env / YAML), resolved at dispatch via
   * {@link import("./recovery-config.js").resolveRecoveryConfig} — the same
   * inherit/override discipline as `driveMode`/`maxSpawnDepth`. Absent ⇒ this
   * project inherits every recovery default. Persisted (and re-read) through
   * {@link sanitizeRecoveryOverride} so a malformed hand-edit degrades cleanly.
   */
  recovery?: RecoveryOverride;
  /**
   * Per-project inbound-attachment override (issue #328). Every field optional;
   * an absent field inherits the instance default (`cfg.attachments`, itself
   * `PADDOCK_ATTACHMENTS_*` env / YAML), resolved at request time via
   * {@link import("./attachments-config.js").resolveAttachmentsConfig} — the same
   * inherit/override discipline as `recovery`. Absent ⇒ this project inherits
   * every attachment default. Persisted (and re-read) through
   * {@link sanitizeAttachmentsOverride} so a malformed hand-edit degrades cleanly.
   * (Surfacing this in the Settings tab is deferred to Phase 2; the resolve/
   * override plumbing exists now.)
   */
  attachments?: AttachmentsOverride;
  /**
   * Per-project sweeper-curation budget override (issue #384). Every field
   * optional; an absent field inherits the instance default (`cfg.curation`,
   * itself `PADDOCK_CURATION_*` env / YAML), resolved at sweep time via
   * {@link import("./curation-config.js").resolveCurationConfig} — the same
   * inherit/override discipline as `recovery`/`attachments`. Absent ⇒ this
   * project inherits every curation default. Persisted (and re-read) through
   * {@link sanitizeCurationOverride} so a malformed hand-edit degrades cleanly.
   */
  curation?: CurationOverride;
  /**
   * External git repo URL that backs this project (issue #187). When present the
   * project is REPO-BACKED: Paddock clones the repo into a nested `.gitignore`d
   * checkout under the project dir and the keeper's working directory is that
   * checkout (so the repo's OWN `CLAUDE.md`, git history, branches and PR flow
   * work natively). Absent ⇒ a NOTEBOOK project (the classic type: cwd = the
   * project dir in the instance data repo). Set at creation; immutable thereafter
   * (like `slug`/`started`).
   */
  repo?: string;
  /**
   * Scheduled chat sessions for this project (issue #265 / DD-2), keyed by a
   * stable schedule name. Each value is herdctl's `ScheduleSchema` shape (plus the
   * Paddock-only `promptFile`), forwarded unmolested into the keeper agent's
   * `schedules` block so herdctl arms the cron/interval directly. Absent/empty ⇒
   * the project has no schedules (unchanged behaviour).
   */
  schedules?: Record<string, PaddockSchedule>;
  /**
   * Event hooks for this project (Epic G / G1), keyed by a stable hook name. Each
   * value is a {@link PaddockHook} — a lifecycle event + a capability set + a prompt
   * (inline or `.paddock/hooks/*.md`) + `enabled`. Unlike schedules, a hook is NOT
   * forwarded into the keeper agent's config: each hook is registered as its OWN
   * herdctl agent `hook-<slug>-<name>` whose tool config IS its capability (GG-1).
   * Absent/empty ⇒ the project has no hooks (unchanged behaviour). New hooks default
   * `enabled: false` (GG-3).
   */
  hooks?: Record<string, PaddockHook>;
  /**
   * Unified triggers for this project (Epic T "Unify Triggers" / T1), keyed by a
   * stable trigger name. Each value is a {@link PaddockTrigger} — a discriminated
   * `trigger` (schedule / event / webhook) + a shared `run` (prompt, session, tools,
   * …) + `enabled`. The declarative successor collapsing the separate `schedules` +
   * `hooks` blocks (which T3/T5 retire): a SCHEDULE trigger is forwarded into the
   * keeper agent's `schedules` block; an EVENT trigger is registered as its own
   * `trigger-<slug>-<name>` agent (like a hook); a WEBHOOK trigger is shape-reserved.
   * Absent/empty ⇒ the project has no triggers. New triggers default `enabled: false`.
   */
  triggers?: Record<string, PaddockTrigger>;
}

/** API-facing project DTO (adds derived fields). */
export interface Project extends ProjectYaml {
  /** The project's area — ALWAYS concrete in the DTO (`yaml.group ?? ""`). An
   *  empty string means "Unsorted". */
  group: string;
  /**
   * Absolute path to the project's METADATA directory — the per-slug dir in the
   * instance data repo that holds `project.yaml`, `OVERVIEW.md`, `CHANGELOG.md`,
   * `.chats/`, and (for a notebook project) `CLAUDE.md`. For a NOTEBOOK project
   * this is also the keeper's cwd; for a REPO-BACKED project the cwd is
   * {@link workingDir} (the nested checkout) instead — see #187.
   */
  dir: string;
  /**
   * The keeper agent's working directory (cwd). For a notebook project this
   * equals {@link dir}; for a repo-backed project it's the nested checkout
   * (`<dir>/<repo-name>`), so the repo's own `CLAUDE.md` + git tooling apply
   * (issue #187). Always concrete in the DTO.
   */
  workingDir: string;
  /** Whether this project is backed by an external git repo (issue #187). */
  repoBacked: boolean;
  /** Alias of `started` for callers that think in "created". */
  created: string;
  /** Whether OVERVIEW.md exists in the project dir (sweep-curated context). */
  hasOverview: boolean;
  /** Always present in the DTO (defaults to []). */
  pinned: string[];
  /**
   * The keeper agent's model — ALWAYS concrete in the DTO (`yaml.model ??
   * KEEPER_DEFAULT_MODEL`), even though it's optional on disk.
   */
  model: string;
  /** Keeper permission mode — ALWAYS concrete in the DTO (issue #12). */
  permissionMode: string;
  /** Keeper max_turns — ALWAYS concrete in the DTO (issue #12). */
  maxTurns: number;
  /** Whether the keeper runs in a Docker sandbox — ALWAYS concrete (issue #12). */
  docker: boolean;
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  status?: ProjectStatus;
  domain?: string[];
  group?: string;
  visibility?: ProjectVisibility;
  summary?: string;
  links?: ProjectLink[];
  /**
   * External git repo URL to back this project (issue #187). When set, the
   * project is created as REPO-BACKED: the repo is cloned into a nested
   * `.gitignore`d checkout and the keeper's cwd becomes that checkout. Absent ⇒
   * a notebook project (the classic type).
   */
  repo?: string;
}

/** Partial metadata update (slug + started are immutable). */
export type UpdateProjectInput = Partial<
  Pick<
    ProjectYaml,
    | "name"
    | "status"
    | "domain"
    | "group"
    | "visibility"
    | "summary"
    | "links"
    | "model"
    | "permissionMode"
    | "maxTurns"
    | "docker"
  >
> & {
  /**
   * Keeper drive mode (Paddock#111). A string sets a per-project override;
   * `null` CLEARS the override so the project inherits the box-wide global
   * default again (issue #122's reset-to-inherit); `undefined`/absent leaves the
   * current value untouched.
   */
  driveMode?: string | null;
  /**
   * Max spawn depth (issue #262). A number sets a per-project override; `null`
   * CLEARS it so the project inherits the instance default again; `undefined`/
   * absent leaves the current value untouched. Same tri-state as `driveMode`.
   */
  maxSpawnDepth?: number | null;
  /**
   * Hook-management MCP override (Epic G / G5). A boolean sets a per-project
   * override; `null` CLEARS it so the project inherits the instance default again;
   * `undefined`/absent leaves the current value untouched. Same tri-state as
   * `driveMode`/`maxSpawnDepth`.
   */
  hooksMcpEnabled?: boolean | null;
  /**
   * Keeper-chat recovery override (issue #301). A {@link RecoveryOverride} object
   * REPLACES the per-project override; `null` CLEARS it so the project inherits
   * every instance default again; `undefined`/absent leaves the current value
   * untouched. Same tri-state as `driveMode`/`maxSpawnDepth` (the whole override
   * object is the unit — sanitised on write).
   */
  recovery?: RecoveryOverride | null;
  /**
   * Inbound-attachment override (issue #328). An {@link AttachmentsOverride}
   * object REPLACES the per-project override; `null` CLEARS it so the project
   * inherits every instance default again; `undefined`/absent leaves it
   * untouched. Same tri-state as `recovery` (the whole override object is the
   * unit — sanitised on write). Wired now for the Phase 2 Settings surface.
   */
  attachments?: AttachmentsOverride | null;
  /**
   * Sweeper-curation budget override (issue #384). A {@link CurationOverride}
   * object REPLACES the per-project override; `null` CLEARS it so the project
   * inherits every instance default again; `undefined`/absent leaves it
   * untouched. Same tri-state as `recovery`/`attachments`, sanitised on write.
   */
  curation?: CurationOverride | null;
};
