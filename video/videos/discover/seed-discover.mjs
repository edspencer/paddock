#!/usr/bin/env node
/**
 * seed-discover.mjs — give the rig some Claude Code history for /discover to find.
 *
 * `seed.mjs` seeds PROJECTS and their adoptable native sessions. Discovery is a
 * different surface with a different input: it enumerates transcript folders
 * under `<claudeHome>/projects/` and asks which of those directories a human
 * would recognise as a project. So nothing seed.mjs writes can produce a
 * Discover row, and this file exists to fill that gap.
 *
 * Every rule in discover.ts that could eat a candidate, and what is done here
 * to clear it:
 *
 *   no-recorded-cwd   every transcript line carries an explicit `cwd`. The
 *                     folder name is NOT inverted to a path — encodePathForCli
 *                     is lossy (it maps every non-alphanumeric char to `-`, so
 *                     /a/b-c and /a-b/c collide), which is exactly why the cwd
 *                     is read from inside the file.
 *   missing           the directories are really created.
 *   system-path       they sit well below any denylisted root.
 *   temp-root         not under /tmp or $TMPDIR.
 *   paddock-internal  under $RIG/home, which is neither the projects root
 *                     ($RIG/projects) nor the data dir ($RIG/data) nor either
 *                     Claude home.
 *   home-root         one level down from $HOME, not $HOME itself.
 *   outside-home      inside $HOME, so the soft rule does not fire.
 *   already-managed   no seeded project points at any of them.
 *   no-git            each gets a real `git init`, so the soft rule does not
 *                     fire and the row renders without a toggle being flipped.
 *   no-sessions       each transcript clears MIN_TRANSCRIPT_BYTES (256) with
 *                     room to spare and is not a sweeper/curation session.
 *
 * Everything is fictional — the same invented consultancy as seed.mjs, so the
 * two are consistent on camera.
 *
 * Env: PADDOCK_RIG_HOME (required), PADDOCK_RIG_BASE
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import path from "node:path";

const RIG = process.env.PADDOCK_RIG_HOME;
if (!RIG) {
  console.error("set PADDOCK_RIG_HOME");
  process.exit(1);
}
const BASE = process.env.PADDOCK_RIG_BASE || "http://127.0.0.1:5069";
/**
 * Must match the running server's HOME, because the candidate paths are the
 * largest text on the /discover screen and a host path there is unmaskable —
 * it IS the subject. See launch-discover.sh for why the home moves to a
 * presentable location while the data dir stays on persistent storage.
 * Read back from the API rather than assumed, below.
 */
const HOME = process.env.PADDOCK_RIG_DEMO_HOME || `${RIG}/home`;
const CLAUDE_PROJECTS = `${RIG}/data/claude-home/projects`;

/** Mirror of encodePathForCli: every non-alphanumeric character becomes `-`. */
const encode = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * The candidates. Three, not one: the list is the subject of the shot, and a
 * single row does not read as "it found your history". Chat counts differ so
 * the count column has something to say, and the dates are spread so the
 * "last active" column is not three identical strings.
 */
const DIRS = [
  {
    dir: `${HOME}/code/harbour-charts`,
    sessions: [
      { title: "Rework the depth-contour renderer", days: 1 },
      { title: "Why does the legend clip at 1024px?", days: 2 },
      { title: "Port the tile cache to the new store", days: 5 },
      { title: "Audit the chart projection maths", days: 9 },
    ],
  },
  {
    dir: `${HOME}/code/sensor-net`,
    sessions: [
      { title: "Backfill the gauge calibration table", days: 3 },
      { title: "Retry policy for the flaky uplink", days: 8 },
      { title: "Trim the telemetry payload", days: 14 },
    ],
  },
  {
    dir: `${HOME}/code/tide-atlas`,
    sessions: [
      { title: "Draft the almanac export format", days: 6 },
      { title: "Split the seed data by region", days: 21 },
    ],
  },
];

