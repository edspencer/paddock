import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withClaudeConfigDir } from "@herdctl/core";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { SECURE_STORAGE_DIR_VAR } from "../../src/claude-credentials.js";

const run = promisify(execFile);

/**
 * `claude.credentials` (#691, step 3) — the environment a real boot hands the
 * runtime, and what a real child process makes of it.
 *
 * ## What this can and cannot prove
 *
 * The lever's payoff is on macOS: Claude Code derives its secure-storage service
 * name from `CLAUDE_SECURESTORAGE_CONFIG_DIR` (when defined) instead of
 * `CLAUDE_CONFIG_DIR`, so defining it as `""` selects the unsuffixed
 * `Claude Code-credentials` entry — the one a plain `claude /login` wrote — while
 * paddock's config dir stays at its own home. That derivation is quoted verbatim
 * in `claude-credentials.ts`; **it is not exercised here and cannot be.** CI is
 * Linux, there is no Keychain, and the lookup happens inside Claude Code.
 *
 * What IS exercised, end to end, is everything on paddock's side of that line:
 *
 *  1. a real `buildApp()` boot resolves the mode and writes (or does not write)
 *     the variable;
 *  2. the exact herdctl function the SDK runtime uses to build `options.env`
 *     (`withClaudeConfigDir` — the env there REPLACES the child's rather than
 *     merging, so this is the whole environment) carries it through;
 *  3. a REAL spawned process, with that same env, reports the empty string as an
 *     empty string rather than as absent — which is the one OS-level fact the
 *     whole mechanism rests on, and the one an assertion against an object in
 *     this process would quietly skip.
 *
 * (3) is worth the child process: `""` is not a value most environment plumbing
 * is careful with. Windows drops empty variables entirely, and had Node followed
 * suit on POSIX the lever would silently degrade to `own` — the failure looking
 * exactly like #683 again.
 */
describe("integration: claude.credentials decides the runtime's environment (#691)", () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.teardown();
    t = undefined;
  });

  /** What a spawned child actually sees, as JSON: a string, or null if unset. */
  async function childSees(env?: NodeJS.ProcessEnv): Promise<string | null> {
    const { stdout } = await run(
      process.execPath,
      ["-e", `process.stdout.write(JSON.stringify(process.env[${JSON.stringify(SECURE_STORAGE_DIR_VAR)}] ?? null))`],
      env === undefined ? {} : { env: env as NodeJS.ProcessEnv },
    );
    return JSON.parse(stdout) as string | null;
  }

  it("host (the default) hands the runtime an EMPTY value, and a real child sees it as empty", async () => {
    t = await startTestApp();
    expect(t.cfg.claude.credentials).toBe("host");

    // The SDK runtime's own env construction, called exactly as herdctl calls it.
    const sdkEnv = withClaudeConfigDir(t.cfg.claudeHome, process.env);
    expect(sdkEnv).toBeDefined();
    expect(sdkEnv![SECURE_STORAGE_DIR_VAR]).toBe("");
    // …and the config dir is still paddock's own. Sharing the login must not
    // drag transcripts or agent memory along with it — that coupling IS #683.
    expect(sdkEnv!.CLAUDE_CONFIG_DIR).toBe(t.cfg.claudeHome);

    expect(await childSees(sdkEnv)).toBe("");
    // The CLI runtime (sweeper, triggers, driveMode: batch) merges over the
    // INHERITED environment rather than replacing it, so it gets there by a
    // different route. Plain inheritance, no env option:
    expect(await childSees()).toBe("");
  });

  it("own leaves it unset, so Claude Code scopes credentials to paddock's own home", async () => {
    t = await startTestApp({ env: { PADDOCK_CLAUDE_CREDENTIALS: "own" } });
    expect(t.cfg.claude.credentials).toBe("own");

    const sdkEnv = withClaudeConfigDir(t.cfg.claudeHome, process.env);
    expect(sdkEnv).toBeDefined();
    expect(SECURE_STORAGE_DIR_VAR in sdkEnv!).toBe(false);
    expect(sdkEnv!.CLAUDE_CONFIG_DIR).toBe(t.cfg.claudeHome);

    expect(await childSees(sdkEnv)).toBeNull();
    expect(await childSees()).toBeNull();
  });

  it("is set from the config file too, not only from the env var", async () => {
    t = await startTestApp({ configFile: { claude: { credentials: "own" } } });
    expect(t.cfg.claude.credentials).toBe("own");
    expect(await childSees()).toBeNull();
  });

  it("is independent of transcripts: sharing one shares nothing of the other", async () => {
    // The point of splitting the levers (#691). `transcripts: host` used to imply
    // a shared login and vice versa, because both were the same Claude home.
    t = await startTestApp({
      env: { PADDOCK_CLAUDE_TRANSCRIPTS: "host", PADDOCK_CLAUDE_CREDENTIALS: "own" },
    });
    expect(t.cfg.claude.transcripts).toBe("host");
    expect(t.cfg.claude.credentials).toBe("own");
    expect(await childSees()).toBeNull();
  });
});
