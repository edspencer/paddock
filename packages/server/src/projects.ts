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
}

/** API-facing project DTO (adds derived fields). */
export interface Project extends ProjectYaml {
  /** The project's area — ALWAYS concrete in the DTO (`yaml.group ?? ""`). An
   *  empty string means "Unsorted". */
  group: string;
  /** Absolute path to the project directory (the keeper agent's cwd). */
  dir: string;
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
    | "driveMode"
  >
>;

const PROJECT_FILE = "project.yaml";
const CHANGELOG_FILE = "CHANGELOG.md";
const OVERVIEW_FILE = "OVERVIEW.md";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "exists" | "invalid",
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
    };

    const dir = this.dirFor(slug);
    await fs.mkdir(dir, { recursive: true });
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

    // No OVERVIEW.md at creation — the first sweep writes it.
    return this.toDto(dir, yaml, false);
  }

  /** Update mutable metadata fields and bump `updated`. */
  async update(slug: string, patch: UpdateProjectInput): Promise<Project> {
    const current = await this.get(slug);
    const next: ProjectYaml = {
      ...this.stripDto(current),
      ...patch,
      slug: current.slug, // immutable
      started: current.started, // immutable
      updated: today(),
    };
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

  /** Whether OVERVIEW.md exists for this project. */
  async overviewExists(slug: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.dirFor(slug), OVERVIEW_FILE));
      return true;
    } catch {
      return false;
    }
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

  /** Append a dated bullet to the project's CHANGELOG.md (under today's heading). */
  async appendChangelog(slug: string, line: string): Promise<void> {
    const dir = this.dirFor(slug);
    const file = path.join(dir, CHANGELOG_FILE);
    let body = "";
    try {
      body = await fs.readFile(file, "utf8");
    } catch {
      body = `# Changelog — ${slug}\n`;
    }
    const heading = `## ${today()}`;
    const entry = `- ${line}`;
    if (body.includes(heading)) {
      // Insert under the existing dated heading.
      body = body.replace(heading, `${heading}\n${entry}`);
    } else {
      // Prepend a new dated section after the title block.
      const lines = body.split("\n");
      const insertAt = lines.findIndex((l) => l.startsWith("## "));
      const section = ["", heading, entry, ""];
      if (insertAt === -1) {
        body = `${body.trimEnd()}\n${section.join("\n")}\n`;
      } else {
        lines.splice(insertAt, 0, ...section);
        body = lines.join("\n");
      }
    }
    await fs.writeFile(file, body, "utf8");
  }

  /** List freeform files (non-dotfiles) inside a project directory. */
  async listFiles(slug: string): Promise<string[]> {
    const dir = this.dirFor(slug);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  }

  /**
   * Resolve a freeform file name to an absolute path inside the project dir,
   * rejecting path traversal. The single guard shared by every file read.
   */
  private resolveInProject(slug: string, name: string): string {
    const dir = this.dirFor(slug);
    const resolved = path.resolve(dir, name);
    if (!resolved.startsWith(dir + path.sep)) {
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
      links: Array.isArray(p.links) ? p.links : [],
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
    };
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
      dir,
      created: yaml.started,
      hasOverview,
    };
  }

  private stripDto(p: Project): ProjectYaml {
    const { dir: _dir, created: _created, hasOverview: _hasOverview, group, ...rest } = p;
    void _dir;
    void _created;
    void _hasOverview;
    // Keep an empty area off the yaml so it isn't persisted as `group: ""`.
    return group?.trim() ? { ...rest, group } : rest;
  }
}
