#!/usr/bin/env node
/**
 * seed.mjs — stage a throwaway, fully synthetic Paddock data dir for the demo.
 *
 *   node scripts/demo-gif/seed.mjs --out /tmp/paddock-demo [--now <ISO>]
 *
 * Everything it writes is invented (see fixtures.mjs). The output is a complete
 * `PADDOCK_DATA_DIR` that serve.mjs can boot against: projects, chats with rich
 * tool blocks, a finished sub-agent, triggers, job records, read state, and a
 * real git repo so the Changes tab has a diff.
 *
 * ── Ordering constraints that are not obvious ───────────────────────────────
 *
 *  • SEED BEFORE BOOT. herdctl caches both the attribution index and the
 *    session-file listing for 30s. Writing chats into a running instance means
 *    waiting up to half a minute for them to appear — or, more likely, quietly
 *    shooting a stale UI.
 *
 *  • A chat with no job record is INVISIBLE. Session discovery gates every
 *    transcript on an attribution record naming the owning agent, and an
 *    unattributed session resolves to `agentName: undefined`. So every
 *    transcript here gets a matching `.herdctl/jobs/job-*.yaml` whose `agent` is
 *    `keeper-<slug>` (`keeper-_root` for the root workspace).
 *
 *  • We do NOT create the `~/.claude/projects/<mangled-cwd>` discovery symlinks.
 *    The server creates them itself for every workspace during `herdctl.init()`,
 *    idempotently. Duplicating that here just risks drifting from its mangling
 *    rule.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ROOT_WORKSPACE,
  PROJECTS,
  RENDER_TS_BASELINE,
  RENDER_TS_WORKING,
  RENDER_TS_HUNKS,
  FAKE_SCRIPT,
} from "./fixtures.mjs";
import { palettePreviewPNG } from "./lib/png.mjs";
import {
  makeIds,
  clock,
  usage,
  userLine,
  assistantText,
  toolCall,
  editResult,
  readImageResult,
  grepResult,
  bashResult,
} from "./lib/transcript.mjs";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const OUT = path.resolve(arg("out", "/tmp/paddock-demo"));
const NOW = new Date(arg("now", new Date().toISOString()));

const DATA = path.join(OUT, "data");
const HOME = path.join(OUT, "home");
const PROJECTS_ROOT = path.join(DATA, "projects");
const JOBS_DIR = path.join(DATA, ".herdctl", "jobs");

const ids = makeIds("paddock-demo-v1");
const write = (p, s) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s, "utf8");
};
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000);
const iso = (d) => d.toISOString();

// ── project.yaml ────────────────────────────────────────────────────────────
const yamlStr = (s) => JSON.stringify(s);

function projectYaml(p, updated) {
  const L = [
    "# Paddock project metadata. Directory name MUST equal `slug`.",
    "# status: idea | active | paused | blocked | done | abandoned",
    `name: ${yamlStr(p.name)}`,
    `slug: ${p.slug}`,
    `status: ${p.status}`,
  ];
  L.push(p.domain?.length ? `domain:\n${p.domain.map((d) => `  - ${d}`).join("\n")}` : "domain: []");
  if (p.group) L.push(`group: ${p.group}`);
  L.push("visibility: public");
  L.push(`started: ${p.started}`);
  L.push(`updated: ${updated}`);
  L.push(`summary: ${yamlStr(p.summary)}`);
  L.push("links: []");
  L.push("pinned: []");
  // The context meter's denominator comes from the PROJECT's model, not the
  // model recorded on the transcript — so this is what makes the meter read
  // "/ 1M" rather than falling back to the 200k unknown-model default.
  if (p.model) L.push(`model: ${p.model}`);
  if (p.triggers) {
    L.push("triggers:");
    for (const [name, t] of Object.entries(p.triggers)) {
      L.push(`  ${name}:`);
      L.push("    trigger:");
      L.push(`      type: ${t.trigger.type}`);
      if (t.trigger.cron) L.push(`      cron: ${yamlStr(t.trigger.cron)}`);
      if (t.trigger.interval) L.push(`      interval: ${yamlStr(t.trigger.interval)}`);
      if (t.trigger.on) L.push(`      on: ${yamlStr(t.trigger.on)}`);
      L.push("    run:");
      if (t.run.promptFile) L.push(`      promptFile: ${yamlStr(t.run.promptFile)}`);
      if (t.run.prompt) L.push(`      prompt: ${yamlStr(t.run.prompt)}`);
      if (t.run.session) L.push(`      session: ${t.run.session}`);
      if (t.run.tools) L.push(`      tools: [${t.run.tools.join(", ")}]`);
      if (t.run.maxTurns) L.push(`      maxTurns: ${t.run.maxTurns}`);
      L.push(`    enabled: ${t.enabled ? "true" : "false"}`);
    }
  }
  return `${L.join("\n")}\n`;
}

// ── job records (attribution — without these a chat is invisible) ────────────
const jobs = [];
function recordJob({ sessionId, slug, startedAt, finishedAt, triggerType = "web" }) {
  const date = iso(startedAt).slice(0, 10);
  // The `id` is zod-validated as job-YYYY-MM-DD-[a-z0-9]{6}; a bad id is
  // dropped as a corrupt record and the chat vanishes with no error.
  const suffix = sessionId.replace(/-/g, "").slice(0, 6).toLowerCase();
  const id = `job-${date}-${suffix}`;
  const outputFile = path.join(JOBS_DIR, `${id}.jsonl`);
  const agent = slug === "" ? "keeper-_root" : `keeper-${slug}`;
  const lines = [
    `id: ${id}`,
    `agent: ${agent}`,
    "schedule: null",
    `trigger_type: ${triggerType}`,
    "status: completed",
    "exit_reason: success",
    `session_id: ${sessionId}`,
    "forked_from: null",
    `started_at: ${iso(startedAt)}`,
    `finished_at: ${iso(finishedAt)}`,
    `duration_seconds: ${Math.max(1, Math.round((finishedAt - startedAt) / 1000))}`,
    `output_file: ${outputFile}`,
    "",
  ];
  write(path.join(JOBS_DIR, `${id}.yaml`), lines.join("\n"));
  write(outputFile, "");
  jobs.push({ sessionId, agent, finishedAt });
}

// ── chat helpers ────────────────────────────────────────────────────────────
const chats = [];

/** Register a chat: write its transcript, its job record, and remember whether
 *  it should read as unread (unread = simply having no read-state entry). */
