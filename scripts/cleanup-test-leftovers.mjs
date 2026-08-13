#!/usr/bin/env node
/**
 * Dev-box cleanup for leaked E2E fixture servers (#788 remedy D1).
 *
 * Scope, stated up front because it is narrow: this reaches **class A only** —
 * live orphaned `test/e2e/server.mjs` fixture servers and the paddock server
 * each one spawns. It cannot help the other two populations, and pretending
 * otherwise is how the original investigation confused itself:
 *
 *   * **Zombies (class B)** ignore signals by definition — they are already
 *     dead and waiting for a `wait()` nobody calls. Only an init as PID 1
 *     (tini, shipped in #794) clears them. This script COUNTS them and kills
 *     none.
 *   * **Live browsers (class C)** may well be in use by a suite running right
 *     now in another session. Killing those breaks someone else's run, so they
 *     are never touched.
 *
 * Since #793 armed the orphan watchdog inside the fixture itself, a fresh leak
 * should be rare — the launcher now notices its grandparent dying and takes its
 * own process group down. This script is for leftovers that predate that fix,
 * for a watchdog that was somehow outrun, and as the census tool the issue asks
 * for.
 *
 * ── Why identification is by /proc and NOT by pattern ──────────────────────
 *
 * The rule is already written down in `scripts/demo-gif/shoot.mjs`: never
 * pattern-match and kill "stray" Paddock processes. A dev box runs many paddock
 * instances sharing one command line — production included — and on the
 * container that motivated #788 **PID 1 is itself a live paddock server**. A
 * `pkill -f paddock` there is an outage, and has caused one.
 *
 * So a process is a candidate only when its OWN environment, read out of
 * `/proc/<pid>/environ`, says it is a throwaway fixture:
 *
 *   1. `PADDOCK_DATA_DIR` is set, and
 *   2. it resolves INSIDE the OS temp dir, and
 *   3. the temp component is the fixture's own `paddock-e2e-` prefix
 *      (`server.mjs`: `mkdtempSync(path.join(os.tmpdir(), "paddock-e2e-"))`).
 *
 * A real instance's data dir is `~/.paddock` or `/var/lib/paddock/...`, never
 * `/tmp/paddock-e2e-*`, so no production process can satisfy this no matter what
 * its command line looks like. PID 1 is additionally refused outright, as are
 * this script's own process and its ancestors.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   node scripts/cleanup-test-leftovers.mjs            # census + dry run
 *   node scripts/cleanup-test-leftovers.mjs --kill     # actually kill them
 *
 * Dry run is the default on purpose: the first thing you want on a sick box is
 * the census, and `--kill` should be a decision rather than a reflex.
 */
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const KILL = process.argv.includes("--kill");

if (process.platform !== "linux") {
  console.error(`This script reads /proc, so it is Linux-only (platform: ${process.platform}).`);
  process.exit(1);
}

/** `/proc/<pid>/stat`, parsed past the LAST ')' — a comm can contain spaces and parens. */
function stat(pid) {
  try {
    const rest = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^[\s\S]*\) /, "");
    const f = rest.split(" ");
    return { state: f[0], ppid: Number(f[1]) };
  } catch {
    return null;
  }
}

/** Resident set size in KB. A zombie has no VmRSS line and contributes exactly 0. */
function rssKb(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** NUL-delimited `/proc/<pid>/environ` → a plain object. Unreadable (not ours) → null. */
function environ(pid) {
  try {
    const out = {};
    for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  } catch {
    return null;
  }
}

function comm(pid) {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "?";
  }
}

const TMP = path.resolve(os.tmpdir());
const FIXTURE_PREFIX = "paddock-e2e-";

/**
 * The single containment test. True only for a data dir that really sits under
 * the OS temp dir in a `paddock-e2e-*` directory — resolved first, and compared
 * with a trailing separator so `/tmp/paddock-e2e-evil-suffix` cannot pass by
 * being a string prefix of nothing meaningful.
 */
