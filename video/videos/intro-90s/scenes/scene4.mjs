/**
 * scene4.mjs — Scene 4: "chats become projects".
 *
 * One clip per SHOT, same shape as scene1/2/3. Two of the six are LIVE keeper
 * turns (`sendfile`, `crossproject`) and are filmed in chats seeded by
 * `scene4-prep.mjs`, so nothing from the copied production transcripts is ever
 * on camera.
 *
 *   env -u NODE_ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node scene4.mjs [shot]
 *
 * Prereqs:
 *   node scene4-prep.mjs                 (seeds $PADDOCK_VIDEO_OUT/tmp/scene4.json)
 *   a git repo at the projects root      (Changes tab is `repo:false` without it —
 *                                        GitService.isRepo() checks projectsRoot,
 *                                        NOT the project subdir, and caches the
 *                                        answer, so `git init` needs a restart)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { TMP_DIR } from "../../../lib/paths.mjs";
import { record, sleep } from "../../../lib/record.mjs";
import {
  moveCursor,
  humanClick,
  humanHover,
  humanType,
  smoothScroll,
  dwell,
  settle,
  placeCursor,
} from "../../../lib/cinematics.mjs";

const BASE = process.env.QC_BASE || "https://5015.dev.projects.valfenda.net";
const LEAD_IN = 2200;
const HAIKU = "claude-haiku-4-5-20251001";

const state = JSON.parse(await fs.readFile(path.join(TMP_DIR, "scene4.json"), "utf8"));
const { slug, file: FILE_CHAT, cross: CROSS_CHAT } = state;

/** A clean, demo-authored ROOT chat — the one `promote` is filmed on. */
const ROOT_CHAT = "b346fc98-1a77-41d2-83bc-5733df6bc055"; // Self-hosting blog post outline

const COMPOSER = "textarea";
const SEND = 'button.btn-primary:has-text("Send")';
const SCROLLER = "div.flex-1.overflow-y-auto.overscroll-contain";

/** Pin the composer's model to Haiku (see scene3.mjs for the why). */
async function pinModel(page) {
  await page.addInitScript(
    ({ ids, slug, model }) => {
      try {
        for (const id of ids) localStorage.setItem(`paddock:chatModel:${id}`, model);
        localStorage.setItem(`paddock:chatModel:new:${slug}`, model);
      } catch {
        /* ignore */
      }
    },
    { ids: [FILE_CHAT, CROSS_CHAT, ROOT_CHAT], slug, model: HAIKU },
  );
}

async function open(page, to, settleMs = LEAD_IN) {
  await page.goto(BASE + to, { waitUntil: "networkidle" });
  await settle(page, settleMs);
  await placeCursor(page, 1180, 700);
}

