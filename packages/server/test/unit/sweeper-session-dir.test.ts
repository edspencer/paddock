/**
 * The sweeper must never share a Claude Code CLI session directory with a
 * project's keeper (issue #548).
 *
 * A CLI agent's `working_directory` is what Claude Code encodes into its
 * transcript path, so two agents with the same cwd write their transcripts into
 * ONE directory. herdctl identifies a freshly-spawned session by set-difference
 * against a pre-spawn snapshot of that directory, which is immune to a co-located
 * agent *appending* to its own session but NOT to one *creating* a new file:
 * whichever brand-new `*.jsonl` appears first is claimed as "ours". Because a
 * sweep is scheduled after every keeper turn, a shared directory meant the
 * sweeper's spawn raced the next keeper turn and could hand it the sweeper's
 * session id — the user's chat then streamed the curation reply, resumed the
 * curation transcript, and could go missing from the project's chat list.
 *
 * The regression this guards is a one-word edit (`project.dir`), so assert the
 * separation directly, for every project shape.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildKeeperConfig, buildSweeperConfig } from "../../src/herdctl-agent-config.js";
import type { PaddockConfig } from "../../src/config.js";
import type { Project } from "../../src/projects.js";

const cfg = {
  dataDir: "/data",
  projectsRoot: "/data/projects",
  nativeSystemPrompt: true,
} as PaddockConfig;

/** A notebook project: workingDir === dir (the shape that used to collide). */
const notebook = {
  slug: "demo",
  name: "Demo",
  dir: "/data/projects/demo",
  workingDir: "/data/projects/demo",
} as unknown as Project;

/** A repo-backed project: the keeper runs in the nested checkout (issue #187). */
const repoBacked = {
  slug: "repo",
  name: "Repo",
  dir: "/data/projects/repo",
  workingDir: "/data/projects/repo/checkout",
} as unknown as Project;

/** The root workspace — its key is "" and its cwd IS the projects root. */
const root = {
  slug: "",
  name: "Instance",
  dir: "/data/projects",
  workingDir: "/data/projects",
} as unknown as Project;

const cwdOf = (c: Record<string, unknown>) => c.working_directory as string;

describe("sweeper CLI-session-dir separation (#548)", () => {
  for (const project of [notebook, repoBacked, root]) {
    const label = project.slug === "" ? "<root>" : project.slug;

    it(`${label}: the sweeper's cwd is neither the keeper's cwd nor the project dir`, () => {
      const keeperCwd = cwdOf(buildKeeperConfig(cfg, project));
      const sweeperCwd = cwdOf(buildSweeperConfig(cfg, project));

      expect(sweeperCwd).not.toBe(keeperCwd);
      // `project.dir` is the old value, and for a notebook project it equals the
      // keeper's cwd — check it explicitly so the repo-backed case is covered too.
      expect(sweeperCwd).not.toBe(project.dir);
    });

    it(`${label}: the sweeper's cwd is outside projectsRoot`, () => {
      // Core's discovery unions every transcript bucket whose decoded path is a
      // strict DESCENDANT of an agent's cwd, and the root workspace's cwd is
      // projectsRoot — so a sweeper dir nested under it would be re-unioned into
      // the root keeper's listing.
      const sweeperCwd = cwdOf(buildSweeperConfig(cfg, project));
      const rel = path.relative(cfg.projectsRoot, sweeperCwd);
      expect(rel.startsWith("..")).toBe(true);
    });
  }

  it("gives each project's sweeper its own directory", () => {
    const dirs = [notebook, repoBacked, root].map((p) => cwdOf(buildSweeperConfig(cfg, p)));
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it("maps the root workspace's empty key to a non-empty directory", () => {
    // `""` is a real workspace key, not "absent" — a bare path.join would collapse
    // it into the parent dir and re-collide with every other sweeper.
    const sweeperCwd = cwdOf(buildSweeperConfig(cfg, root));
    expect(path.basename(sweeperCwd)).toBe("_root");
  });
});