function addChat({ slug, dir, label, body, startedAt, durationMin = 4, unread = false, triggerType }) {
  const sessionId = ids.uuid(`chat:${slug}:${label}`);
  const finishedAt = new Date(startedAt.getTime() + durationMin * 60_000);
  const ctx = {
    sessionId,
    cwd: dir,
    model: "claude-opus-5",
    ids,
    clock: clock(iso(startedAt)),
    gitBranch: "main",
  };
  const text = body(ctx, sessionId);
  write(path.join(dir, ".chats", `${sessionId}.jsonl`), text);
  recordJob({ sessionId, slug, startedAt, finishedAt, triggerType });
  chats.push({ sessionId, slug, label, unread, finishedAt });
  // Chat-list ordering is by transcript mtime, not by the timestamps inside it.
  const t = finishedAt;
  fs.utimesSync(path.join(dir, ".chats", `${sessionId}.jsonl`), t, t);
  return sessionId;
}

/** A short two-turn chat — enough to populate a list and carry an unread cue. */
const simpleChat = (prompt, reply) => (ctx) =>
  userLine(ctx, prompt) +
  assistantText(ctx, reply, usage(9_400, 260, 31_000, 2_100), 45_000);

// ── the star chat: every tool renderer in one transcript ─────────────────────
function starChat(projectDir) {
  return (ctx, sessionId) => {
    const previewPath = path.join(projectDir, "assets", "palette-preview.png");
    const renderPath = path.join(projectDir, "src", "render.ts");
    const taskId = ids.toolId("star:task");
    let out = "";

    out += userLine(
      ctx,
      "Add a 256-colour fallback for terminals without truecolor, and check the default palette still clears WCAG AA.",
    );
    out += assistantText(
      ctx,
      "I'll add a graceful 256-colour fallback. Plan:\n\n1. Map how colour flows through the renderer today.\n2. Add a nearest-cube quantiser for the 256-colour path.\n3. Re-check contrast so every foreground/background pair still clears WCAG AA (4.5:1).\n\nLet me start by sending a sub-agent to map the colour pipeline, since it touches a few files.",
      usage(14_200, 240, 41_000, 5_200),
    );

    // ── the sub-agent card. `subagent_type` labels it; `description` is the
    //    subtitle. The paired result plus a sibling meta.json + transcript is
    //    what makes it render finished, with a duration and a cost.
    out += toolCall(ctx, {
      name: "Task",
      id: taskId,
      input: {
        subagent_type: "general-purpose",
        description: "Map the colour pipeline",
        prompt:
          "Find every place a colour is converted or emitted in src/, and report the call graph from parseSeed down to the ANSI writer.",
      },
      content:
        "The colour pipeline is: parseSeed → buildPalette → contrastCheck → emitColor. Only emitColor writes ANSI escapes (src/render.ts:5). src/theme.ts formats but never converts.",
      use: usage(14_400, 180, 41_200, 0),
      // Kept in step with the sub-agent transcript's own first→last span below —
      // the card displays THAT figure (#605), so a mismatch here would be a
      // number nobody sees but every future reader has to reconcile.
      durationMs: 62_800,
    });

    out += assistantText(
      ctx,
      "`emitColor` in `src/render.ts` is the only place that writes escapes, so the fallback belongs there. Let me confirm nothing else emits truecolor directly.",
      usage(18_900, 200, 62_400, 3_100),
    );

    out += toolCall(ctx, {
      name: "Grep",
      id: ids.toolId("star:grep"),
      input: { pattern: "\\x1b\\[38;2;", output_mode: "content", "-n": true },
      content:
        "src/render.ts:11:  return `\\x1b[${lead};2;${r};${g};${b}m`;\nsrc/theme.ts:71:  // truecolor sample used by --preview\nsrc/theme.ts:74:    lines.push(`\\x1b[38;2;${r};${g};${b}m██`);",
      result: grepResult(2, 6, ["src/render.ts", "src/theme.ts"]),
      use: usage(19_100, 90, 63_000, 0),
      durationMs: 900,
    });

    out += assistantText(
      ctx,
      "Two call sites, and the one in `theme.ts` is only the `--preview` sample. Here's the current palette preview so I keep the same swatch order in the fallback:",
      usage(21_600, 150, 71_800, 2_400),
    );

    // Read of a real PNG inside the project dir → rendered inline.
    out += toolCall(ctx, {
      name: "Read",
      id: ids.toolId("star:read"),
      input: { file_path: previewPath },
      content: "Read image palette-preview.png (656x140)",
      result: readImageResult(),
      use: usage(21_800, 60, 72_100, 0),
      durationMs: 700,
    });

    out += assistantText(
      ctx,
      "Sixteen swatches in ANSI order — normal on top, bright underneath. Now the fallback branch: quantise each channel to the nearest entry of the 6×6×6 cube whenever `COLORTERM` isn't truecolor.",
      usage(24_900, 210, 84_200, 4_600),
    );

    out += toolCall(ctx, {
      name: "Edit",
      id: ids.toolId("star:edit"),
      input: { file_path: renderPath },
      content: "The file src/render.ts has been updated.",
      result: editResult(renderPath, RENDER_TS_HUNKS),
      use: usage(25_100, 120, 84_900, 0),
      durationMs: 1_500,
    });

    out += assistantText(
      ctx,
      "Fallback is in. Running the suite to make sure both colour paths and the contrast checks still pass.",
      usage(28_400, 140, 96_300, 3_200),
    );

    out += toolCall(ctx, {
      name: "Bash",
      id: ids.toolId("star:test"),
      input: { command: "npm test", description: "Run the test suite" },
      content: "Test Files  6 passed (6)\n     Tests  48 passed (48)",
      result: bashResult({
        stdout:
          "> lumen@0.9.2 test\n> vitest run\n\n Test Files  6 passed (6)\n      Tests  48 passed (48)\n   Duration  1.92s",
        stderr:
          "stderr | src/theme.test.ts\n(node:48211) [DEP0180] DeprecationWarning: chalk.level is deprecated",
        returnCodeInterpretation: "Exit code 0 — all 48 tests passed",
      }),
      use: usage(28_600, 80, 96_800, 0),
      durationMs: 2_100,
    });

    out += toolCall(ctx, {
      name: "Bash",
      id: ids.toolId("star:push"),
      input: { command: "git push origin main", description: "Push the fallback" },
      content: "Everything up-to-date",
      result: bashResult({
        stdout: "",
        stderr: "To github.com:example/lumen.git\n   9f3a1c2..b7e40d5  main -> main",
        gitOperation: { push: { branch: "main" } },
      }),
      use: usage(31_200, 90, 108_400, 0),
      durationMs: 1_800,
    });

    out += assistantText(
      ctx,
      "Done. The 256-colour fallback is in and every pair still clears WCAG AA (4.5:1):\n\n- `emitColor` quantises to the nearest 6×6×6 cube entry when the terminal lacks truecolor.\n- The `--preview` sample in `theme.ts` was left on the truecolor path deliberately — it only ever runs interactively.\n- All 48 tests pass; the one stderr line is a harmless `chalk.level` deprecation warning.\n\nWant me to add a `--no-truecolor` flag so the fallback can be forced for testing?",
      usage(33_800, 940, 118_600, 5_100),
    );

    // ── the sub-agent's own transcript + meta sidecar ────────────────────────
    const agentId = ids.agentId("star:task");
    const subDir = path.join(projectDir, ".chats", sessionId, "subagents");
    write(
      path.join(subDir, `${agentId}.meta.json`),
      `${JSON.stringify(
        {
          agentType: "general-purpose",
          description: "Map the colour pipeline",
          // The ONLY link back to the parent card is this tool_use id.
          toolUseId: taskId,
          spawnDepth: 1,
        },
        null,
        2,
      )}\n`,
    );

    const sctx = {
      sessionId: `${sessionId}-sub`,
      cwd: projectDir,
      model: "claude-opus-5",
      ids,
      clock: clock(iso(new Date(Date.parse(iso(NOW)) - 3600_000))),
      gitBranch: "main",
    };
    let sub = "";
    sub += userLine(
      sctx,
      "Find every place a colour is converted or emitted in src/, and report the call graph from parseSeed down to the ANSI writer.",
    );
    // The gaps between these steps are model latency, which is what actually
    // dominates a sub-agent's wall time — roughly 15-20s of thinking per step.
    sub += assistantText(
      sctx,
      "Starting with the entry point and following the conversions outward.",
      usage(8_200, 120, 22_000, 1_400),
      18_000,
    );
    sub += toolCall(sctx, {
      name: "Glob",
      id: ids.toolId("sub:glob"),
      input: { pattern: "src/**/*.ts" },
      content: "src/index.ts\nsrc/render.ts\nsrc/theme.ts\nsrc/contrast.ts\nsrc/types.ts",
      result: { numFiles: 5, totalMatches: 5 },
      use: usage(8_400, 60, 22_400, 0),
      durationMs: 1_200,
    });
    sub += assistantText(
      sctx,
      "Five modules. Listing the exported entry points so I can order them into a call graph.",
      usage(9_600, 110, 25_100, 0),
      16_000,
    );
    sub += toolCall(sctx, {
      name: "Grep",
      id: ids.toolId("sub:grep"),
      input: { pattern: "export function", output_mode: "content", "-n": true },
      content:
        "src/index.ts:14:export function parseSeed(input: string): RGB {\nsrc/theme.ts:22:export function buildPalette(seed: RGB): Palette {\nsrc/contrast.ts:9:export function contrastCheck(p: Palette): Report {\nsrc/render.ts:5:export function emitColor(rgb: RGB, layer: Layer): string {",
      result: grepResult(4, 9, ["src/index.ts", "src/theme.ts", "src/contrast.ts", "src/render.ts"]),
      use: usage(11_700, 90, 34_800, 2_200),
      durationMs: 2_600,
    });
    sub += assistantText(
      sctx,
      "Confirming that `emitColor` is the only writer before I report back.",
      usage(13_100, 130, 41_500, 0),
      21_000,
    );
    sub += toolCall(sctx, {
      name: "Read",
      id: ids.toolId("sub:read"),
      // A RELATIVE path on purpose. Nested sub-agent steps are rendered from the
      // sub-agent's own transcript without the tool-detail enrichment the main
      // transcript gets, so there is no `readInfo.basename` to shorten this —
      // an absolute path would print in full and leak the rig's scratch dir.
      input: { file_path: "src/render.ts" },
      content:
        "export function emitColor(rgb: RGB, layer: Layer): string {\n  const [r, g, b] = rgb;\n  // 24-bit truecolor only\n  const lead = layer === \"fg\" ? 38 : 48;\n  return `\\x1b[${lead};2;${r};${g};${b}m`;\n}",
      result: { file: { filePath: "src/render.ts", startLine: 1, numLines: 16, totalLines: 16 } },
      use: usage(13_400, 70, 42_000, 0),
      durationMs: 900,
    });
    sub += assistantText(
      sctx,
      "The call graph is linear:\n\n`parseSeed` (index.ts:14) → `buildPalette` (theme.ts:22) → `contrastCheck` (contrast.ts:9) → `emitColor` (render.ts:5)\n\nOnly `emitColor` writes ANSI escapes. `theme.ts` formats a preview sample but never converts. So a fallback added inside `emitColor` covers the whole pipeline.",
      usage(14_900, 620, 46_200, 3_300),
    );
    write(path.join(subDir, `${agentId}.jsonl`), sub);

    return out;
  };
}

