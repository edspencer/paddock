/**
 * #955 wiring: the memory dir each keeper is registered with at BOOT.
 *
 * A notebook project inside a git projects root keys its memory on the ROOT
 * workspace's transcript link, and the root is registered last. Resolving each
 * project's memory dir in the same pass that plants its own link therefore read
 * the root's link before it existed (a fresh `host` boot: the literal,
 * symlinked path — #955 unfixed) or before it was re-pointed (the boot after a
 * `host` → `own` flip: the user's real `~/.claude`, under `own`). Found by the
 * adversarial review of #972; `registerProjects` now plants every link first.
 *
 * Drives a real HerdctlService against a fake fleet that records `addAgent`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { HerdctlService, keeperAgentName } from "../../src/herdctl.js";
import { encodeProjectDir, ensureProjectChats } from "../../src/transcripts.js";
import type { PaddockConfig } from "../../src/config.js";
import type { Project } from "../../src/projects.js";
import type { TranscriptsMode } from "../../src/transcripts.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
beforeEach(async () => {
  tmp = await makeTmpDir("paddock-memboot-");
});
afterEach(async () => {
  await rmTmpDir(tmp);
});

function layout() {
  const projectsRoot = path.join(tmp, "projects");
  return {
    projectsRoot,
    claudeHome: path.join(tmp, "data", "claude-home"),
    userHome: path.join(tmp, "home", ".claude"),
    // Registered in app.ts order: children first, the root workspace LAST.
    projects: [
      { slug: "nb", name: "nb", dir: path.join(projectsRoot, "nb"), workingDir: path.join(projectsRoot, "nb") },
      { slug: "", name: "Home", dir: projectsRoot, workingDir: projectsRoot },
    ] as unknown as Project[],
  };
}

async function boot(transcripts: TranscriptsMode) {
  const l = layout();
  const cfg = {
    claudeHome: l.claudeHome,
    legacyClaudeHome: l.userHome,
    claude: { transcripts },
    dataDir: path.join(tmp, "data"),
    nativeSystemPrompt: true,
    browserMcp: false,
  } as unknown as PaddockConfig;
  const added: Array<Record<string, unknown>> = [];
  const svc = new HerdctlService(cfg);
  (svc as unknown as { fleet: unknown }).fleet = {
    addAgent: vi.fn(async (c: Record<string, unknown>) => {
      added.push(c);
    }),
  };
  await svc.registerProjects(l.projects);
  const memoryOf = (slug: string) =>
    (added.filter((c) => c.name === keeperAgentName(slug)).at(-1)?.settings as
      | { autoMemoryDirectory?: string }
      | undefined)?.autoMemoryDirectory;
  return { ...l, memoryOf };
}

async function makeNotesRepo() {
  const { projectsRoot } = layout();
  await fs.mkdir(path.join(projectsRoot, "nb"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: projectsRoot, stdio: "ignore" });
}

describe("boot registration resolves memory dirs after every link is planted (#955)", () => {
  it("a fresh host boot gives the notebook child the root's REAL memory dir", async () => {
    await makeNotesRepo();
    const b = await boot("host");
    const expected = path.join(b.userHome, "projects", encodeProjectDir(b.projectsRoot), "memory");
    expect(b.memoryOf("nb")).toBe(expected);
    expect(b.memoryOf("")).toBe(expected);
  });

  it("the boot after a host -> own flip follows the re-pointed link, not ~/.claude", async () => {
    await makeNotesRepo();
    const l = layout();
    // The previous boot, under host, planted the root's link into the user's home.
    await fs.mkdir(l.userHome, { recursive: true });
    for (const p of l.projects) {
      await ensureProjectChats(p.workingDir, p.dir, {
        path: l.claudeHome,
        transcripts: "host",
        userHome: l.userHome,
      });
    }

    const b = await boot("own");
    const expected = path.join(b.projectsRoot, ".chats", "memory");
    expect(b.memoryOf("nb")).toBe(expected);
    expect(b.memoryOf("")).toBe(expected);
  });
});
