import { describe, it, expect } from "vitest";
import {
  applyCredentialsMode,
  isKnownCredentialsMode,
  DEFAULT_CREDENTIALS_MODE,
  SECURE_STORAGE_DIR_VAR,
} from "../../src/claude-credentials.js";

/**
 * The `claude.credentials` lever (#691) — the decision table only.
 *
 * **What this file CANNOT test, and does not pretend to:** whether the macOS
 * Keychain then hands back the right entry. There is no Keychain on Linux or in
 * CI, and the lookup happens inside Claude Code, in a child process, on darwin.
 * What is testable — and is the whole of paddock's side of the contract — is that
 * the right environment is produced for that child. The service-name derivation
 * it feeds is quoted verbatim from the SDK bundle in `claude-credentials.ts`;
 * `test/integration/claude-credentials-env.test.ts` carries it the rest of the
 * way, through a real boot and a real spawn.
 */
describe("claude-credentials: applyCredentialsMode (#691)", () => {
  it("defaults to host — sharing a login writes nothing, and `own` recreates #683", () => {
    // The one key in the `claude:` block that does not default to `own`. If this
    // ever flips, a Mac whose only login is a `claude /login` boots clean and
    // fails every turn, which is exactly the incident this lever closes.
    expect(DEFAULT_CREDENTIALS_MODE).toBe("host");
  });

  it("host DEFINES the variable as the empty string", () => {
    // The empty string is the signal, not a missing value: the SDK branches on
    // `t !== undefined ? !t : …`, so "" is what drops the config-dir hash and
    // selects the plain `Claude Code-credentials` entry.
    const env: NodeJS.ProcessEnv = {};
    expect(applyCredentialsMode("host", env)).toEqual({ action: "shared" });
    expect(env[SECURE_STORAGE_DIR_VAR]).toBe("");
    expect(SECURE_STORAGE_DIR_VAR in env).toBe(true);
  });

  it("own leaves the variable UNSET, so secure storage stays scoped to paddock's home", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyCredentialsMode("own", env)).toEqual({ action: "isolated" });
    expect(SECURE_STORAGE_DIR_VAR in env).toBe(false);
  });

  it("own clears an empty value a previous host boot left behind", () => {
    // "" is what `host` writes, so it is ours by construction — not an operator's
    // choice to defer to. A long-lived process that reconfigures must not keep
    // sharing the login after being told to stop.
    const env: NodeJS.ProcessEnv = { [SECURE_STORAGE_DIR_VAR]: "" };
    expect(applyCredentialsMode("own", env)).toEqual({ action: "isolated" });
    expect(SECURE_STORAGE_DIR_VAR in env).toBe(false);
  });

  it("honours an operator's own non-empty value in BOTH modes, rather than clobbering it", () => {
    // The same courtesy CLAUDE_CONFIG_DIR gets (herdctl#423): a third
    // secure-storage scope is something neither mode can express, so paddock
    // says what it saw instead of overruling it.
    for (const mode of ["own", "host"] as const) {
      const env: NodeJS.ProcessEnv = { [SECURE_STORAGE_DIR_VAR]: "/elsewhere" };
      expect(applyCredentialsMode(mode, env)).toEqual({
        action: "deferred",
        value: "/elsewhere",
      });
      expect(env[SECURE_STORAGE_DIR_VAR]).toBe("/elsewhere");
    }
  });

  it("is idempotent — applying the same mode twice changes nothing", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyCredentialsMode("host", env)).toEqual({ action: "shared" });
    expect(applyCredentialsMode("host", env)).toEqual({ action: "shared" });
    expect(env[SECURE_STORAGE_DIR_VAR]).toBe("");
  });

  it("touches nothing else in the environment", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/data/claude-home" };
    applyCredentialsMode("host", env);
    expect(env.PATH).toBe("/usr/bin");
    // The whole point: the config dir is untouched, so transcripts and memory
    // stay in paddock's home while only the credential lookup moves.
    expect(env.CLAUDE_CONFIG_DIR).toBe("/data/claude-home");
  });

  it("recognises exactly the two modes", () => {
    expect(isKnownCredentialsMode("own")).toBe(true);
    expect(isKnownCredentialsMode("host")).toBe(true);
    expect(isKnownCredentialsMode("hostt")).toBe(false);
    expect(isKnownCredentialsMode("")).toBe(false);
  });
});
