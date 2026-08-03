/**
 * Regression test: the `paddock` bin must run when invoked through a SYMLINK.
 *
 * npm installs a `bin` as a symlink at `node_modules/.bin/<name>`. A previous
 * version guarded `main()` with
 * `pathToFileURL(process.argv[1]).href === import.meta.url`, which is false
 * through a symlink because argv[1] is the link path and `import.meta.url` is
 * the realpath. The published CLI printed nothing and exited 0 in 0.57.0,
 * 0.58.0 and 0.59.0.
 *
 * Every manual check at the time used `node <file>` directly — the one
 * invocation where that guard holds — so nothing caught it. This test spawns
 * the entrypoint through a symlink specifically, which is the shape that broke.
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
let link: string;

beforeAll(async () => {
  tmp = await makeTmpDir();
  link = path.join(tmp, "paddock-link.ts");
  await fs.symlink(entry, link);
});
afterAll(async () => {
  await rmTmpDir(tmp);
});

describe("paddock bin invocation (#638 regression)", () => {
  it("prints its version when run through a symlink", async () => {
    const { stdout } = await run(tsx, [link, "--version"], { timeout: 60_000 });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 70_000);

  it("prints usage when run through a symlink", async () => {
    const { stdout } = await run(tsx, [link, "--help"], { timeout: 60_000 });
    expect(stdout).toContain("paddock — run a Paddock instance locally");
    expect(stdout).toContain("--here");
  }, 70_000);

  it("still exits non-zero on a bad flag through a symlink", async () => {
    await expect(run(tsx, [link, "--definitely-not-a-flag"], { timeout: 60_000 })).rejects.toMatchObject(
      { code: 1 },
    );
  }, 70_000);
});
