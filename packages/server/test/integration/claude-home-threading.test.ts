import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";
import { encodeProjectDir } from "../../src/transcripts.js";

/**
 * Regression for #588 gotcha 1: paddock and the ENGINE must resolve ONE Claude
 * home.
 *
 * The home resolver honoured an operator override, but `HerdctlService.init`
 * constructed the FleetManager without passing it — so the engine fell back to
 * `os.homedir()/.claude`. Detection would then scan one home while discovery and
 * message reads used another: chats LIST but open EMPTY. The bug is invisible
 * whenever the configured home IS `$HOME/.claude`, which is what every other
 * suite gets (`startTestApp` clears the override and the default lands in the
 * data dir). This suite is therefore the only place that can see it: it sets
 * `CLAUDE_CONFIG_DIR` to a directory that is NOT under `$HOME`, so any component
 * still falling back to `$HOME/.claude` reads an empty tree and fails loudly.
 *
 * `CLAUDE_CONFIG_DIR` is the surviving override since #691 (`CLAUDE_HOME` is
 * deleted), and it is honoured for the same reason it always was: herdctl
 * declines to clobber an operator-set value, so paddock disagreeing with it
 * recreates this exact split-brain.
 */
describe("integration: the configured Claude home is threaded into the engine (#588)", () => {
  let t: TestApp;
  let altRoot: string;
  let altHome: string;

  beforeAll(async () => {
    altRoot = await makeTmpDir("paddock-althome-");
    altHome = path.join(altRoot, "elsewhere", "dot-claude");
    t = await startTestApp({ env: { CLAUDE_CONFIG_DIR: altHome } });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Alt Home" } });
  });
  afterAll(async () => {
    await t.teardown();
    await rmTmpDir(altRoot);
  });

  it("is a REAL discriminator: the alt home is outside $HOME", () => {
    // If this ever stops holding, every assertion below passes vacuously.
    expect(altHome).not.toBe(path.join(t.home, ".claude"));
    expect(altHome.startsWith(t.home)).toBe(false);
  });

  it("resolves CLAUDE_CONFIG_DIR ONCE into PaddockConfig", () => {
    expect(t.cfg.claudeHome).toBe(altHome);
  });

  it("hands that SAME home to the FleetManager (the actual bug)", () => {
    // Pre-fix this returned `os.homedir()/.claude` — the engine's own default —
    // while paddock symlinked transcripts into `altHome`.
    expect(t.herdctl.manager.getClaudeHomePath()).toBe(altHome);
  });

  it("plants the project's transcript symlink under that home, not $HOME/.claude", async () => {
    const project = (await t.app.inject({ method: "GET", url: "/api/projects/alt-home" })).json()
      .project as { dir: string; workingDir: string };
    const encoded = path.join(altHome, "projects", encodeProjectDir(project.workingDir));
    expect(await fs.readlink(encoded)).toBe(path.join(project.dir, ".chats"));
    // …and nothing at all was written into the default home.
    await expect(fs.access(path.join(t.home, ".claude", "projects"))).rejects.toBeTruthy();
  });

  it("READS a transcript through the alt home: a seeded chat lists (not just exists)", async () => {
    // The end-to-end proof. The engine resolves an agent's sessions at
    // `<claudeHomePath>/projects/<encoded cwd>/`; that path exists ONLY in the
    // alt home. An engine still defaulting to `$HOME/.claude` finds no directory
    // and returns zero chats — which is the "lists but opens empty" failure seen
    // from the other side.
    const project = (await t.app.inject({ method: "GET", url: "/api/projects/alt-home" })).json()
      .project as { dir: string; workingDir: string };
    const sessionId = "11111111-2222-3333-4444-555555555555";
    // Write THROUGH the symlink under the alt home, exactly as Claude Code would.
    const encoded = path.join(altHome, "projects", encodeProjectDir(project.workingDir));
    await fs.writeFile(
      path.join(encoded, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          sessionId,
          cwd: project.workingDir,
          timestamp: new Date("2026-01-02T03:04:05Z").toISOString(),
          message: { role: "user", content: "a chat that only exists in the alt home" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId,
          cwd: project.workingDir,
          timestamp: new Date("2026-01-02T03:04:06Z").toISOString(),
          message: { role: "assistant", content: [{ type: "text", text: "ack" }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    // The engine must SEE it — this is the detection half, and it only works if
    // the engine is scanning the alt home.
    const adoptable = await t.herdctl.manager.listAdoptableSessions("keeper-alt-home");
    expect(adoptable.map((s) => s.sessionId)).toContain(sessionId);

    // Adopt it, and it becomes an ordinary listed chat.
    await t.herdctl.manager.adoptSessionsFrom("keeper-alt-home");
    t.herdctl.invalidateSessions("keeper-alt-home");

    const chats = (await t.app.inject({ method: "GET", url: "/api/projects/alt-home/chats" }))
      .json().chats as Array<{ sessionId: string }>;
    expect(chats.map((c) => c.sessionId)).toContain(sessionId);

    // And the message-read path resolves the same home — "lists but opens empty"
    // is a DISTINCT failure, so assert the body too.
    const messages = (
      await t.app.inject({
        method: "GET",
        url: `/api/projects/alt-home/chats/${sessionId}/messages`,
      })
    ).json().messages as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.content.includes("only exists in the alt home"))).toBe(true);
  });
});