/** Comfortably over the 256-byte floor, and says nothing about anything real. */
function transcript(cwd, title) {
  const lines = [
    { type: "custom-title", customTitle: title },
    {
      type: "user",
      cwd,
      sessionId: "seed",
      message: { role: "user", content: `${title}. Have a look and tell me what you find.` },
    },
    {
      type: "assistant",
      cwd,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              "Read through the module and its tests. The behaviour you are describing comes " +
              "from the boundary case being handled twice — once on the way in and again in " +
              "the normalise step — so the second pass sees values it was never meant to see. " +
              "Fixing it at the boundary is smaller than unpicking the normalise pass.",
          },
        ],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/**
 * Deterministic UUID-shaped ids.
 *
 * The UUID SHAPE IS LOAD-BEARING, not cosmetic, and the failure it prevents is
 * the quietest one in this whole pipeline. Discovery's noise filter accepts any
 * filename — an earlier version of this seeder used ids containing `g`, `i` and
 * `u`, and `/discover` cheerfully listed the right directories with the right
 * conversation counts. But IMPORT copies chats through the adoptable path,
 * which validates the session-id charset, so every one of them was dropped:
 * the projects were created with ZERO chats.
 *
 * Nothing errors. The candidate list, the counts and the import all look
 * correct, and only the destination is empty — so a clip shot against it would
 * have carried a closing caption promising conversations that the final frames
 * disprove. Verify the DESTINATION after an import, not just the candidate list.
 *
 * SEED_OFFSET exists because import is one-way in a way that outlives the
 * project: adopting writes an adopted-sessions record keyed on session id, so
 * after an import those ids are classified `attributed-to-run` and never come
 * back as candidates — even if you delete the imported project. Re-seeding with
 * a fresh offset gives genuinely new sessions and restores the empty-instance
 * state that the `land` and `choose` shots need.
 */
const uuid = (n0) => {
  const n = n0 + Number(process.env.SEED_OFFSET || 0);
  const h = n.toString(16).padStart(4, "0");
  return `d15c0${h}-4a1b-4c2d-8e3f-${h}0a1b2c3d4e5`.slice(0, 36);
};

let n = 0;
for (const { dir, sessions } of DIRS) {
  mkdirSync(dir, { recursive: true });
  // A real repo, so the `no-git` soft rule never fires. `git init -q` only —
  // no remote, no commits needed, nothing that could reach a real repository.
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  } catch (e) {
    console.error(`git init failed in ${dir}: ${e.message}`);
  }
  writeFileSync(path.join(dir, "README.md"), `# ${path.basename(dir)}\n`);

  const folder = path.join(CLAUDE_PROJECTS, encode(dir));
  mkdirSync(folder, { recursive: true });
  for (const s of sessions) {
    const file = path.join(folder, `${uuid(n++)}.jsonl`);
    const body = transcript(dir, s.title);
    if (Buffer.byteLength(body) < 256) throw new Error(`${file} under the 256 B floor`);
    writeFileSync(file, body);
    const when = new Date(Date.now() - s.days * 864e5);
    utimesSync(file, when, when);
  }
  console.log(`✓ ${sessions.length} sessions for ${dir}`);
}

// Prove it rendered rather than assuming the recipe worked — the same discipline
// seed.mjs applies to its adoptable count.
const r = await fetch(`${BASE}/api/discover`);
if (!r.ok) {
  console.error(`GET /api/discover -> ${r.status}`);
  process.exit(1);
}
const d = await r.json();
console.log(`\ncandidates = ${d.candidates?.length ?? 0}`);
for (const c of d.candidates ?? []) console.log(`  ${c.dir}  sessions=${c.sessionCount ?? "?"}`);
console.log(`excluded: ${JSON.stringify(d.excluded ?? {})}`);
if (!d.candidates?.length) console.log("\n!! zero candidates — /discover will render empty");
