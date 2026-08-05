/**
 * #683 — credential continuity on the interactive CLI path.
 *
 * The bug: since #620 paddock always sets `CLAUDE_CONFIG_DIR`, and Claude Code
 * derives its Keychain service name from whether that variable is set at all, so
 * a macOS login made under the plain name is invisible. `.credentials.json` can
 * be symlinked; a Keychain entry cannot. The only lever is which home the CLI
 * runs against, so that is what these tests pin down.
 *
 * All of it is a pure decision table on purpose. The Keychain itself cannot be
 * exercised on Linux, and a decision that could only be tested on a Mac would in
 * practice not be tested at all.
 */
import { describe, it, expect } from "vitest";
import {
  chooseClaudeHome,
  userClaudeHomePath,
} from "../../src/cli/claude-home-choice.js";

const USER_HOME = "/Users/ed/.claude";

const choose = (
  env: NodeJS.ProcessEnv,
  { exists = true, forceIsolated = false } = {},
): ReturnType<typeof chooseClaudeHome> =>
  chooseClaudeHome({
    env,
    userClaudeHome: USER_HOME,
    userHomeExists: exists,
    forceIsolated,
  });

describe("chooseClaudeHome (#683)", () => {
  // THE case: a laptop with a Claude Code login and nothing in the environment.
  // On macOS that login is in the Keychain, and running against the user's own
  // home is the only configuration in which Claude Code will look for it under
  // the name it was filed under.
  it("inherits the user's home when there is no token and no explicit home", () => {
    expect(choose({})).toEqual({
      claudeHome: USER_HOME,
      reason: expect.stringContaining(USER_HOME),
    });
  });

  it.each(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])(
    "keeps the isolated home when %s authenticates it anyway",
    (tokenVar) => {
      // Isolation is strictly better when it costs nothing, and this is the
      // shape every CI, container and server run has.
      const decision = choose({ [tokenVar]: "sk-whatever" });
      expect(decision.claudeHome).toBeUndefined();
      expect(decision.reason).toContain(tokenVar);
    },
  );

  it.each(["CLAUDE_HOME", "CLAUDE_CONFIG_DIR"])(
    "never overrides an explicit %s, even to a different path",
    (homeVar) => {
      const decision = choose({ [homeVar]: "/somewhere/chosen" });
      expect(decision.claudeHome).toBeUndefined();
      expect(decision.reason).toContain(homeVar);
    },
  );

  it("ignores an empty or whitespace-only variable rather than treating it as set", () => {
    // `CLAUDE_HOME=` in a shell profile is not a choice of home, and reading it
    // as one would silently disable continuity for anyone who has one.
    expect(choose({ CLAUDE_HOME: "", CLAUDE_CODE_OAUTH_TOKEN: "   " }).claudeHome).toBe(USER_HOME);
  });

  it("keeps the isolated home when the user has no ~/.claude at all", () => {
    expect(choose({}, { exists: false }).claudeHome).toBeUndefined();
  });

  it("keeps the isolated home when --isolated-claude-home was passed", () => {
    const decision = choose({}, { forceIsolated: true });
    expect(decision.claudeHome).toBeUndefined();
    expect(decision.reason).toContain("--isolated-claude-home");
  });

  it("puts an explicit home ahead of the opt-out flag, so the reason is the real one", () => {
    // Both would keep the isolated home, but they are not the same isolated
    // home — CLAUDE_HOME names a third directory, and saying "--isolated" would
    // misdescribe what is about to happen.
    expect(choose({ CLAUDE_HOME: "/elsewhere" }, { forceIsolated: true }).reason).toContain(
      "CLAUDE_HOME",
    );
  });

  it("always gives a reason, so the CLI never has to invent one", () => {
    for (const decision of [
      choose({}),
      choose({ CLAUDE_HOME: "/x" }),
      choose({ ANTHROPIC_API_KEY: "k" }),
      choose({}, { exists: false }),
      choose({}, { forceIsolated: true }),
    ]) {
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("userClaudeHomePath", () => {
  it("is <homedir>/.claude", () => {
    expect(userClaudeHomePath("/Users/ed")).toBe("/Users/ed/.claude");
  });
});
