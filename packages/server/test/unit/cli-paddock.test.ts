/**
 * Unit tests for the `paddock` CLI's pure parts (#638).
 *
 * Only the side-effect-free pieces are covered here: argument parsing, the Node
 * version gate, and listen-error translation. Everything else in that module
 * mutates `process.env`, spawns, or starts a server, and is exercised by running
 * the built binary.
 *
 * These live in `cli/args.ts` rather than the entrypoint precisely so they can
 * be imported without running anything — the run-directly guard that used to
 * make that possible is what broke the published binary (see args.ts).
 */
import { describe, it, expect } from "vitest";
import {
  parseArgs,
  nodeVersionProblem,
  explainListenError,
  CliError,
} from "../../src/cli/args.js";

describe("paddock CLI: parseArgs", () => {
  it("defaults every boolean to false and leaves values unset", () => {
    expect(parseArgs([])).toEqual({
      here: false,
      open: false,
      verbose: false,
      help: false,
      version: false,
    });
  });

  it("parses long forms", () => {
    const opts = parseArgs([
      "--port",
      "4100",
      "--host",
      "0.0.0.0",
      "--data-dir",
      "/tmp/pad",
      "--open",
      "--verbose",
    ]);
    expect(opts.port).toBe("4100");
    expect(opts.host).toBe("0.0.0.0");
    expect(opts.dataDir).toBe("/tmp/pad");
    expect(opts.open).toBe(true);
    expect(opts.verbose).toBe(true);
  });

  it("parses short forms", () => {
    const opts = parseArgs(["-p", "4100", "-d", "/tmp/pad", "-o"]);
    expect(opts.port).toBe("4100");
    expect(opts.dataDir).toBe("/tmp/pad");
    expect(opts.open).toBe(true);
  });

  it.each([
    ["-h", "help"],
    ["--help", "help"],
    ["-v", "version"],
    ["--version", "version"],
  ] as const)("%s sets %s", (flag, key) => {
    expect(parseArgs([flag])[key]).toBe(true);
  });

  it("last flag wins when a value option repeats", () => {
    expect(parseArgs(["--port", "4000", "--port", "4100"]).port).toBe("4100");
  });

  it("rejects an unknown option and names --help", () => {
    expect(() => parseArgs(["--nope"])).toThrow(CliError);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option: --nope/);
    expect(() => parseArgs(["--nope"])).toThrow(/--help/);
  });

  it("rejects a value option with no value", () => {
    expect(() => parseArgs(["--port"])).toThrow(/--port needs a value/);
    expect(() => parseArgs(["--data-dir"])).toThrow(/--data-dir needs a value/);
  });

  it("treats a bare positional as an unknown option rather than ignoring it", () => {
    // Silently dropping it would let `paddock 4100` look like it worked while
    // starting on the default port.
    expect(() => parseArgs(["4100"])).toThrow(CliError);
  });
});

describe("paddock CLI: nodeVersionProblem", () => {
  it.each(["22.0.0", "22.14.1", "24.3.0", "30.0.0"])("accepts Node %s", (v) => {
    expect(nodeVersionProblem(v)).toBeUndefined();
  });

  it.each(["18.20.4", "20.11.0", "21.7.3"])("rejects Node %s", (v) => {
    const problem = nodeVersionProblem(v);
    expect(problem).toBeDefined();
    expect(problem).toContain(v);
    expect(problem).toContain("22");
  });

  it("does not reject when the version is unparseable", () => {
    // Better to attempt the boot than to refuse to run on a version string we
    // failed to understand.
    expect(nodeVersionProblem("banana")).toBeUndefined();
  });
});

describe("paddock CLI: explainListenError", () => {
  it("turns EADDRINUSE into a message naming the port and the fix", () => {
    const msg = explainListenError({ code: "EADDRINUSE" }, "127.0.0.1", "4000");
    expect(msg).toContain("4000");
    expect(msg).toContain("already in use");
    expect(msg).toContain("--port 4001"); // suggests the next port up
  });

  it("turns EACCES into privilege guidance", () => {
    const msg = explainListenError({ code: "EACCES" }, "127.0.0.1", "80");
    expect(msg).toContain("80");
    expect(msg).toMatch(/privilege/i);
  });

  it("falls back to the underlying message for anything else", () => {
    expect(explainListenError({ code: "EWHATEVER", message: "boom" }, "h", "1")).toBe("boom");
  });

  it("survives a non-Error throw", () => {
    expect(explainListenError("plain string", "h", "1")).toBe("plain string");
    expect(explainListenError(undefined, "h", "1")).toBe("undefined");
  });
});
