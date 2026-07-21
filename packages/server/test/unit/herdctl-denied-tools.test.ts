/**
 * Keeper `denied_tools` — the best-effort catastrophic-wipe denylist (#179).
 *
 * The old rule carried `Bash(rm -rf /*)`, whose trailing `*` made it a prefix
 * match on `rm -rf /` — so it denied EVERY absolute-path delete (the keeper
 * cleaning up its own `/tmp/...` / clone dirs included), while giving false
 * security (a relative `rm -rf clones/x` sailed through). These tests pin the
 * new, honest behaviour:
 *   1. genuinely-catastrophic bare-root wipes are denied,
 *   2. legitimate absolute-path deletes under project/tmp roots are NOT denied,
 *   3. the generated herdctl.yaml actually emits this set end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { HerdctlService, KEEPER_DENIED_TOOLS } from "../../src/herdctl.js";
import type { PaddockConfig } from "../../src/config.js";

/**
 * A faithful-enough model of Claude Code's Bash permission matching for our
 * patterns: `Bash(body)` where a trailing `*` in `body` is a prefix wildcard
 * (matches any command starting with the text before the `*`), and a `body`
 * without a `*` is an exact-command match. Every pattern in KEEPER_DENIED_TOOLS
 * uses only a trailing `*`, so this captures the real semantics for this set.
 */
function bashPatternMatches(pattern: string, command: string): boolean {
  const m = /^Bash\((.*)\)$/.exec(pattern);
  if (!m) return false;
  const body = m[1];
  if (body.endsWith("*")) return command.startsWith(body.slice(0, -1));
  return command === body;
}

const isDenied = (command: string): boolean =>
  KEEPER_DENIED_TOOLS.some((p) => bashPatternMatches(p, command));

describe("KEEPER_DENIED_TOOLS — catastrophic wipes denied (#179)", () => {
  const CATASTROPHIC = [
    "rm -rf /",
    "rm -rf / --no-preserve-root",
    "rm -rf ~",
    "rm -rf ~/",
    "rm -rf $HOME",
    "rm -rf $HOME/",
    "rm -rf /bin",
    "rm -rf /boot",
    "rm -rf /dev",
    "rm -rf /etc",
    "rm -rf /home",
    "rm -rf /lib",
    "rm -rf /lib64",
    "rm -rf /opt",
    "rm -rf /proc",
    "rm -rf /root",
    "rm -rf /sbin",
    "rm -rf /srv",
    "rm -rf /sys",
    "rm -rf /usr",
    "rm -rf /var",
    "sudo rm -rf /home/someone",
    "chmod 777 /etc/shadow",
  ];
  it.each(CATASTROPHIC)("denies %j", (cmd) => {
    expect(isDenied(cmd)).toBe(true);
  });
});

describe("KEEPER_DENIED_TOOLS — legitimate absolute-path cleanup NOT denied (#179)", () => {
  // Exactly the real cleanups the over-broad rule used to block (issue evidence).
  const LEGITIMATE = [
    "rm -rf /tmp/foo",
    "rm -rf /tmp",
    "rm -rf /var/lib/paddock/projects/clones/paddock-meter",
    "rm -rf /var/lib/paddock-servers/paddock-meter",
    "rm -rf /var/lib/paddock/projects/clones/x",
    "cd /var/lib/paddock/projects && rm -rf clones/paddock-meter",
    "rm -rf /home/user/project/node_modules",
    "rm -rf /usr/local/share/whatever", // deliberate gap (see doc-comment): not denied
    "rm -rf ./clones/x",
  ];
  it.each(LEGITIMATE)("allows %j", (cmd) => {
    expect(isDenied(cmd)).toBe(false);
  });
});

describe("KEEPER_DENIED_TOOLS — shape/regression guards (#179)", () => {
  it("no longer contains the over-broad `Bash(rm -rf /*)` prefix rule", () => {
    expect(KEEPER_DENIED_TOOLS).not.toContain("Bash(rm -rf /*)");
  });

  it("keeps the sudo and chmod-777 rules unchanged", () => {
    expect(KEEPER_DENIED_TOOLS).toContain("Bash(sudo *)");
    expect(KEEPER_DENIED_TOOLS).toContain("Bash(chmod 777 *)");
  });

  it("no pattern is a bare `rm -rf /<x>` trailing-wildcard prefix that would re-block subpath deletes", () => {
    const leaky = KEEPER_DENIED_TOOLS.filter((p) => {
      const m = /^Bash\((.*)\)$/.exec(p);
      if (!m) return false;
      const body = m[1];
      // A `rm -rf /...*` prefix (other than the space-guarded `rm -rf / *`) would
      // re-introduce the #179 over-broad behaviour for absolute subpaths.
      return body.startsWith("rm -rf /") && body.endsWith("*") && body !== "rm -rf / *";
    });
    expect(leaky).toEqual([]);
  });
});

describe("generated herdctl.yaml emits the narrowed denied_tools end-to-end (#179)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paddock-deny-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes defaults.denied_tools == KEEPER_DENIED_TOOLS (and not the old rule)", async () => {
    const herdctlConfigPath = path.join(dir, "herdctl.yaml");
    const scratchDir = path.join(dir, "scratch");
    const svc = new HerdctlService({ herdctlConfigPath, scratchDir } as PaddockConfig);

    // ensureConfigFile is private; it only touches these two cfg fields.
    await (svc as unknown as { ensureConfigFile(): Promise<void> }).ensureConfigFile();

    const doc = YAML.parse(await fs.readFile(herdctlConfigPath, "utf8")) as {
      defaults: { denied_tools: string[] };
    };
    expect(doc.defaults.denied_tools).toEqual([...KEEPER_DENIED_TOOLS]);
    expect(doc.defaults.denied_tools).not.toContain("Bash(rm -rf /*)");
    // Spot-check the real-world cases from the issue against the emitted set.
    const emitted = doc.defaults.denied_tools;
    const matches = (cmd: string) => emitted.some((p) => bashPatternMatches(p, cmd));
    expect(matches("rm -rf /")).toBe(true);
    expect(matches("rm -rf /var/lib/paddock/projects/clones/paddock-meter")).toBe(false);
  });
});