// ── build it ────────────────────────────────────────────────────────────────
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });

// The root workspace. Its key is "" and its project.yaml sits at the projects
// root; without it the root Home renders with a bare directory-basename title.
write(
  path.join(PROJECTS_ROOT, "project.yaml"),
  [
    `name: ${yamlStr(ROOT_WORKSPACE.name)}`,
    `status: ${ROOT_WORKSPACE.status}`,
    "visibility: public",
    "started: 2026-05-01",
    `updated: ${iso(NOW).slice(0, 10)}`,
    `summary: ${yamlStr(ROOT_WORKSPACE.summary)}`,
    "",
  ].join("\n"),
);
write(path.join(PROJECTS_ROOT, "OVERVIEW.md"), `${ROOT_WORKSPACE.overview}\n`);
write(path.join(PROJECTS_ROOT, "CHANGELOG.md"), `${ROOT_WORKSPACE.changelog}\n`);
// Keep transcripts out of every git status the demo might show.
write(path.join(PROJECTS_ROOT, ".gitignore"), "*/.chats/\n.chats/\n");

for (const p of PROJECTS) {
  const dir = path.join(PROJECTS_ROOT, p.slug);
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, "project.yaml"), projectYaml(p, iso(NOW).slice(0, 10)));
  for (const [name, content] of Object.entries(p.files ?? {})) write(path.join(dir, name), content);
  for (const [name, content] of Object.entries(p.triggerPrompts ?? {})) {
    write(path.join(dir, ".paddock", "triggers", name), `${content}\n`);
  }
}

