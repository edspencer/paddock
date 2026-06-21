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

/** project.yaml status enum (matches the documented standard). */
export type ProjectStatus =
  | "idea"
  | "active"
  | "paused"
  | "blocked"
  | "done"
  | "abandoned";

export type ProjectVisibility = "public" | "private";

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
  links?: ProjectLink[];
}

/** API-facing project DTO (adds derived fields). */
export interface Project extends ProjectYaml {
  /** Absolute path to the project directory (the keeper agent's cwd). */
  dir: string;
  /** Alias of `started` for callers that think in "created". */
  created: string;
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  status?: ProjectStatus;
  domain?: string[];
  visibility?: ProjectVisibility;
  summary?: string;
  links?: ProjectLink[];
}

/** Partial metadata update (slug + started are immutable). */
export type UpdateProjectInput = Partial<
  Pick<ProjectYaml, "name" | "status" | "domain" | "visibility" | "summary" | "links">
>;

const PROJECT_FILE = "project.yaml";
const CHANGELOG_FILE = "CHANGELOG.md";

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
      visibility: input.visibility ?? "public",
      started: now,
      updated: now,
      summary: input.summary ?? "",
      links: input.links ?? [],
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

    return this.toDto(dir, yaml);
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
    return this.toDto(current.dir, next);
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

  /** Read a freeform file's contents (path-traversal guarded). */
  async readFile(slug: string, name: string): Promise<string> {
    const dir = this.dirFor(slug);
    const resolved = path.resolve(dir, name);
    if (!resolved.startsWith(dir + path.sep)) {
      throw new ProjectError("Invalid file path", "invalid");
    }
    return fs.readFile(resolved, "utf8");
  }

  // --- internals ---------------------------------------------------------

  private async readSafe(slug: string): Promise<Project | null> {
    const dir = this.dirFor(slug);
    try {
      const raw = await fs.readFile(path.join(dir, PROJECT_FILE), "utf8");
      const parsed = YAML.parse(raw) as Partial<ProjectYaml> | null;
      if (!parsed || typeof parsed !== "object") return null;
      const yaml = this.normalize(parsed, slug);
      return this.toDto(dir, yaml);
    } catch {
      return null;
    }
  }

  /** Fill defaults / coerce a parsed project.yaml into a complete ProjectYaml. */
  private normalize(p: Partial<ProjectYaml>, slug: string): ProjectYaml {
    const started = p.started ?? today();
    return {
      name: p.name ?? slug,
      slug: p.slug ?? slug,
      status: (p.status as ProjectStatus) ?? "active",
      domain: Array.isArray(p.domain) ? p.domain : [],
      visibility: (p.visibility as ProjectVisibility) ?? "public",
      started,
      updated: p.updated ?? started,
      summary: p.summary ?? "",
      links: Array.isArray(p.links) ? p.links : [],
    };
  }

  private async writeYaml(slug: string, yaml: ProjectYaml): Promise<void> {
    const header =
      "# Paddock project metadata. Directory name MUST equal `slug`.\n" +
      "# status: idea | active | paused | blocked | done | abandoned\n";
    const body = YAML.stringify(yaml);
    await fs.writeFile(path.join(this.dirFor(slug), PROJECT_FILE), header + body, "utf8");
  }

  private toDto(dir: string, yaml: ProjectYaml): Project {
    return { ...yaml, dir, created: yaml.started };
  }

  private stripDto(p: Project): ProjectYaml {
    const { dir: _dir, created: _created, ...yaml } = p;
    void _dir;
    void _created;
    return yaml;
  }
}
