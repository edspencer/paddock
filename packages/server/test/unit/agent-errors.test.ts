/**
 * #684 — a credential-less first run must not look like a crash.
 *
 * The observed output was a multi-screen dump containing the entire sweeper
 * system prompt four times: in the `ExecaError`, in the `[fleet-manager]` line,
 * in the serialised `err.message` and again in `err.stack`. The one useful
 * string — `Not logged in · Please run /login` — was on line 40. The server was
 * fine and still serving; nothing in the output said so.
 *
 * The fixtures below are trimmed from that real run.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
// `createLogger` reads the global handler at CALL time, so a logger made here
// picks up whatever `installHerdctlLogBridge` installed — which is exactly the
// path the engine's own `[CLIRuntime]` and `[fleet-manager]` lines take.
import { setLogHandler, createLogger } from "@herdctl/core";
import {
  classifyAgentError,
  summariseAgentError,
  installHerdctlLogBridge,
} from "../../src/agent-errors.js";

/** The shape core actually emits, with the 2 KB prompt cut down to a marker. */
const SWEEPER_ARGV =
  "Command failed with exit code 1: claude -p --permission-mode acceptEdits " +
  "--model claude-haiku-4-5-20251001 --system-prompt 'You are a concise project curator. " +
  "SECRET_PROMPT_BODY …' --disallowedTools 'Bash(sudo *),Bash(rm -rf /)'";

const NOT_LOGGED_IN = `Process failed: ExecaError: ${SWEEPER_ARGV}\n\nNot logged in · Please run /login`;

afterEach(() => {
  setLogHandler(null); // the handler is global to the process
  vi.restoreAllMocks();
  delete process.env.HERDCTL_LOG_LEVEL;
});

describe("summariseAgentError", () => {
  // The point of the whole PR: the curator system prompt must not be copied
  // into a terminal, a log file, or a bug report pasted from one.
  it("cuts the reconstructed argv, and with it the system prompt", () => {
    const out = summariseAgentError(SWEEPER_ARGV);
    expect(out).not.toContain("SECRET_PROMPT_BODY");
    expect(out).not.toContain("--disallowedTools");
    expect(out).toContain("argv omitted");
  });

  it("keeps the diagnostic head — the exit status is the useful part", () => {
    expect(summariseAgentError(SWEEPER_ARGV)).toContain("Command failed with exit code 1");
  });

  it("leaves a message with no argv in it completely alone", () => {
    const plain = "Job job-1 error: something else went wrong";
    expect(summariseAgentError(plain)).toBe(plain);
  });

  it("handles the canceled and ENOENT variants the same way", () => {
    for (const head of ["Command was canceled", "Command failed with ENOENT"]) {
      const out = summariseAgentError(`${head}: claude -p --model x --system-prompt 'BODY'`);
      expect(out).not.toContain("BODY");
      expect(out).toContain(head);
    }
  });
});

describe("classifyAgentError", () => {
  it("recognises the credential failure wherever it appears in the text", () => {
    expect(classifyAgentError(NOT_LOGGED_IN)).toMatch(/not logged in/i);
    // execa hangs the CLI's own output off stdout/stderr rather than message.
    expect(classifyAgentError({ message: SWEEPER_ARGV, stderr: "Not logged in" })).toMatch(
      /not logged in/i
    );
  });

  it("names a remedy, since that is the whole reason to special-case it", () => {
    expect(classifyAgentError(NOT_LOGGED_IN)).toMatch(/setup-token|CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("recognises a missing `claude` binary and an exhausted account", () => {
    expect(classifyAgentError("Command failed with ENOENT: claude -p")).toMatch(/PATH/);
    expect(classifyAgentError("Credit balance is too low")).toMatch(/credit/i);
  });

  it("does not blame the CLI for an ENOENT that is not about `claude`", () => {
    // A confident wrong answer is worse than the raw error it replaces, and it
    // would send somebody off reinstalling a binary that is sitting on PATH.
    expect(
      classifyAgentError("ENOENT: no such file or directory, open '/data/projects/x.yaml'"),
    ).toBeUndefined();
  });

  // The important negative. An unknown failure keeps its full detail, because
  // that is precisely the case where somebody needs it.
  it("returns undefined for a failure it does not recognise", () => {
    expect(classifyAgentError("Command failed with exit code 137")).toBeUndefined();
    expect(classifyAgentError(undefined)).toBeUndefined();
    expect(classifyAgentError({})).toBeUndefined();
  });
});

describe("installHerdctlLogBridge", () => {
  const capture = () => vi.spyOn(console, "error").mockImplementation(() => {});

  // THE regression: `LOG_LEVEL=warn` never suppressed this, because core logs it
  // at `error` — above every threshold either variable can set — and one of the
  // two lines is a bare `console.error`. Quiet-by-default meant "quiet when
  // nothing goes wrong", which is the easy half.
  it("collapses a known failure to one actionable line in quiet mode", () => {
    const spy = capture();
    installHerdctlLogBridge({ quiet: true });
    coreLogger("CLIRuntime").error(NOT_LOGGED_IN);

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toMatch(/not logged in/i);
    expect(line).toContain("--verbose");
    expect(line).not.toContain("SECRET_PROMPT_BODY");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("still summarises the argv when NOT quiet — a server does not want it either", () => {
    const spy = capture();
    installHerdctlLogBridge({ quiet: false });
    coreLogger("fleet-manager").error(`Job job-1 error: CLI execution failed: ${SWEEPER_ARGV}`);

    const line = spy.mock.calls[0][0] as string;
    expect(line).not.toContain("SECRET_PROMPT_BODY");
    expect(line).toContain("Job job-1 error"); // which job failed is still said
  });

  it("keeps an UNRECOGNISED error intact in quiet mode", () => {
    const spy = capture();
    installHerdctlLogBridge({ quiet: true });
    coreLogger("fleet-manager").error("Job job-1 error: disk quota exceeded");
    expect(spy.mock.calls[0][0]).toContain("disk quota exceeded");
  });

  it("restores the full argv at debug level, so the detail is recoverable", () => {
    process.env.HERDCTL_LOG_LEVEL = "debug";
    const spy = capture();
    installHerdctlLogBridge({ quiet: true });
    coreLogger("CLIRuntime").error(SWEEPER_ARGV);
    expect(spy.mock.calls[0][0]).toContain("SECRET_PROMPT_BODY");
  });

  it("honours the configured level, so info lines stay suppressed at warn", () => {
    process.env.HERDCTL_LOG_LEVEL = "warn";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    installHerdctlLogBridge({ quiet: true });
    coreLogger("fleet-manager").info("started");
    expect(info).not.toHaveBeenCalled();
  });
});

/** A logger from core's own factory — the thing the handler has to intercept. */
const coreLogger = createLogger;
