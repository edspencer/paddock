/**
 * ProjectStore — the project layer.
 *
 * A "project" is a directory under `projectsRoot` containing:
 *   - project.yaml   (metadata; schema below)
 *   - CHANGELOG.md   (reverse-chron, curator-appended + hand-edited)
 *   - freeform .md / files
 *
 * This mirrors the documented standard at ~/herds/personal/projects/
 * (see _template/ and README.md there). The directory name == slug.
 *
 * The slug-as-directory IS the link to Claude Code sessions: Claude stores
 * transcripts under ~/.claude/projects/<cwd-with-slashes-as-dashes>/, so the
 * keeper agent's working_directory (= the project dir) ties sessions to the
 * project with no extra tagging.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  KEEPER_DEFAULT_MODEL,
  KEEPER_DEFAULT_PERMISSION_MODE,
  KEEPER_DEFAULT_MAX_TURNS,
  KEEPER_DEFAULT_DOCKER,
} from "./models.js";
import { cloneRepo } from "./git.js";
import {
  sanitizeSchedules,
  type PaddockSchedule,
} from "./schedule-config.js";
import {
  sanitizeHooks,
  type PaddockHook,
} from "./hook-config.js";
import {
  sanitizeTrigger,
  sanitizeTriggers,
  isValidTriggerName,
  type PaddockTrigger,
} from "./trigger-config.js";
import { sanitizeRecoveryOverride, type RecoveryOverride } from "./recovery-config.js";
import { sanitizeCurationOverride, type CurationOverride } from "./curation-config.js";
import { sanitizeAttachmentsOverride, type AttachmentsOverride } from "./attachments-config.js";

export type { PaddockSchedule };
export type { PaddockHook };
export type { PaddockTrigger };
export type { RecoveryOverride };
export type { AttachmentsOverride };

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

/**
 * Image extensions → their MIME type, for the render kind + the raw byte
 * endpoint's Content-Type (issue #61). SVG is included but is served with a
 * locked-down CSP by the byte route (it can carry scripts).
 */
export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

/**
 * Video extensions → their MIME type, for the raw byte endpoint's Content-Type
 * (issue #126). Kept SEPARATE from IMAGE_MIME so the image file-kind classifier
 * (`fileKind`) is untouched — video only affects the content-type served, which
 * (together with HTTP range support) is what lets a `<video>` play, incl. iOS.
 */
export const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
};

/**
 * Non-image document extensions → their MIME type. Kept SEPARATE from
 * `IMAGE_MIME` on purpose: the file-kind classifier (`fileKind`) treats every
 * `IMAGE_MIME` entry as `kind: "image"`, so a `.pdf` must not live there. It's
 * used only for the byte endpoint's Content-Type (a PDF must serve as
 * `application/pdf`, not the octet-stream the attachment store rewrites to
 * `text/plain`).
 */
export const DOCUMENT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
};

/** Derive a render kind from a file name's extension. */
export function fileKind(name: string): FileKind {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext in IMAGE_MIME) return "image";
  return "text";
}

/** The MIME type for a file name's extension, defaulting to octet-stream. */
export function contentTypeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return (
    IMAGE_MIME[ext] ?? VIDEO_MIME[ext] ?? DOCUMENT_MIME[ext] ?? "application/octet-stream"
  );
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
// from this module (see the top-of-file import) so existing `projects.js`
// importers keep finding it in one place.

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

const PROJECT_FILE = "project.yaml";
const CHANGELOG_FILE = "CHANGELOG.md";
const OVERVIEW_FILE = "OVERVIEW.md";
const CLAUDE_FILE = "CLAUDE.md";