function isFixtureDataDir(dir) {
  if (!dir) return false;
  const resolved = path.resolve(dir);
  if (resolved !== TMP && !resolved.startsWith(TMP + path.sep)) return false;
  const [first] = path.relative(TMP, resolved).split(path.sep);
  return first !== undefined && first.startsWith(FIXTURE_PREFIX);
}

/** Every ancestor of this process, so we can never kill the shell that ran us. */
function ancestry() {
  const chain = new Set();
  let pid = process.pid;
  while (pid > 1 && !chain.has(pid)) {
    chain.add(pid);
    const s = stat(pid);
    if (!s) break;
    pid = s.ppid;
  }
  return chain;
}

const SELF = ancestry();
const pids = readdirSync("/proc")
  .filter((n) => /^\d+$/.test(n))
  .map(Number);

const census = new Map(); // "state comm" -> { count, rssKb }
const candidates = [];

for (const pid of pids) {
  const s = stat(pid);
  if (!s) continue; // exited while we walked

  const name = comm(pid);
  const rss = rssKb(pid);
  const key = `${s.state} ${name}`;
  const seen = census.get(key) ?? { count: 0, rssKb: 0 };
  census.set(key, { count: seen.count + 1, rssKb: seen.rssKb + rss });

  if (pid === 1 || SELF.has(pid)) continue;
  if (s.state === "Z") continue; // a zombie cannot be killed; tini (#794) reaps these

  const env = environ(pid);
  if (!env || !isFixtureDataDir(env.PADDOCK_DATA_DIR)) continue;

  candidates.push({ pid, name, rssKb: rss, state: s.state, dataDir: env.PADDOCK_DATA_DIR });
}

// ── census ────────────────────────────────────────────────────────────────
// Report state AND summed RSS together: a large count with ~0 RSS is zombies,
// a large RSS proves live processes. Counting without `State:` conflates them,
// which is the exact mistake both #788 investigations made from opposite sides.
console.log("\nProcess census (state · comm · count · total RSS)\n");
const rows = [...census.entries()].sort((a, b) => b[1].rssKb - a[1].rssKb).slice(0, 15);
for (const [key, v] of rows) {
  console.log(`  ${key.padEnd(28)} ${String(v.count).padStart(4)}  ${mb(v.rssKb).padStart(9)}`);
}
const zombies = [...census.entries()]
  .filter(([k]) => k.startsWith("Z "))
  .reduce((n, [, v]) => n + v.count, 0);
console.log(`\n  total processes: ${pids.length}   zombies: ${zombies} (need an init, not a kill)`);

// ── candidates ────────────────────────────────────────────────────────────
if (candidates.length === 0) {
  console.log("\nNo leaked E2E fixture processes found.\n");
  process.exit(0);
}

const leaked = candidates.reduce((n, c) => n + c.rssKb, 0);
console.log(`\nLeaked E2E fixture processes: ${candidates.length}, holding ${mb(leaked)}\n`);
for (const c of candidates) {
  console.log(`  pid ${String(c.pid).padStart(7)}  ${c.name.padEnd(16)} ${mb(c.rssKb).padStart(9)}  ${c.dataDir}`);
}

if (!KILL) {
  console.log("\nDry run. Re-run with --kill to terminate these by PID.\n");
  process.exit(0);
}

console.log("");
let killed = 0;
for (const c of candidates) {
  // Re-verify immediately before signalling: PIDs are recycled, and this scan
  // is not atomic. Never widen this to a group kill — a fixture server leads
  // its own group, but so does plenty else we have no business touching.
  const env = environ(c.pid);
  if (!env || !isFixtureDataDir(env.PADDOCK_DATA_DIR)) {
    console.log(`  pid ${c.pid}: changed identity since the scan — skipped`);
    continue;
  }
  try {
    process.kill(c.pid, "SIGKILL");
    killed++;
    console.log(`  pid ${c.pid}: killed`);
  } catch (err) {
    console.log(`  pid ${c.pid}: ${err.code ?? err.message}`);
  }
}
console.log(`\nKilled ${killed} of ${candidates.length}.\n`);

function mb(kb) {
  return `${(kb / 1024).toFixed(1)} MB`;
}
