/**
 * Tests for the repo-level CI guard `scripts/check-no-nul-bytes.mjs` (#570,
 * widened in #642).
 *
 * `scripts/` has no test suite of its own, and the guard is a plain Node script
 * with no importable surface, so it is exercised the way CI does: as a
 * subprocess. To avoid ever writing a NUL-bearing file into the real working
 * tree, each case builds a synthetic repo in a temp dir — `packages/`,
 * `scripts/`, `website/` — and drops a COPY of the real script at the same
 * relative position (`<tree>/scripts/`), which is what its `ROOT`/`SCAN_ROOT`
 * resolution keys off. The fixtures therefore live and die with the temp dir
 * and cannot collide with a concurrent run.
 *
 * The NUL itself is written as the `\u0000` escape — the very fix the guard
 * exists to enforce — so this file stays greppable.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const SCRIPT = fileURLToPath(
  new URL("../../../../scripts/check-no-nul-bytes.mjs", import.meta.url),
);

/** A raw NUL byte, spelled as an escape (never pasted). */
const NUL = "\u0000";

type Run = { code: number; stdout: string; stderr: string };

/** Run the copied guard inside `tree` and capture its exit code + output. */
function runGuard(tree: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(tree, "scripts", "check-no-nul-bytes.mjs")],
      { cwd: tree },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe("scripts/check-no-nul-bytes.mjs", () => {
  let tree: string;

  beforeEach(async () => {
    tree = await makeTmpDir("paddock-nulguard-");
    // A minimal stand-in for the repo layout the guard walks.
    await fs.mkdir(path.join(tree, "packages", "server", "src"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tree, "scripts"), { recursive: true });
    await fs.mkdir(path.join(tree, "website", "src"), { recursive: true });
    await fs.copyFile(
      SCRIPT,
      path.join(tree, "scripts", "check-no-nul-bytes.mjs"),
    );
  });

  afterEach(async () => {
    await rmTmpDir(tree);
  });

  it("passes on a clean tree", async () => {
    await fs.writeFile(
      path.join(tree, "packages", "server", "src", "ws.ts"),
      'export const KEY_SEP = "\\u0000";\n',
    );
    await fs.writeFile(
      path.join(tree, "scripts", "seed.mjs"),
      'const sep = "\\u0000";\n',
    );

    const { code, stdout } = await runGuard(tree);
    expect(code).toBe(0);
    expect(stdout).toContain("check:nul — OK");
  });

  // The gap #642 closes: the NUL that actually shipped was in a .mjs under
  // scripts/, which the old `packages/` + `.ts|.tsx` scan never looked at.
  it("flags a raw NUL in a .mjs file under scripts/", async () => {
    await fs.writeFile(
      path.join(tree, "scripts", "seed.mjs"),
      `// escape, never a raw NUL byte\nconst sep = "${NUL}";\n`,
    );

    const { code, stderr } = await runGuard(tree);
    expect(code).toBe(1);
    expect(stderr).toContain("scripts/seed.mjs:2:");
  });

  it("flags a raw NUL in a .js file outside packages/", async () => {
    await fs.writeFile(
      path.join(tree, "website", "src", "keys.js"),
      `const sep = "${NUL}";\n`,
    );

    const { code, stderr } = await runGuard(tree);
    expect(code).toBe(1);
    expect(stderr).toContain(path.join("website", "src", "keys.js") + ":1:");
  });

  it("still flags a raw NUL in a .ts file under packages/", async () => {
    await fs.writeFile(
      path.join(tree, "packages", "server", "src", "ws.ts"),
      `export const KEY_SEP = "${NUL}";\n`,
    );

    const { code, stderr } = await runGuard(tree);
    expect(code).toBe(1);
    expect(stderr).toContain(path.join("packages", "server", "src", "ws.ts"));
  });

  it("skips node_modules and build output", async () => {
    for (const dir of ["node_modules", "dist"]) {
      const d = path.join(tree, "website", dir);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, "bundle.js"), `const s = "${NUL}";\n`);
    }

    const { code } = await runGuard(tree);
    expect(code).toBe(0);
  });

  // Deliberate, per #642: the guard is about *source* staying greppable, and a
  // NUL in a JSON fixture is more likely to be intentional test data.
  it("does not scan .json or .md", async () => {
    await fs.writeFile(
      path.join(tree, "packages", "server", "src", "fixture.json"),
      `{"key":"${NUL}"}\n`,
    );
    await fs.writeFile(path.join(tree, "NOTES.md"), `a ${NUL} byte\n`);

    const { code } = await runGuard(tree);
    expect(code).toBe(0);
  });
});
