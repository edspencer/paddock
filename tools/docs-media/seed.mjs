#!/usr/bin/env node
/**
 * Re-runnable seed for the docs media rig.
 *
 * The point of this file is that re-shooting after a design overhaul is a
 * RE-RUN, not a rebuild. Nothing here is hand-clicked.
 *
 * Everything is synthetic. No production data is copied, so there is nothing to
 * scrub and no title to fictionalise after the fact — the names below are the
 * only names the rig has ever seen.
 *
 * Env:
 *   PADDOCK_RIG_HOME   required — the rig scratch root (same var as serve.sh)
 *   PADDOCK_RIG_BASE   instance URL (default http://127.0.0.1:4000)
 *
 * Usage:  node seed.mjs [--base http://127.0.0.1:PORT]
 */
import { mkdirSync, writeFileSync, utimesSync as fsUtimes } from "node:fs";
import path from "node:path";

const RIG = process.env.PADDOCK_RIG_HOME;
if (!RIG) {
  console.error("set PADDOCK_RIG_HOME (the rig scratch root — the same value serve.sh uses)");
  process.exit(1);
}

const argBase = process.argv.indexOf("--base");
// Default matches capture.mjs. The two files disagreeing on a default port is
// itself a bug, so they are kept identical here deliberately.
const BASE =
  argBase > -1 ? process.argv[argBase + 1] : process.env.PADDOCK_RIG_BASE || "http://127.0.0.1:4000";
const API = `${BASE}/api`;

// --- guard: refuse to seed anything that is not the rig ---------------------
// `pm status: online` and `/api/health: 200` are both satisfied by a stale
// squatter on the same port; a seeding run has already written into the wrong
// instance that way. Check identity, not liveness.
//
// Identity is the DATA DIR, not the projects dir: the projects dir is
// deliberately relocated to a presentable synthetic path that another instance
// could plausibly share, whereas the data dir is unique to this rig. Also
// assert driveMode=batch — a `session` instance here would mean the fake
// `claude` is being ignored and real credit is being spent.
let PROJECTS_DIR = null;
async function assertIsRig() {
  const r = await fetch(`${API}/instance-config`);
  if (!r.ok) throw new Error(`no instance at ${BASE} (${r.status})`);
  const cfg = await r.json();
  const field = (k) => cfg.groups?.flatMap((g) => g.fields ?? []).find((f) => f.key === k)?.value;
  const dataDir = field("dataDir");
  const driveMode = field("driveMode");
  if (dataDir !== `${RIG}/data`) {
    throw new Error(
      `REFUSING TO SEED: ${BASE} reports dataDir=${dataDir}, not ${RIG}/data. ` +
        `That is somebody else's instance — a stale squatter satisfies both ` +
        `\`pm status: online\` and \`/api/health: 200\`.`,
    );
  }
  if (driveMode !== "batch") {
    throw new Error(`REFUSING TO SEED: driveMode=${driveMode}, expected batch (real credit risk)`);
  }
  // Read the projects root back off the running server rather than hard-coding
  // it a second time — the previous version of this file duplicated the path
  // and the two could silently disagree.
  PROJECTS_DIR = field("projectsDir") || `${RIG}/projects`;
  console.log(`✓ verified ${BASE} is the rig (dataDir=${dataDir}, driveMode=${driveMode})`);
  console.log(`  projects root: ${PROJECTS_DIR}`);
}

