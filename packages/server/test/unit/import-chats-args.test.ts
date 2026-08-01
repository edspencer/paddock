import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli/import-chats.js";

/**
 * Argument parsing for the headless chat importer (#588).
 *
 * Small surface, but one case is genuinely load-bearing: the ROOT workspace's
 * key is the EMPTY STRING, so `--project ""` has to survive both the parser's
 * "does this flag have a value" check and the caller's "was a project given"
 * check. Written as truthiness, either one silently rejects the one workspace
 * that always exists.
 */
describe("import-chats parseArgs (#588)", () => {
  it("defaults to a copy-mode, non-dry run with no project", () => {
    expect(parseArgs([])).toEqual({ move: false, dryRun: false, json: false, help: false });
  });

  it("parses every flag", () => {
    expect(
      parseArgs([
        "--project", "acme-api",
        "--from", "/home/ed/code/acme-api",
        "--move",
        "--dry-run",
        "--data-dir", "/srv/paddock/data",
        "--json",
      ]),
    ).toEqual({
      project: "acme-api",
      from: "/home/ed/code/acme-api",
      move: true,
      dryRun: true,
      dataDir: "/srv/paddock/data",
      json: true,
      help: false,
    });
  });

  it('keeps `--project ""` — the ROOT workspace is a real target, not a missing one', () => {
    expect(parseArgs(["--project", ""]).project).toBe("");
    expect(parseArgs(["--root"]).project).toBe("");
  });

  it("rejects a flag whose value is missing or is another flag", () => {
    expect(() => parseArgs(["--project"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--project", "--dry-run"])).toThrow(/needs a value/);
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    expect(() => parseArgs(["--porject", "x"])).toThrow(/Unknown argument/);
  });

  it("accepts a bare `--` value, so a path can't be mistaken for a flag", () => {
    // `--` alone is length 2, so it is treated as a value, not a flag.
    expect(parseArgs(["--from", "--"]).from).toBe("--");
  });
});