/** Heading under which the sweeper appends newly-discovered durable facts. */
const CLAUDE_CURATED_HEADING = "## Curated notes";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Accepted repo-URL shapes for a repo-backed project (issue #187): https(s),
 * ssh (`git@host:owner/repo`), git://, and a local `file://` or absolute path
 * (the last two make deterministic tests possible without a network). Anything
 * else is rejected up front so a bad value never reaches `git clone`.
 */
const REPO_URL_RE =
  /^(?:https?:\/\/|git:\/\/|ssh:\/\/|file:\/\/|\/|git@[^\s]+:).+/i;

/** Validate a candidate repo URL (issue #187). */
export function isValidRepoUrl(url: string): boolean {
  const u = url.trim();
  return u.length > 0 && u.length <= 512 && REPO_URL_RE.test(u);
}

/**
 * Derive the checkout directory NAME for a repo-backed project from its repo URL
 * (issue #187) — the repo's own basename, sans a trailing `.git`, sanitised to a
 * filesystem-safe token. The keeper's cwd becomes `<projectDir>/<thisName>`, so
 * the cwd basename reads like the repo (e.g. `paddock`). Deterministic (same URL
 * ⇒ same name), which is why `repo` is immutable once set.
 */
export function repoCheckoutName(repo: string): string {
  const cleaned = repo
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const base = cleaned.split(/[/:]/).pop() ?? "";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return safe || "repo";
}

/**
 * Resolve a project's working directory (keeper cwd) from its metadata dir + repo
 * URL: the nested checkout for a repo-backed project, else the metadata dir
 * itself for a notebook project (issue #187).
 */
export function workingDirFor(dir: string, repo?: string): string {
  return repo ? path.join(dir, repoCheckoutName(repo)) : dir;
}

/** Filename of the sidecar `.gitignore` that keeps a nested checkout out of the data repo. */
const GITIGNORE_FILE = ".gitignore";

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "exists" | "invalid" | "not_directory",
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Minimal seed for a per-project CLAUDE.md (issue #177): the durable-identity
 * layer of the two-level native-context model (instance-wide + per-project
 * CLAUDE.md, loaded natively once #176 lands). Deliberately terse — the sweeper
 * amends it conservatively over time under "Curated notes"; everything a human
 * writes is preserved. OVERVIEW.md holds current state, CHANGELOG.md holds
 * history; this file holds only what the project durably IS and how we work on it.
 */
function claudeTemplate(name: string, summary: string): string {
  return [
    `# ${name}`,
    "",
    summary?.trim() || "<!-- One-line description of what this project is. -->",
    "",
    "<!--",
    "Durable project identity & conventions — what this project fundamentally is,",
    "key long-lived facts, and how we work on it. Changes rarely. Current state",
    "lives in OVERVIEW.md; per-turn history lives in CHANGELOG.md. Content you",
    "write here is preserved; the curator only APPENDS newly-discovered durable",
    'facts under the "Curated notes" heading below.',
    "-->",
    "",
  ].join("\n");
}

export class ProjectStore {
  constructor(private readonly root: string) {}

  /** Ensure the projects root exists. Call once at startup. */
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  private dirFor(slug: string): string {
    return path.join(this.root, slug);
  }

  /** List all projects, newest-updated first. Skips `_`-prefixed dirs. */
  async list(): Promise<Project[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const projects: Project[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const p = await this.readSafe(e.name);
      if (p) projects.push(p);
    }
    projects.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
    return projects;
  }

  /** Get one project by slug. Throws ProjectError("not_found") if missing. */
  async get(slug: string): Promise<Project> {
    const p = await this.readSafe(slug);
    if (!p) throw new ProjectError(`Project not found: ${slug}`, "not_found");
    return p;
  }

  async exists(slug: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.dirFor(slug), PROJECT_FILE));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a project: mkdir + write project.yaml (from template) + seed
   * CHANGELOG.md. Idempotency: throws ProjectError("exists") if the slug
   * directory already holds a project.yaml.
   */
  async create(input: CreateProjectInput): Promise<Project> {
    const name = input.name?.trim();
    if (!name) throw new ProjectError("Project name is required", "invalid");

    const slug = (input.slug?.trim() || slugify(name)) as string;
    if (!SLUG_RE.test(slug)) {
      throw new ProjectError(
        `Invalid slug "${slug}" (must be kebab-case: a-z, 0-9, hyphens)`,
        "invalid",
      );
    }
    if (await this.exists(slug)) {
      throw new ProjectError(`Project already exists: ${slug}`, "exists");
    }

    // Repo-backed project (issue #187): validate the URL up front so a bad value
    // never reaches `git clone` and the project isn't half-created.
    const repo = input.repo?.trim() || undefined;
    if (repo && !isValidRepoUrl(repo)) {
      throw new ProjectError(`Invalid repo URL: ${repo}`, "invalid");
    }

    const now = today();
    const yaml: ProjectYaml = {
      name,
      slug,
      status: input.status ?? "active",
      domain: input.domain ?? [],
      // Keep `group` off the yaml when empty so unsorted projects round-trip
      // without a noisy `group: ""` line (mirrors the optional `model` handling).
      ...(input.group?.trim() ? { group: input.group.trim().toLowerCase() } : {}),
      visibility: input.visibility ?? "public",
      started: now,
      updated: now,
      summary: input.summary ?? "",
      links: input.links ?? [],
      pinned: [],
      // Carry `repo` only when repo-backed (same round-trip discipline as model).
      ...(repo ? { repo } : {}),
    };

    const dir = this.dirFor(slug);
    await fs.mkdir(dir, { recursive: true });

    // For a repo-backed project, clone the external repo into the nested checkout
    // BEFORE writing any metadata, so a clone failure rolls the whole thing back
    // (rm the freshly-made dir) rather than leaving a broken project.yaml behind.
    if (repo) {
      const checkoutName = repoCheckoutName(repo);
      const checkoutDir = path.join(dir, checkoutName);
      try {
        await cloneRepo(repo, checkoutDir);
      } catch (err) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw new ProjectError(
          err instanceof Error ? err.message : `Failed to clone ${repo}`,
          "invalid",
        );
      }
      // Keep the nested checkout (a full git repo) OUT of the instance data repo:
      // a sidecar `.gitignore` ignores the checkout dir (git-in-git per #187's
      // option A). `.chats/` (our transcript store) is likewise data-repo noise.
      await this.ensureSidecarGitignore(dir, checkoutName);
    }

    await this.writeYaml(slug, yaml);
    await fs.writeFile(
      path.join(dir, CHANGELOG_FILE),
      [
        `# Changelog — ${name}`,
        "",
        "<!--",
        "Reverse-chronological. Newest entry on top, under a `## YYYY-MM-DD` heading.",
        "-->",
        "",
        `## ${now}`,
        "- Project opened.",
        "",
      ].join("\n"),
      "utf8",
    );

    // Seed a minimal per-project CLAUDE.md (issue #177) — but ONLY for a NOTEBOOK
    // project. A repo-backed project defers to the repo's OWN CLAUDE.md (loaded
    // natively via the cwd walk-up from the checkout); the sweeper must never
    // touch that upstream-owned file, so we don't seed a competing one (#187).
    if (!repo) {
      await fs.writeFile(
        path.join(dir, CLAUDE_FILE),
        claudeTemplate(name, yaml.summary),
        "utf8",
      );
    }

    // No OVERVIEW.md at creation — the first sweep writes it.
    return this.toDto(dir, yaml, false);
  }

  /**
   * Promote an existing NOTEBOOK project into a REPO-BACKED one IN PLACE (issue
   * #213), preserving its chats + sidecar metadata. This relaxes #187's create-time
   * `repo` immutability on this ONE path: an existing project (a subdir of the data
   * repo) gains an external git repo as its keeper's working directory.
   *
   * What it does (mirrors `create()`'s repo-backed branch, but non-destructively):
   *   1. Clone the repo into the nested checkout `<dir>/<repo-name>/` — FIRST, so a
   *      clone failure rolls back (rm just the checkout) and leaves the notebook
   *      wholly intact (project.yaml, `.chats/`, OVERVIEW/CHANGELOG untouched).
   *   2. Write the sidecar `.gitignore` (`/<repo-name>/` + `/.chats/`) so the
   *      checkout + transcript store stay out of the data repo.
   *   3. Set `repo:` in project.yaml → the DTO flips to repo-backed and the keeper's
   *      cwd becomes the checkout ({@link workingDirFor}).
   *   4. Drop the sweeper-owned per-project `CLAUDE.md`: a repo-backed project defers
   *      to the repo's OWN `CLAUDE.md` (loaded natively from the checkout). Leaving
   *      the notebook's would leak into the checkout's cwd walk-up (the metadata dir
   *      is an ancestor of the nested checkout) — so it's removed (it survives in the
   *      data repo's git history).
   *
   * The existing chats need NO transcript surgery: they already live in `<dir>/.chats/`;
   * the caller's {@link import("./herdctl.js").HerdctlService.ensureProjectAgent} re-runs
   * `ensureProjectChats(newWorkingDir, dir)` which re-symlinks the new cwd's encoded
   * transcript path at that same `.chats/` store, so every chat stays listed + resumable
   * (issue #213 open-question #1, resolved: Claude Code tolerates recorded-cwd ≠ process-cwd).
   *
   * Guards: throws `ProjectError("invalid")` for a not-yet-notebook (already
   * repo-backed) project or a bad URL, and `ProjectError("exists")` if a
   * `<repo-name>/` directory is already present (never clobber existing files).
   */
  async promote(slug: string, repoUrl: string): Promise<Project> {
    const current = await this.get(slug); // throws not_found
    if (current.repoBacked) {
      throw new ProjectError(`Project is already repo-backed: ${slug}`, "invalid");
    }
    const repo = repoUrl?.trim();
    if (!repo || !isValidRepoUrl(repo)) {
      throw new ProjectError(`Invalid repo URL: ${repoUrl}`, "invalid");
    }
    const dir = current.dir;
    const checkoutName = repoCheckoutName(repo);
    const checkoutDir = path.join(dir, checkoutName);

    // Never clobber an existing dir of that name (e.g. a stray checkout or a real
    // subdirectory of the notebook) — refuse before cloning.
    if (
      await fs
        .access(checkoutDir)
        .then(() => true)
        .catch(() => false)
    ) {
      throw new ProjectError(
        `A "${checkoutName}" directory already exists in ${slug}; refusing to overwrite`,
        "exists",
      );
    }

    // Clone FIRST so a failure rolls back to a clean notebook (rm the checkout only,
    // never the project dir + its chats). Mirrors create()'s rollback discipline.
    try {
      await cloneRepo(repo, checkoutDir);
    } catch (err) {
      await fs.rm(checkoutDir, { recursive: true, force: true }).catch(() => undefined);
      throw new ProjectError(
        err instanceof Error ? err.message : `Failed to clone ${repo}`,
        "invalid",
      );
    }

    // `writeYaml` is the atomic COMMIT point: until it succeeds the notebook is
    // byte-identical to before (only the checkout dir exists), so a failure here
    // rolls back by removing JUST the checkout — nothing else has been mutated.
    // We deliberately DON'T touch the sidecar `.gitignore` or the notebook's
    // CLAUDE.md until after the commit, so a rare `writeYaml` failure can't leave a
    // botched promote's notebook altered (e.g. a `.gitignore` that now ignores
    // `/.chats/`). (Warren #370.)
    const next: ProjectYaml = {
      ...this.stripDto(current),
      repo,
      updated: today(),
    };
    try {
      await this.writeYaml(slug, next);
    } catch (err) {
      await fs.rm(checkoutDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }

    // Post-commit finalization — the project is now validly repo-backed; these
    // steps must NOT roll the promotion back (they only tidy up), so they're
    // best-effort: keep the nested checkout + transcript store out of the data repo,
    // and drop the notebook's sweeper-owned CLAUDE.md so the repo's OWN one applies
    // (it survives in the data-repo history). A failure here leaves a valid
    // repo-backed project, matching create()'s own non-transactional finalization.
    await this.ensureSidecarGitignore(dir, checkoutName).catch(() => undefined);
    await fs.rm(path.join(dir, CLAUDE_FILE), { force: true }).catch(() => undefined);
    return this.toDto(dir, next, await this.overviewExists(slug));
  }

  /** Update mutable metadata fields and bump `updated`. */
  async update(slug: string, patch: UpdateProjectInput): Promise<Project> {
    const current = await this.get(slug);
    // driveMode + maxSpawnDepth are tri-state (set / clear / leave), so they're
    // applied explicitly below rather than via the blanket spread — a plain spread
    // can't express "delete this field", which is how an override is cleared back
    // to inherit.
    const {
      driveMode: driveModePatch,
      maxSpawnDepth: maxSpawnDepthPatch,
      hooksMcpEnabled: hooksMcpPatch,
      recovery: recoveryPatch,
      attachments: attachmentsPatch,
      curation: curationPatch,
      ...rest
    } = patch;
    const next: ProjectYaml = {
      ...this.stripDto(current),
      ...rest,
      slug: current.slug, // immutable
      started: current.started, // immutable
      updated: today(),
    };
    if (driveModePatch === null) {
      // Clear the per-project override -> inherit the global default (issue #122).
      delete next.driveMode;
    } else if (driveModePatch !== undefined) {
      next.driveMode = driveModePatch;
    }
    if (maxSpawnDepthPatch === null) {
      // Clear the per-project override -> inherit the instance default (#262).
      delete next.maxSpawnDepth;
    } else if (maxSpawnDepthPatch !== undefined) {
      next.maxSpawnDepth = maxSpawnDepthPatch;
    }
    if (hooksMcpPatch === null) {
      // Clear the per-project override -> inherit the instance default (G5).
      delete next.hooksMcpEnabled;
    } else if (hooksMcpPatch !== undefined) {
      next.hooksMcpEnabled = hooksMcpPatch;
    }
    if (recoveryPatch === null) {
      // Clear the per-project override -> inherit every instance default (#301).
      delete next.recovery;
    } else if (recoveryPatch !== undefined) {
      // Sanitise the incoming override; an all-invalid object clears it (undefined).
      const clean = sanitizeRecoveryOverride(recoveryPatch);
      if (clean) next.recovery = clean;
      else delete next.recovery;
    }
    if (attachmentsPatch === null) {
      // Clear the per-project override -> inherit every instance default (#328).
      delete next.attachments;
    } else if (attachmentsPatch !== undefined) {
      const clean = sanitizeAttachmentsOverride(attachmentsPatch);
      if (clean) next.attachments = clean;
      else delete next.attachments;
    }
    if (curationPatch === null) {
      // Clear the per-project override -> inherit every instance default (#384).
      delete next.curation;
    } else if (curationPatch !== undefined) {
      // Sanitise the incoming override; an all-invalid object clears it (undefined).
      const clean = sanitizeCurationOverride(curationPatch);
      if (clean) next.curation = clean;
      else delete next.curation;
    }
    await this.writeYaml(slug, next);
    return this.toDto(current.dir, next, await this.overviewExists(slug));
  }

  // --- overview (sweep-curated current state) ----------------------------

  /** Read OVERVIEW.md, or "" if it doesn't exist yet. */
  async readOverview(slug: string): Promise<string> {
    try {
      return await fs.readFile(path.join(this.dirFor(slug), OVERVIEW_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  /** Replace OVERVIEW.md wholesale (the sweep regenerates it each time). */
  async writeOverview(slug: string, content: string): Promise<void> {
    await fs.writeFile(path.join(this.dirFor(slug), OVERVIEW_FILE), content, "utf8");
  }

  /** Read CHANGELOG.md, or "" if it doesn't exist yet (issue #188). */
  async readChangelog(slug: string): Promise<string> {
    try {
      return await fs.readFile(path.join(this.dirFor(slug), CHANGELOG_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  /** Whether OVERVIEW.md exists for this project. */
  async overviewExists(slug: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.dirFor(slug), OVERVIEW_FILE));
      return true;
    } catch {
      return false;
    }
  }

  // --- CLAUDE.md (durable identity & conventions, sweep-amended) ----------

  /** Read CLAUDE.md, or "" if it doesn't exist yet (issue #177). */
  async readClaudeMd(slug: string): Promise<string> {
    try {
      return await fs.readFile(path.join(this.dirFor(slug), CLAUDE_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  /**
   * Replace the CLAUDE.md "Curated notes" section wholesale with a sweeper-
   * curated body (issue #379), preserving ALL human-authored content above the
   * managed heading. This supersedes the old amend-only `appendClaudeMd`, which
   * blind-appended and could never dedup — the sweeper only ever saw the first
   * 2000 chars of the file, so it re-added "known" facts believing they were new.
   * The sweeper now sees the full file and returns the ENTIRE curated-notes body,
   * dedup'd/pruned to fit its budget. Everything up to and including the
   * `## Curated notes` heading is kept verbatim; only the body below is rewritten.
   * The file/heading is seeded if absent (older projects predating #177). A blank
   * body is a no-op — the caller passes content only when there's something to
   * write (NOCHANGE means "leave the file untouched", not "empty it").
   */
  async writeClaudeCurated(slug: string, curatedBody: string): Promise<void> {
    const trimmed = curatedBody.trim();
    if (!trimmed) return;
    const dir = this.dirFor(slug);
    const file = path.join(dir, CLAUDE_FILE);
    let body: string;
    try {
      body = await fs.readFile(file, "utf8");
    } catch {
      body = claudeTemplate(slug, "");
    }
    const idx = body.indexOf(CLAUDE_CURATED_HEADING);
    const head =
      idx === -1
        ? `${body.trimEnd()}\n\n${CLAUDE_CURATED_HEADING}`
        : body.slice(0, idx + CLAUDE_CURATED_HEADING.length);
    await fs.writeFile(file, `${head.trimEnd()}\n\n${trimmed}\n`, "utf8");
  }

  // --- pins (sibling-tab files) ------------------------------------------

  /**
   * Pin a file: validate it exists in the project dir, dedupe, persist in
   * project.yaml. Returns the updated project. Throws ProjectError("invalid")
   * if the file doesn't exist or escapes the project dir.
   */
  async pinFile(slug: string, file: string): Promise<Project> {
    const current = await this.get(slug);
    const name = file?.trim();
    if (!name) throw new ProjectError("File name is required", "invalid");
    // Reuse readFile's traversal guard + existence check (throws if missing).
    await this.readFile(slug, name).catch(() => {
      throw new ProjectError(`File not found: ${name}`, "invalid");
    });
    const pinned = current.pinned.includes(name)
      ? current.pinned
      : [...current.pinned, name];
    const next: ProjectYaml = { ...this.stripDto(current), pinned, updated: today() };
    await this.writeYaml(slug, next);
    return this.toDto(current.dir, next, await this.overviewExists(slug));
  }

  /** Unpin a file (no-op if not pinned). Returns the updated project. */
  async unpinFile(slug: string, file: string): Promise<Project> {
    const current = await this.get(slug);
    const pinned = current.pinned.filter((f) => f !== file);
    const next: ProjectYaml = { ...this.stripDto(current), pinned, updated: today() };
    await this.writeYaml(slug, next);
    return this.toDto(current.dir, next, await this.overviewExists(slug));
  }

  /**
   * Add or replace one unified trigger in `project.yaml`, keyed by name (Epic T /
   * T1) — the persistence half of a trigger mutation (the caller arms it against
   * herdctl separately via `TriggerService`/`HerdctlService`). The record is validated
   * + normalised by the Zod schema ({@link sanitizeTrigger}); an invalid name or record
   * throws `ProjectError("invalid")`. Returns the updated project DTO.
   */
  async setTrigger(slug: string, name: string, trigger: unknown): Promise<Project> {
    const current = await this.get(slug);
    if (!isValidTriggerName(name)) {
      throw new ProjectError(`Invalid trigger name: ${name}`, "invalid");
    }
    const clean = sanitizeTrigger(trigger);
    if (!clean) throw new ProjectError("Invalid trigger definition", "invalid");
    const triggers = { ...(current.triggers ?? {}), [name]: clean };
    const next: ProjectYaml = { ...this.stripDto(current), triggers, updated: today() };
    await this.writeYaml(slug, next);
    return this.toDto(current.dir, next, await this.overviewExists(slug));
  }

  /**
   * Remove a trigger from `project.yaml` (no-op if absent). Returns the updated
   * project DTO. The caller disarms the trigger's agent / schedule via `TriggerService`.
   *
   */
  async removeTrigger(slug: string, name: string): Promise<Project> {
    const current = await this.get(slug);
    const rest = { ...(current.triggers ?? {}) };
    delete rest[name];
    const stripped = this.stripDto(current);
    if (Object.keys(rest).length > 0) stripped.triggers = rest;
    else delete stripped.triggers;
    const next: ProjectYaml = { ...stripped, updated: today() };
    await this.writeYaml(slug, next);
    return this.toDto(current.dir, next, await this.overviewExists(slug));
  }

  /**
   * Delete a project directory and everything in it (project.yaml, CHANGELOG.md,
   * and any files the keeper agent created). Throws ProjectError("not_found")
   * if the slug has no project.yaml, so callers can return a clean 404.
   *
   * Note: this removes the project DIRECTORY only. The caller (server) is
   * responsible for dropping the generated keeper-agent yaml + regenerating
   * herdctl.yaml + reloading the fleet — the inverse of the create flow.
   */
  async remove(slug: string): Promise<Project> {
    const project = await this.get(slug); // throws not_found
    const dir = this.dirFor(slug);
    // Guard against deleting the projects root itself if a bad slug slipped in.
    const resolved = path.resolve(dir);
    if (resolved === path.resolve(this.root) || !resolved.startsWith(path.resolve(this.root) + path.sep)) {
      throw new ProjectError("Refusing to delete outside the projects root", "invalid");
    }
    await fs.rm(dir, { recursive: true, force: true });
    return project;
  }

  /**
   * Replace CHANGELOG.md wholesale with a sweeper-curated body (issue #379). The
   * sweeper now returns the FULL changelog — adding a dated entry for genuinely-
   * new activity, coalescing duplicates, and dropping/summarizing the oldest to
   * stay under its token budget — instead of one blind-appended bullet. That's
   * what stops the file (and the per-chat preload that injects it) growing without
   * bound. The `# Changelog — <slug>` title is owned by Paddock and re-asserted
   * here so the model never has to reproduce it; if the model included its own
   * top-level heading we drop it to avoid a duplicate title. A blank body is a
   * no-op (guards against wiping the file on a malformed reply).
   */
  async writeChangelog(slug: string, body: string): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed) return;
    const file = path.join(this.dirFor(slug), CHANGELOG_FILE);
    const title = `# Changelog — ${slug}`;
    // Drop a leading top-level heading the model may have emitted, so the
    // Paddock-owned title isn't duplicated.
    const withoutTitle = /^#\s/.test(trimmed) ? trimmed.replace(/^#[^\n]*\n+/, "") : trimmed;
    await fs.writeFile(file, `${title}\n\n${withoutTitle.trim()}\n`, "utf8");
  }

  /**
   * List one level of a project directory (issue #259). `subpath` is a
   * project-relative directory ("" = the project root); the returned entries
   * carry a `kind` so the UI can distinguish (and descend into) subdirectories.
   * Dotfiles are hidden as before; entries sort directories-first, then by name.
   *
   * Traversal is guarded by the shared `resolveInProject`, so `subpath` can't
   * escape the project dir. Throws `ProjectError("not_found")` when the directory
   * doesn't exist and `ProjectError("not_directory")` when `subpath` is a file —
   * the latter lets the caller fall back to rendering that file.
   */
  async listFiles(slug: string, subpath = ""): Promise<FileEntry[]> {
    const target = this.resolveInProject(slug, subpath);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new ProjectError(`Directory not found: ${subpath}`, "not_found");
      if (code === "ENOTDIR") throw new ProjectError(`Not a directory: ${subpath}`, "not_directory");
      throw err;
    }
    return entries
      .filter((e) => !e.name.startsWith("."))
      .map((e): FileEntry => ({ name: e.name, kind: e.isDirectory() ? "dir" : "file" }))
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
      );
  }

  /**
   * Resolve a freeform file name to an absolute path inside the project dir,
   * rejecting path traversal. The single guard shared by every file read (and by
   * the directory listing, issue #259). The project root itself (`name === ""`)
   * resolves to the project dir and is allowed, so a root listing passes through.
   */
  private resolveInProject(slug: string, name: string): string {
    const dir = this.dirFor(slug);
    const resolved = path.resolve(dir, name);
    if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
      throw new ProjectError("Invalid file path", "invalid");
    }
    return resolved;
  }

  /** Read a freeform file's contents as UTF-8 text (path-traversal guarded). */
  async readFile(slug: string, name: string): Promise<string> {
    return fs.readFile(this.resolveInProject(slug, name), "utf8");
  }

  /**
   * Read a file's raw bytes + its MIME type (issue #61), for the binary/image
   * endpoint. Path-traversal guarded; throws ProjectError("not_found") if the
   * file is missing so the route can 404 cleanly. NOT decoded as text, so binary
   * (image) bytes survive intact.
   */
  async readFileBytes(slug: string, name: string): Promise<{ bytes: Buffer; mime: string }> {
    const resolved = this.resolveInProject(slug, name);
    try {
      const bytes = await fs.readFile(resolved);
      return { bytes, mime: contentTypeFor(name) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProjectError(`File not found: ${name}`, "not_found");
      }
      throw err;
    }
  }

  /**
   * Read a file plus a render-kind hint derived from its extension, for the
   * UI's markdown/Mermaid + sandboxed-iframe renderers (issue #3) and the image
   * viewer (issue #61).
   *
   * For an IMAGE the raw bytes are NOT returned here (decoding binary as UTF-8
   * would mangle it): `content` is empty and the client fetches the bytes from
   * the raw endpoint. We still stat the file so a missing image 404s. Path-
   * traversal guarded; throws ProjectError("not_found") when missing.
   */
  async readFileWithKind(
    slug: string,
    name: string,
  ): Promise<{ name: string; kind: FileKind; content: string }> {
    const kind = fileKind(name);
    if (kind === "image") {
      // Existence check only — the bytes go over the raw endpoint.
      try {
        await fs.stat(this.resolveInProject(slug, name));
      } catch (err) {
        if (err instanceof ProjectError) throw err;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ProjectError(`File not found: ${name}`, "not_found");
        }
        throw err;
      }
      return { name, kind, content: "" };
    }

    let content: string;
    try {
      content = await this.readFile(slug, name);
    } catch (err) {
      if (err instanceof ProjectError) throw err; // traversal -> "invalid"
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProjectError(`File not found: ${name}`, "not_found");
      }
      throw err;
    }
    return { name, kind, content };
  }

  // --- internals ---------------------------------------------------------

  private async readSafe(slug: string): Promise<Project | null> {
    const dir = this.dirFor(slug);
    let yaml: ProjectYaml;
    try {
      const raw = await fs.readFile(path.join(dir, PROJECT_FILE), "utf8");
      const parsed = YAML.parse(raw) as Partial<ProjectYaml> | null;
      if (!parsed || typeof parsed !== "object") return null;
      yaml = this.normalize(parsed, slug);
    } catch {
      return null;
    }
    // overviewExists is a cheap fs.access; do it after the yaml parse succeeds.
    const hasOverview = await this.overviewExists(slug);
    return this.toDto(dir, yaml, hasOverview);
  }

  /** Fill defaults / coerce a parsed project.yaml into a complete ProjectYaml. */
  private normalize(p: Partial<ProjectYaml>, slug: string): ProjectYaml {
    const started = p.started ?? today();
    return {
      name: p.name ?? slug,
      slug: p.slug ?? slug,
      status: (p.status as ProjectStatus) ?? "active",
      domain: Array.isArray(p.domain) ? p.domain : [],
      // Carry `group` through only when it's a non-empty string (an absent area
      // stays absent on disk — same round-trip discipline as `model`).
      ...(typeof p.group === "string" && p.group.trim()
        ? { group: p.group.trim().toLowerCase() }
        : {}),
      visibility: (p.visibility as ProjectVisibility) ?? "public",
      started,
      updated: p.updated ?? started,
      summary: p.summary ?? "",
      // Coerce to well-formed {label,url} objects — a legacy/hand-edited file may
      // carry a bare string list, which otherwise crashes the Settings pane.
      links: normalizeLinks(p.links),
      pinned: Array.isArray(p.pinned)
        ? p.pinned.filter((f): f is string => typeof f === "string")
        : [],
      // Carry model through only when present on disk; the DTO resolves the
      // default (an absent model stays absent in the yaml so existing files
      // without `model` still round-trip unchanged).
      ...(typeof p.model === "string" ? { model: p.model } : {}),
      // Keeper-agent overrides (issue #12): same round-trip discipline as model
      // — carried only when present so files without them are unchanged.
      ...(typeof p.permissionMode === "string" ? { permissionMode: p.permissionMode } : {}),
      ...(typeof p.maxTurns === "number" ? { maxTurns: p.maxTurns } : {}),
      ...(typeof p.docker === "boolean" ? { docker: p.docker } : {}),
      // driveMode (Paddock#111): carried only when explicitly set — an absent
      // value means "inherit the global default" and is resolved at dispatch
      // (`project.driveMode ?? cfg.keeperDriveMode`), NOT here, so the env-level
      // global can still take effect for projects that don't override it.
      ...(typeof p.driveMode === "string" ? { driveMode: p.driveMode } : {}),
      // maxSpawnDepth (issue #262): carried only when explicitly set — an absent
      // value means "inherit the instance default" and is resolved at dispatch
      // (`resolveMaxSpawnDepth(project.maxSpawnDepth, cfg.maxSpawnDepth)`), NOT
      // here, so the instance default still applies to non-overriding projects.
      ...(typeof p.maxSpawnDepth === "number" ? { maxSpawnDepth: p.maxSpawnDepth } : {}),
      // hooksMcpEnabled (Epic G / G5): carried only when explicitly set — an absent
      // value means "inherit the instance default" and is resolved at dispatch
      // (`resolveHooksMcpEnabled(project.hooksMcpEnabled, cfg.hooksMcpEnabled)`), NOT
      // here, so the instance default still applies to non-overriding projects.
      ...(typeof p.hooksMcpEnabled === "boolean" ? { hooksMcpEnabled: p.hooksMcpEnabled } : {}),
      // recovery (issue #301): carried only when at least one valid field survives
      // sanitization — an absent/all-invalid override stays absent so files without
      // it round-trip unchanged, and each field is resolved at dispatch
      // (`resolveRecoveryConfig(project.recovery, cfg.recovery)`), NOT here.
      ...(() => {
        const r = sanitizeRecoveryOverride(p.recovery);
        return r ? { recovery: r } : {};
      })(),
      // curation (issue #384): carried only when at least one valid field survives
      // sanitization — an absent/all-invalid override stays absent so files without
      // it round-trip unchanged, and each field is resolved at sweep time
      // (`resolveCurationConfig(project.curation, cfg.curation)`), NOT here.
      ...(() => {
        const c = sanitizeCurationOverride(p.curation);
        return c ? { curation: c } : {};
      })(),
      // repo (issue #187): carried only when present — its presence is what marks
      // the project repo-backed and drives the workingDir resolution in toDto.
      ...(typeof p.repo === "string" && p.repo.trim() ? { repo: p.repo.trim() } : {}),
      // schedules (issue #265): carried only when at least one well-formed entry
      // survives sanitization — an absent/empty map stays absent on disk, so files
      // without schedules round-trip unchanged. A malformed entry is dropped (not
      // thrown) so a bad hand-edit can't brick the project's keeper registration.
      ...(() => {
        const s = sanitizeSchedules(p.schedules);
        return s && Object.keys(s).length > 0 ? { schedules: s } : {};
      })(),
      // hooks (Epic G / G1): same discipline as schedules — carried only when at
      // least one well-formed entry survives sanitization, so hook-less files
      // round-trip byte-identically and a malformed hand-edit is dropped (not thrown)
      // rather than bricking the project's agent registration.
      ...(() => {
        const h = sanitizeHooks(p.hooks);
        return h && Object.keys(h).length > 0 ? { hooks: h } : {};
      })(),
      // triggers (Epic T / T1): same discipline as schedules/hooks — carried only
      // when at least one well-formed entry survives Zod validation, so trigger-less
      // files round-trip byte-identically and a malformed hand-edit is dropped (not
      // thrown) rather than bricking the project's agent registration.
      ...(() => {
        const t = sanitizeTriggers(p.triggers);
        return t && Object.keys(t).length > 0 ? { triggers: t } : {};
      })(),
    };
  }

  /**
   * Ensure the project dir's sidecar `.gitignore` ignores the nested repo-backed
   * checkout (`/<checkoutName>/`) and the transcript store (`/.chats/`), so neither
   * is tracked by the instance data repo (issue #187 option A). Idempotent and
   * merge-aware: an existing `.gitignore` (rare for a notebook, but possible) keeps
   * its lines and only the missing entries are appended — used by both `create()`
   * and the in-place `promote()` (#213).
   */
  private async ensureSidecarGitignore(dir: string, checkoutName: string): Promise<void> {
    const file = path.join(dir, GITIGNORE_FILE);
    let existing = "";
    try {
      existing = await fs.readFile(file, "utf8");
    } catch {
      /* no .gitignore yet — write a fresh one below */
    }
    const want = [`/${checkoutName}/`, `/.chats/`];
    const have = new Set(existing.split("\n").map((l) => l.trim()));
    const missing = want.filter((l) => !have.has(l));
    if (existing && missing.length === 0) return; // already covers everything
    if (!existing) {
      await fs.writeFile(
        file,
        [
          `# Repo-backed project checkout (issue #187) — not tracked by the data repo.`,
          ...want,
          "",
        ].join("\n"),
        "utf8",
      );
      return;
    }
    // Append only the missing lines to the existing file (preserve user content).
    const body = existing.endsWith("\n") ? existing : `${existing}\n`;
    await fs.writeFile(file, `${body}${missing.join("\n")}\n`, "utf8");
  }

  private async writeYaml(slug: string, yaml: ProjectYaml): Promise<void> {
    const header =
      "# Paddock project metadata. Directory name MUST equal `slug`.\n" +
      "# status: idea | active | paused | blocked | done | abandoned\n";
    const body = YAML.stringify(yaml);
    await fs.writeFile(path.join(this.dirFor(slug), PROJECT_FILE), header + body, "utf8");
  }

  private toDto(dir: string, yaml: ProjectYaml, hasOverview: boolean): Project {
    return {
      ...yaml,
      // Always concrete in the DTO; "" means Unsorted.
      group: yaml.group ?? "",
      pinned: yaml.pinned ?? [],
      // Always concrete in the DTO: an absent on-disk model resolves to the
      // keeper default (CONTRACT-v3 §4).
      model: yaml.model ?? KEEPER_DEFAULT_MODEL,
      // Keeper-agent overrides — always concrete in the DTO (issue #12).
      permissionMode: yaml.permissionMode ?? KEEPER_DEFAULT_PERMISSION_MODE,
      maxTurns: yaml.maxTurns ?? KEEPER_DEFAULT_MAX_TURNS,
      docker: yaml.docker ?? KEEPER_DEFAULT_DOCKER,
      // Recovery override stays RAW (per-project only — resolved against the
      // instance default at dispatch, never baked concrete here; the `driveMode`
      // discipline), but re-sanitised so a corrupt hand-edit never reaches the
      // web. Absent ⇒ omitted (undefined), so the project inherits every default.
      recovery: sanitizeRecoveryOverride(yaml.recovery),
      // Attachment override stays RAW (per-project only — resolved against the
      // instance default at request time, never baked concrete here), re-sanitised
      // so a corrupt hand-edit never reaches the web. Absent ⇒ omitted (#328).
      attachments: sanitizeAttachmentsOverride(yaml.attachments),
      // Curation-budget override stays RAW (per-project only — resolved against
      // the instance default at sweep time, never baked concrete here), re-
      // sanitised so a corrupt hand-edit never reaches the web. Absent ⇒ omitted (#384).
      curation: sanitizeCurationOverride(yaml.curation),
      dir,
      // Repo-backed (#187): the keeper's cwd is the nested checkout; a notebook's
      // cwd is the metadata dir itself. `repoBacked` is the presence of `repo`.
      workingDir: workingDirFor(dir, yaml.repo),
      repoBacked: Boolean(yaml.repo),
      created: yaml.started,
      hasOverview,
    };
  }

  private stripDto(p: Project): ProjectYaml {
    const {
      dir: _dir,
      workingDir: _workingDir,
      repoBacked: _repoBacked,
      created: _created,
      hasOverview: _hasOverview,
      group,
      ...rest
    } = p;
    void _dir;
    void _workingDir;
    void _repoBacked;
    void _created;
    void _hasOverview;
    // Keep an empty area off the yaml so it isn't persisted as `group: ""`.
    return group?.trim() ? { ...rest, group } : rest;
  }
}