const shots = {
  /**
   * SHOT 4.1 — promote a root chat into a project.
   *
   * The promote action lives on the sidebar row's hover rail and is offered ONLY
   * at the root (SessionSidebar.tsx:377) — which is the point: the root is where
   * the scratch one-offs live, and this is how one graduates.
   *
   * Ends on the modal. Deliberately NOT submitted: promoting would mint a real
   * project and change the sidebar every later shot is framed against.
   */
  async promote(page) {
    await open(page, `/chat/${ROOT_CHAT}`);
    // Target the row by NAME, never by index. Sidebar order is by last activity,
    // so an index take promoted "Drip irrigation for late July" while the
    // transcript on screen behind the modal was the blog-post chat.
    const NAME = "Self-hosting blog post outline";
    const PROMOTE = `button[aria-label="Promote chat ${NAME} into a project"]`;
    // Hover the row first so its action rail fades in on camera, then travel to
    // the promote (+) button. The rail is `opacity-0` until `group-hover/chat`.
    const box = await page
      .locator("div.chat-row")
      .filter({ hasText: NAME })
      .first()
      .boundingBox();
    await moveCursor(page, box.x + box.width * 0.3, box.y + box.height * 0.3, 1000);
    await dwell(page, 1400);
    await humanClick(page, PROMOTE, {
      moveMs: 700,
      preClickMs: 450,
      postClickMs: 800,
      arc: 0,
    });
    await settle(page, 900);
    // Drift onto the modal's primary action so the dialog doesn't look like it
    // opened by itself, and hold there.
    await humanHover(page, 'button:has-text("Promote to project") >> nth=-1', {
      moveMs: 1100,
      postClickMs: 0,
    });
    await dwell(page, 2400);
  },

  /**
   * SHOT 4.2 — New project, backed by a git repo.
   *
   * The URL is typed rather than filled so it reads as a human doing it. NOT
   * submitted: creating it would clone a real repo onto this box.
   */
  async newproject(page) {
    await open(page, "/");
    await humanClick(page, 'button:has-text("New Project") >> nth=0', {
      moveMs: 900,
      preClickMs: 400,
      postClickMs: 800,
    });
    await settle(page, 700);
    await humanClick(page, 'input[placeholder^="Garage"]', { moveMs: 800, postClickMs: 300 });
    await humanType(page, null, "HushPod iOS", { cps: 13, focus: false });
    await sleep(500);
    await humanClick(page, 'input[placeholder^="https://github.com"]', {
      moveMs: 800,
      postClickMs: 300,
    });
    await humanType(page, null, "https://github.com/edspencer/hushpod-ios.git", {
      cps: 15,
      focus: false,
    });
    await sleep(700);
    // Rest on the explainer under the field — "Link an external repo and Paddock
    // clones it as the project's working directory" — which is the actual claim.
    await moveCursor(page, 960, 640, 900, { arc: 0.05 });
    await dwell(page, 2600);
  },

  /**
   * SHOT 4.3 — the Changes tab.
   *
   * `GitService.isRepo()` tests the PROJECTS ROOT, not the project dir, so the
   * whole notes tree is one repo (exactly as production's is) and each project's
   * Changes tab is a view of its own subtree.
   */
  async changes(page) {
    await open(page, `/projects/${slug}/changes`);
    await moveCursor(page, 690, 130, 900, { arc: 0.05 }); // branch + "2 uncommitted"
    await dwell(page, 1300);
    await humanClick(page, "text=OVERVIEW.md", { moveMs: 800, postClickMs: 900 });
    await settle(page, 800);
    await dwell(page, 1200);
    await humanClick(page, "text=CHANGELOG.md", { moveMs: 800, postClickMs: 900 });
    await settle(page, 800);
    await moveCursor(page, 1200, 380, 1000, { arc: 0.04 }); // into the green hunk
    await dwell(page, 1400);
    await moveCursor(page, 690, 1050, 900, { arc: 0.05 }); // the Commit button
    await dwell(page, 2400);
  },

  /**
   * SHOT 4.4 — the sweeper's output: a project Home tab, where the curated
   * CHANGELOG.md and OVERVIEW.md are rendered under the chat + file lists.
   */
  async sweeper(page) {
    await open(page, `/projects/${slug}/home`);
    await moveCursor(page, 1100, 300, 900, { arc: 0.05 });
    await dwell(page, 1000);
    await smoothScroll(page, "text=CHANGELOG.MD", 1600).catch(() => {});
    await dwell(page, 1600);
    await moveCursor(page, 1100, 500, 900, { arc: 0.04 });
    await dwell(page, 1200);
    await smoothScroll(page, 700, 1800);
    await dwell(page, 2400);
  },

  /**
   * SHOT 4.5 — send_file: the agent hands back a rendered document.
   *
   * LIVE. The phrasing matters and is not decorative: "send me X as a file" on
   * its own makes Haiku reach for **Write** and put a file on disk instead —
   * verified, twice. Naming the tool AND saying "compose it inline / nothing on
   * disk" is what reliably produces an inline `content` envelope. (A `file_path`
   * envelope pointing at a file that doesn't exist renders a red error card.)
   */
  async sendfile(page) {
    await open(page, `/projects/${slug}/chat/${FILE_CHAT}`);
    await humanClick(page, COMPOSER, { moveMs: 800, postClickMs: 400 });
    await humanType(
      page,
      null,
      "Send me the deployment quickstart as a markdown file in the chat — " +
        "compose it inline with send_file, nothing on disk.",
      { cps: 14, focus: false },
    );
    await sleep(500);
    await humanClick(page, SEND, { moveMs: 650, preClickMs: 350, postClickMs: 300 });
    // Wait for the RENDERED file block, not for the turn to end: the block lands
    // the moment the tool returns, and the keeper's closing sentence after it is
    // dead air on camera.
    await page
      .locator('[class*="uppercase"]:has-text("MARKDOWN")')
      .first()
      .waitFor({ state: "visible", timeout: 180000 })
      .catch(() => {});
    await sleep(1200);
    await smoothScroll(page, SCROLLER, 1000).catch(() => {});
    await moveCursor(page, 1150, 500, 1100, { arc: 0.05 });
    await dwell(page, 1400);
    await smoothScroll(page, 420, 1600);
    await dwell(page, 2400);
  },

  /**
   * SHOT 4.6 — one project's chat starting a chat in ANOTHER project.
   *
   * LIVE, and it works because the in-process keeper principal carries
   * FULL_SCOPE (management-policy.ts) — it is bounded by spawn DEPTH, not by
   * which projects it may reach. edspencer.net is pinned to Haiku in its
   * project.yaml so the child turn runs on Haiku too (`create_chat` uses
   * `overrideModel ?? p.model`).
   */
  async crossproject(page) {
    await open(page, `/projects/${slug}/chat/${CROSS_CHAT}`);
    await humanClick(page, COMPOSER, { moveMs: 800, postClickMs: 400 });
    await humanType(
      page,
      null,
      "Start a chat over in the edspencer.net project asking it to draft a short " +
        "post about the chapter-skip API.",
      { cps: 14, focus: false },
    );
    await sleep(500);
    await humanClick(page, SEND, { moveMs: 650, preClickMs: 350, postClickMs: 300 });
    await page
      .locator('button:has-text("Create chat")')
      .first()
      .waitFor({ state: "visible", timeout: 180000 })
      .catch(() => {});
    await sleep(1500);
    await smoothScroll(page, SCROLLER, 900).catch(() => {});
    // Open the card so the frame says "Created chat … in edspencer.net · open chat"
    // rather than a collapsed one-liner (a LIVE create_chat renders collapsed;
    // `pmActionDefaultOpen` is a useState initialiser evaluated on the first,
    // output-less render, so it only auto-expands on reload).
    await humanClick(page, 'button:has-text("Create chat") >> nth=-1', {
      moveMs: 800,
      postClickMs: 800,
    });
    await dwell(page, 1600);
    // …and over to edspencer.net in the sidebar, whose count has just moved.
    await moveCursor(page, 143, 201, 1200, { arc: 0.06 });
    await dwell(page, 2400);
  },
};

const only = process.argv[2];
const names = only ? [only] : Object.keys(shots);

for (const name of names) {
  if (!shots[name]) {
    console.error(`no such shot: ${name} (have: ${Object.keys(shots).join(", ")})`);
    process.exit(1);
  }
  const out = await record(`s4-${name}`, shots[name], { onPage: pinModel });
  console.log(`OK s4-${name} -> ${out.path} (${out.ms}ms)`);
}