const lumenDir = path.join(PROJECTS_ROOT, "lumen-cli");
const trailDir = path.join(PROJECTS_ROOT, "trail-atlas");
const ledgerDir = path.join(PROJECTS_ROOT, "ledger-lite");
const beaconDir = path.join(PROJECTS_ROOT, "beacon");
const tapedeckDir = path.join(PROJECTS_ROOT, "tapedeck");
const switchboardDir = path.join(PROJECTS_ROOT, "switchboard");

// The image the Read block renders inline. It must genuinely exist under the
// project dir — the browser fetches it via the project's raw-file endpoint.
write(path.join(lumenDir, "assets", "palette-preview.png"), "");
fs.writeFileSync(path.join(lumenDir, "assets", "palette-preview.png"), palettePreviewPNG());

// ── the git repo behind the Changes tab ─────────────────────────────────────
// Paddock's backing store is ONE repo at the projects root, not one per project
// (`GitService.isRepo` runs `rev-parse` against `projectsRoot`), and a project's
// Changes tab is that repo filtered to the project's subtree. Initialising the
// repo inside `lumen-cli/` instead leaves every Changes tab reading `repo:false`.
write(path.join(lumenDir, "src", "render.ts"), RENDER_TS_BASELINE);
write(
  path.join(lumenDir, "src", "types.ts"),
  "export type RGB = [number, number, number];\nexport type Layer = \"fg\" | \"bg\";\n",
);
const git = (...a) =>
  execFileSync("git", ["-C", PROJECTS_ROOT, ...a], {
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Demo",
      GIT_AUTHOR_EMAIL: "demo@example.com",
      GIT_COMMITTER_NAME: "Demo",
      GIT_COMMITTER_EMAIL: "demo@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "Baseline: truecolor renderer");
// Now dirty the tree — this is what the Changes tab renders.
write(path.join(lumenDir, "src", "render.ts"), RENDER_TS_WORKING);
write(
  path.join(lumenDir, "CHANGELOG.md"),
  `${PROJECTS[0].files["CHANGELOG.md"]}\n- Preview grid can now be exported as a PNG.\n`,
);
write(
  path.join(lumenDir, "src", "contrast.ts"),
  [
    'import type { Palette, Report } from "./types.js";',
    "",
    "/** WCAG AA needs 4.5:1 for body text. */",
    "export const AA_RATIO = 4.5;",
    "",
    "export function contrastCheck(p: Palette): Report {",
    "  return { pass: p.pairs.every((x) => x.ratio >= AA_RATIO), pairs: p.pairs };",
    "}",
    "",
  ].join("\n"),
);

// ── chats ───────────────────────────────────────────────────────────────────
addChat({
  slug: "lumen-cli",
  dir: lumenDir,
  label: "star",
  body: starChat(lumenDir),
  startedAt: hoursAgo(3),
  durationMin: 6,
});
addChat({
  slug: "lumen-cli",
  dir: lumenDir,
  label: "reconnect",
  body: simpleChat(
    "Why is the follow reconnect storming?",
    FAKE_SCRIPT["Why is the follow reconnect storming?"],
  ),
  startedAt: hoursAgo(5),
  unread: true,
});
addChat({
  slug: "lumen-cli",
  dir: lumenDir,
  label: "rounding",
  body: simpleChat(
    "Fix the contrast-ratio rounding bug.",
    "Fixed. The ratio was rounded to two decimals *before* the 4.5 comparison, so a true 4.497 was rounding up to 4.50 and passing. Now it compares the raw value and only rounds for display — one pair in the default palette flips from pass to fail, which is correct.",
  ),
  startedAt: hoursAgo(26),
});
addChat({
  slug: "lumen-cli",
  dir: lumenDir,
  label: "flaky",
  body: simpleChat(
    "Investigate the flaky snapshot test on CI.",
    "It's ordering, not timing. `buildPalette` returns a Map and the snapshot serialises insertion order, which differs between Node 22 and 24 for the bright variants. Sorting the entries before the snapshot makes it deterministic — I've pushed that and it's green across both runners now.",
  ),
  startedAt: hoursAgo(31),
  unread: true,
});
addChat({
  slug: "lumen-cli",
  dir: lumenDir,
  label: "triage",
  body: simpleChat(
    "Check for issues opened in the last 24 hours. Label each one by area, and post a two-line summary of anything that looks like a regression.",
    "Three new issues overnight, none of them regressions:\n\n- **#218** `render` — request for a `--format fish` writer. Labelled, no action needed.\n- **#219** `docs` — the README still shows the pre-0.9 flag syntax.\n- **#220** `contrast` — a question about why AA and not AAA. Answered inline.",
  ),
  startedAt: hoursAgo(9),
  durationMin: 2,
  triggerType: "schedule",
});
// Driven live by shoot.mjs to populate the Running feed — the name here is what
// the feed row shows, so it has to read like a real piece of work.
addChat({
  slug: "lumen-cli",
  dir: lumenDir,
  label: "live-ci",
  body: simpleChat(
    "Check the Windows arm64 CI runner situation.",
    "The arm64 runner image went GA last week, so we can drop the cross-compile workaround.",
  ),
  // Recent on purpose: shoot.mjs drives a live turn into this chat, and the Home
  // feed prints this timestamp right next to the running dot — "1d ago" beside a
  // live indicator reads as a stalled job rather than active work.
  startedAt: hoursAgo(0.35),
  durationMin: 2,
});

addChat({
  slug: "trail-atlas",
  dir: trailDir,
  label: "tiles",
  body: simpleChat(
    "Pack a tile bundle for the north corridor and tell me how big it comes out.",
    FAKE_SCRIPT["Pack a tile bundle for the north corridor and tell me how big it comes out."],
  ),
  startedAt: hoursAgo(7),
});
addChat({
  slug: "trail-atlas",
  dir: trailDir,
  label: "elevation-off",
  body: simpleChat(
    "Why is the elevation overlay off by one tile at zoom 13?",
    "The overlay is indexed from the tile's top-left corner but sampled from its centre, so at z13 the half-tile offset is large enough to cross a boundary. Sampling from the same origin as the index fixes it; I've added a regression test at the z12/z13 seam.",
  ),
  startedAt: hoursAgo(11),
  unread: true,
});
addChat({
  slug: "trail-atlas",
  dir: trailDir,
  label: "live-elevation",
  body: simpleChat(
    "Add offline elevation profiles to the north corridor pack.",
    "Added — the profile is derived at pack time so the phone never computes it.",
  ),
  // Also live-driven; see the note above.
  startedAt: hoursAgo(0.7),
  durationMin: 3,
});

addChat({
  slug: "beacon",
  dir: beaconDir,
  label: "flap",
  body: simpleChat(
    "Why did the status page flap at 03:12?",
    "One vantage point lost DNS for about 40 seconds, so the probes for `vault` and `photos` failed together and tripped the two-strike rule.\n\nIt wasn't the services — they never stopped answering on the LAN. I've made resolver failure a distinct state, so a DNS blip now reads as `unknown` rather than `down`, and only a genuine connection failure counts toward a strike.",
  ),
  startedAt: hoursAgo(6),
  unread: true,
});
addChat({
  slug: "tapedeck",
  dir: tapedeckDir,
  label: "restore",
  body: simpleChat(
    "Run a restore drill for the photos dataset.",
    "Restore drill passed — 412 GB back to the staging pool in 51 minutes, and the checksums match the source manifest across all 18,204 files.\n\nWorth knowing: the drill restored to a *different* pool than production, which is the point, but it means we still haven't proven a same-pool restore under pressure. Worth scheduling once the new disks land.",
  ),
  startedAt: hoursAgo(20),
});
addChat({
  slug: "switchboard",
  dir: switchboardDir,
  label: "cert",
  body: simpleChat(
    "Renew the wildcard cert and reload the proxy.",
    "Renewed and reloaded — good for another 90 days, and the reload was graceful so nothing was dropped.\n\nThe DNS-01 challenge took three attempts because the TXT record propagates slowly here. I've raised the wait to 120s so the retry loop stops being the normal path.",
  ),
  startedAt: hoursAgo(52),
});

addChat({
  slug: "ledger-lite",
  dir: ledgerDir,
  label: "rollup",
  body: simpleChat(
    "Sketch the monthly rollup format.",
    "One line per account per month, tab-separated so it stays greppable:\n\n```\n2026-07\tassets:checking\t+1240.18\n2026-07\texpenses:home\t -412.90\n```\n\nThat keeps the file diffable in git and means a month's summary is a single `grep`.",
  ),
  startedAt: hoursAgo(72),
});

// The root workspace's own chat — no project chip on the Home feed, which is
// how you can tell root-level work apart from a project's.
addChat({
  slug: "",
  dir: PROJECTS_ROOT,
  label: "release-note",
  body: simpleChat(
    "Draft a short release note for Lumen CLI 0.9.2.",
    "**Lumen CLI 0.9.2**\n\nTerminals without truecolor now get a proper 256-colour theme instead of a washed-out approximation — colours are quantised to the nearest cube entry, keeping the palette's relative contrast intact. Every foreground/background pair in the default theme is verified against WCAG AA, and a rounding bug that let a 4.497 ratio pass as 4.5 is fixed.",
  ),
  startedAt: hoursAgo(4),
  unread: true,
});

// ── read state ──────────────────────────────────────────────────────────────
// A chat reads as unread when its last completed turn is newer than the user's
// lastSeen. So "mark as read" = write a lastSeen after the turn; "unread" =
// simply omit the key. Auth is `none` for the demo, so the key has no user
// component: `<agent> NUL <sessionId>`, spelled as an escape so this file
// stays greppable (a raw NUL makes grep/ripgrep skip the file as binary, #570).
const readState = {};
for (const c of chats) {
  if (c.unread) continue;
  const agent = c.slug === "" ? "keeper-_root" : `keeper-${c.slug}`;
  readState[`${agent}\u0000${c.sessionId}`] = c.finishedAt.getTime() + 60_000;
}
write(path.join(DATA, "read-state.json"), `${JSON.stringify(readState, null, 2)}\n`);

// The fake `claude` binary's reply book, for the live turns shoot.mjs drives.
write(path.join(OUT, "fake-script.json"), `${JSON.stringify(FAKE_SCRIPT, null, 2)}\n`);

// A manifest so shoot.mjs can address chats by label instead of guessing ids.
const manifest = {
  generatedFrom: iso(NOW),
  projectsRoot: PROJECTS_ROOT,
  chats: Object.fromEntries(
    chats.map((c) => [`${c.slug || "_root"}:${c.label ?? ""}`, c.sessionId]),
  ),
};
write(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Seeded ${chats.length} chats across ${PROJECTS.length} projects + root`);
console.log(`  data: ${DATA}`);
console.log(`  home: ${HOME}`);
console.log(`  unread: ${chats.filter((c) => c.unread).length}`);
