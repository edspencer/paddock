/**
 * `paddock config show` end to end, through the real entrypoint (#878).
 *
 * The unit tests cover parsing, provenance and rendering separately. What only a
 * spawn can cover is the wiring between them: the verb reaching its handler, the
 * data dir being resolved into `PADDOCK_DATA_DIR` BEFORE the loader is imported,
 * and a config file that does not parse exiting non-zero instead of printing a
 * half-report.
 *
 * Each case runs with a **constructed** environment rather than an inherited
 * one. That is not tidiness: this box, and any developer machine that runs
 * Paddock, exports `PADDOCK_*` variables that would legitimately relabel these
 * rows `env` and turn every assertion below into a false failure.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "../../src/cli/paddock.ts");
const tsx = path.resolve(here, "../../node_modules/.bin/tsx");

let tmp: string;

/** A minimal, deterministic environment — nothing Paddock reads leaks in. */
const cleanEnv = (dataDir: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  HOME: tmp,
  PADDOCK_DATA_DIR: dataDir,
});

beforeAll(async () => {
  tmp = await makeTmpDir("paddock-cli-config-");
});
afterAll(async () => {
  await rmTmpDir(tmp);
});

describe("paddock config show (#878)", () => {
  it("prints every value with the layer it came from, all four distinguishable", async () => {
    const dataDir = path.join(tmp, "layered");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "paddock.config.yaml"),
      // A thin file in exactly the shape #878 argues for: a posture, plus the
      // levers this operator disagrees with.
      "profile: yolo\nclaude:\n  hooks: own\nlogLevel: debug\n",
      "utf8",
    );

    const { stdout } = await run(tsx, [entry, "config", "show", "--resolved"], {
      timeout: 60_000,
      env: { ...cleanEnv(dataDir), PADDOCK_BRAND_NAME: "From The Env" },
    });

    expect(stdout).toContain("Profile      yolo  (config file)");
    // profile — `yolo` raises this above every other profile's value, so the
    // label is checkable against the number rather than merely present.
    expect(stdout).toMatch(/maxSpawnDepth\s+2\s+profile \(yolo\)/);
    // file — and specifically a file key BEATING the profile, which says `host`.
    expect(stdout).toMatch(/claude\.hooks\s+own\s+file/);
    // env
    expect(stdout).toMatch(/brand\.name\s+From The Env\s+env PADDOCK_BRAND_NAME/);
    // default — an operational key, which no profile has an opinion about.
    expect(stdout).toMatch(/recovery\.maxRetries\s+1\s+default/);
    // A secret-shaped value is not printed by a command whose output gets pasted.
    expect(stdout).toContain("(hidden)");
  }, 70_000);

  it("reports on an instance without creating it", async () => {
    const dataDir = path.join(tmp, "never-created");
    const { stdout } = await run(tsx, [entry, "config", "show"], {
      timeout: 60_000,
      env: cleanEnv(dataDir),
    });
    expect(stdout).toContain("(not present)");
    expect(stdout).toContain("(no config file)");
    await expect(fs.stat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
  }, 70_000);

  it("fails, loudly and non-zero, on a config file the server could not boot with", async () => {
    const dataDir = path.join(tmp, "broken");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "paddock.config.yaml"), "a:\n b: [1,\n  c: 2\n", "utf8");

    await expect(
      run(tsx, [entry, "config", "show"], { timeout: 60_000, env: cleanEnv(dataDir) }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("This is what `paddock start` would fail with too."),
    });
  }, 70_000);
});
