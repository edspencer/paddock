/**
 * End-to-end proof that the environment system prompt (#635) actually reaches
 * the model's process — not just the config object.
 *
 * A field that saves to YAML and never leaves the server is precisely the bug
 * this issue exists to fix, so "the setting persists" is deliberately NOT what
 * these tests assert. They drive a REAL turn through the REAL @herdctl/core CLI
 * runtime and read back the `--system-prompt` argv the fake `claude` was spawned
 * with (`PADDOCK_FAKE_INVOCATION_LOG`, see `test/bin/claude`).
 *
 * Coverage boundary, stated honestly: this is the CLI/batch runtime, which is
 * the only one whose prompt assembly is observable from outside a test — the SDK
 * runtime resolves its own bundled binary and never shells out. That the SESSION
 * path passes the same value is asserted one layer up, at the `openChatSession`
 * call, in `test/unit/environment-prompt.test.ts`. Both runtimes consume the
 * identical `systemPromptAppend` option in core.
 *
 * Most cases here run with `nativeSystemPrompt: false` on purpose. herdctl's CLI
 * runtime folds the append into the single `--system-prompt` flag, which
 * REPLACES Claude Code's preset when there is nothing to concatenate onto — so
 * Paddock withholds the append from a native batch instance (see
 * `environmentPromptAppendForCli`). Turning the native prompt off gives the CLI
 * runtime a base prompt to append to, which is both the safe configuration and
 * the only one where the flag is observable at all. The last case pins the
 * withholding itself.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";
import { DEFAULT_ENVIRONMENT_PROMPT } from "../../src/environment-prompt.js";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" && e.payload?.projectSlug === slug;

interface Invocation {
  prompt: string;
  systemPrompt: string | null;
}

describe("integration: environment prompt reaches the runtime (#635)", () => {
  let t: TestApp | undefined;
  let ws: WsClient | undefined;

  afterEach(async () => {
    ws?.close();
    ws = undefined;
    await t?.teardown();
    t = undefined;
  });

  /**
   * Boot an app with the invocation recorder armed, run one real turn, and
   * return the `--system-prompt` the CLI runtime built for it (null when herdctl
   * passed no `--system-prompt` at all).
   */
  async function systemPromptForOneTurn(opts: {
    env?: Record<string, string>;
    configFile?: Record<string, unknown>;
  }): Promise<string | null> {
    // The log path must exist before the app boots; put it beside the temp data
    // dir the harness makes, via an env var the harness snapshots + restores.
    const logPath = path.join(
      await fs.mkdtemp(path.join((await fs.realpath("/tmp")) + path.sep, "paddock-inv-")),
      "invocations.jsonl",
    );
    t = await startTestApp({
      script: { "Hello there": "Hi!" },
      env: { ...opts.env, PADDOCK_FAKE_INVOCATION_LOG: logPath },
      // Default the fixture to the non-native prompt: that is the configuration
      // in which the CLI runtime appends (rather than replaces), and therefore
      // the only one where --system-prompt reflects our value. Cases override it.
      configFile: { nativeSystemPrompt: false, ...opts.configFile },
    });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Env Proj" } });
    const { port } = await listen(t.app);
    ws = await connectWs(port);

    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "env-proj", sessionId: null, message: "Hello there" },
    });
    await ws.waitFor(isComplete("env-proj"), { from: mark });

    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
    const turn = lines
      .map((l) => JSON.parse(l) as Invocation)
      .find((i) => i.prompt.includes("Hello there"));
    expect(turn, "the fake claude recorded no invocation for this turn").toBeDefined();
    return turn!.systemPrompt;
  }

  it("spawns `claude` with the built-in prompt APPENDED to the agent's own", async () => {
    const systemPrompt = await systemPromptForOneTurn({});
    // Appended, not substituted: the agent's role prompt still leads.
    expect(systemPrompt).toContain("You are a Claude Code agent for this project directory.");
    expect(systemPrompt!.endsWith(DEFAULT_ENVIRONMENT_PROMPT)).toBe(true);
  }, 30_000);

  it("spawns `claude` with an operator's override instead of the built-in", async () => {
    const custom = "You are in Widget Co's Paddock. Link every ticket as [ABC-1](…).";
    const systemPrompt = await systemPromptForOneTurn({
      configFile: { environmentPrompt: custom },
    });
    expect(systemPrompt!.endsWith(custom)).toBe(true);
    expect(systemPrompt).not.toContain("GitHub-Flavored");
  }, 30_000);

  it("appends nothing when the instance opts out", async () => {
    const systemPrompt = await systemPromptForOneTurn({
      env: { PADDOCK_ENVIRONMENT_PROMPT: "" },
    });
    // Just the agent's own prompt — pre-#635 behaviour, byte for byte.
    expect(systemPrompt).toBe(
      "You are a Claude Code agent for this project directory. " +
        "Honor any CLAUDE.md present. Keep CHANGELOG.md current. " +
        "Create branches for significant changes; never force-push.",
    );
  }, 30_000);

  it("preserves a multi-line, YAML-hostile override through the file and into argv", async () => {
    const hostile = 'line one: with a colon\n  "quoted" `backticked`\n# hashed — ✅\n';
    const systemPrompt = await systemPromptForOneTurn({
      configFile: { environmentPrompt: hostile },
    });
    expect(systemPrompt!.endsWith(hostile)).toBe(true);
  }, 30_000);

  it("passes NO --system-prompt on a NATIVE batch instance — never replaces the preset", async () => {
    // The guard in `environmentPromptAppendForCli`. With nativeSystemPrompt on,
    // there is nothing for the CLI runtime to concatenate onto, so sending the
    // append would swap Claude Code's whole coding preset for two rules.
    const systemPrompt = await systemPromptForOneTurn({
      configFile: { nativeSystemPrompt: true },
    });
    expect(systemPrompt).toBeNull();
  }, 30_000);
});