const j = async (method, url, body) => {
  const r = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

// --- the cast ---------------------------------------------------------------
// Fictional throughout: a small consultancy's internal tooling. Plausible
// enough to read as real work, invented enough that no title is a signal.
//
// `area` gives the projects grid something to group by — two areas, so the
// grouped layout actually has more than one heading.
const PROJECTS = [
  {
    name: "Tidepool",
    slug: "tidepool",
    summary: "Ingest and normalise tide-gauge readings from the coastal sensor network.",
    domain: ["data", "ingest"],
    group: "Platform",
  },
  {
    name: "Lanternfish",
    slug: "lanternfish",
    summary: "Scheduling service for the overnight batch fleet.",
    domain: ["infra"],
    group: "Platform",
  },
  {
    name: "Harbour Notes",
    slug: "harbour-notes",
    summary: "Research notebook — survey methods, references, meeting notes.",
    domain: ["research"],
    group: "Research",
  },
];

// A disabled curate-overview trigger, set BEFORE seeding. The rig runs a real
// keeper, so a completed turn enqueues a sweep and the sweeper replaces
// OVERVIEW.md/CHANGELOG.md wholesale — which is how a previous pass lost its
// demo OVERVIEW between seeding and shooting.
// NB: `run` is REQUIRED — a two-key definition (trigger + enabled) is rejected
// with a bare {"error":"Invalid trigger definition"} that does not say which
// key is missing.
const DISABLED_CURATION = {
  trigger: { type: "event", on: "afterTurn" },
  run: { prompt: "disabled placeholder — this trigger exists only to be off" },
  enabled: false,
};

async function seedProjects() {
  for (const p of PROJECTS) {
    // No `repo:` and no `path:` — nothing in this rig may reach a real
    // repository or a directory outside its own scratch tree.
    await j("POST", `${API}/projects`, {
      name: p.name,
      slug: p.slug,
      summary: p.summary,
      domain: p.domain,
      group: p.group,
    }).catch((e) => {
      if (!String(e).includes("exists")) throw e;
      console.log(`  (${p.slug} already exists)`);
    });
    console.log(`✓ project ${p.slug}`);

    await j("PUT", `${API}/projects/${p.slug}/triggers/curate-overview`, DISABLED_CURATION).catch(
      (e) => console.log(`  ! trigger on ${p.slug}: ${String(e).slice(0, 120)}`),
    );
  }

  // The root workspace curates too — the sweeper skips only when THIS
  // workspace's trigger is disabled, so root needs its own.
  await j("PUT", `${API}/root/triggers/curate-overview`, DISABLED_CURATION);
  console.log("✓ curation disabled on all workspaces incl. root");
}

// ---------------------------------------------------------------------------
// Adoptable native sessions (the adopt-row / adopt-modal / adopted-badge shots).
//
// Recipe verified from source, not guessed:
//   - file lives in <projectDir>/.chats/<sessionId>.jsonl  (the project's OWN
//     source, appended unconditionally at adoptable.ts:569 — no `cwd` field and
//     no git setup needed, unlike the scanned-folder route)
//   - sessionId must match /^[A-Za-z0-9-]+$/ (cli-session-path.js:177)
//   - file must be >= 256 bytes            (adoptable.ts:166,242 `too-small`)
//   - first non-blank line must not be isSidechain:true (jsonl-parser.js:515)
//   - must have NO job-*.yaml and no adopted-sessions record, or the engine
//     classifies it `attributed-to-run` and it never reaches paddock
//
// The on-camera label is resolved custom-title > ai-title > summary > first
// user message (truncated at 100 chars) > raw UUID. We set an explicit
// custom-title so the modal shows a sentence we chose, not a UUID.
// ---------------------------------------------------------------------------
const NATIVE = {
  tidepool: [
    { id: "7c1f9a34-2b60-4e18-9d51-a0c3e7b41d92", title: "Trace the duplicate gauge readings", days: 6 },
    { id: "b48e05c7-9d13-4a72-8f60-1e5cb9270a3f", title: "Rename the ingest CLI flags", days: 3 },
    { id: "e2a76d10-4c85-4b39-a7e2-63f0d81b5c47", title: "Draft the sensor onboarding checklist", days: 1 },
    // The 4th exists so that ADOPTING one (to stage the adopted badge) still
    // leaves THREE adoptable — the count the modal shot wants. Adopt is one-way
    // within a run, so the two shots would otherwise compete for the same
    // fixtures.
    { id: "5d93c8b2-6a41-4e07-b1f8-2c7a0e6d4931", title: "Chase down the missing archive manifest", days: 9 },
  ],
};

/** A transcript that is plausible, comfortably over 256 B, and says nothing. */
function transcript(cwd, title, userText) {
  const lines = [
    { type: "custom-title", customTitle: title },
    { type: "user", cwd, sessionId: "seed", message: { role: "user", content: userText } },
    {
      type: "assistant",
      cwd,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              "Looked through the poller and the archive writer. The duplicate rows come " +
              "from the retry path re-submitting a batch that had already been committed, " +
              "so the fix belongs at the commit boundary rather than in the dedupe pass.",
          },
        ],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function seedNativeSessions() {
  for (const [slug, sessions] of Object.entries(NATIVE)) {
    const projectDir = path.join(PROJECTS_DIR, slug);
    const chats = path.join(projectDir, ".chats");
    mkdirSync(chats, { recursive: true });
    for (const s of sessions) {
      const file = path.join(chats, `${s.id}.jsonl`);
      const body = transcript(
        projectDir,
        s.title,
        "The nightly load is writing some readings twice. Can you work out where the " +
          "duplication is introduced before I touch the dedupe pass?",
      );
      writeFileSync(file, body);
      if (Buffer.byteLength(body) < 256) throw new Error(`${file} under the 256 B floor`);
      // Spread the mtimes so the modal's date column has texture rather than
      // three identical dates. `mtime` is what the modal renders.
      const when = new Date(Date.now() - s.days * 864e5);
      fsUtimes(file, when, when);
    }
    console.log(`✓ ${sessions.length} adoptable native sessions for ${slug}`);
  }
}

async function main() {
  await assertIsRig();
  await seedProjects();
  seedNativeSessions();

  // Prove the state actually rendered rather than assuming the recipe worked.
  const res = await j("GET", `${API}/projects/tidepool/adoptable-chats`);
  console.log(`\nadoptable count = ${res.count} (sources: ${res.sources?.length ?? 0})`);
  if (res.filtered?.length) console.log(`filtered: ${JSON.stringify(res.filtered)}`);
  if (res.count === 0) {
    console.log("!! count is 0 — the adopt row will NOT render. Check the exclusion list.");
  }
  console.log("\nseed complete");
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
