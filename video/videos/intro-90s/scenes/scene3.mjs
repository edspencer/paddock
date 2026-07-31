/**
 * scene3.mjs — Scene 3: "one chat spawns three more".
 *
 * Same shape as scene1.mjs: one clip per SHOT, `open()` for load+settle+cursor
 * park, LEAD_IN before any action, ~2s of stillness at the end of every shot so
 * a caption can sit on a stable frame.
 *
 * Two things differ from scene1, both because this scene records a REAL keeper
 * turn rather than a static page:
 *
 *  1. `ask` and `spawn` are ONE continuous piece of reality split across two
 *     clips. `ask` types the message and sends it; the turn then runs
 *     server-side, independent of the browser. `spawn` relaunches onto the same
 *     chat seconds later and catches the create_chat cards landing. So run them
 *     together (`node scene3.mjs live`) — re-taking `spawn` alone gets you a
 *     finished turn and no motion.
 *  2. The composer's model is pinned to Haiku via localStorage in an init
 *     script, so the model shown on camera is the model that actually ran.
 *
 * Prereqs: `node scene3-prep.mjs` (seeds the parent chat, writes the scene
 * state to $PADDOCK_VIDEO_OUT/tmp/scene3.json)
 * and an instance with the self-management MCP write tools enabled — without them
 * the keeper has no create_chat and the payoff shot cannot exist.
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

const state = JSON.parse(await fs.readFile(path.join(TMP_DIR, "scene3.json"), "utf8"));
const { slug, parent } = state;
const CHAT_URL = `/projects/${slug}/chat/${parent}`;

/**
 * The message typed on camera. Natural, and short enough to type in ~8s.
 *
 * It deliberately does NOT name a model. An earlier take said "…on Haiku", and
 * the keeper faithfully passed `model: "haiku"` to create_chat — not a valid id
 * — which put three red `error` cards in the middle of the payoff shot. The
 * child chats' model is set where it belongs instead: `hushpod/project.yaml`,
 * which `create_chat` falls back to (`overrideModel ?? p.model`).
 */
const ASK =
  "Split this three ways — tests, docs, implementation. " +
  "Start a chat here for each, named for its job.";

/**
 * The composer textarea. Matched on the ELEMENT, not the placeholder: while a
 * turn is in flight the placeholder flips to "Queue a message to send next…"
 * and the Send button becomes Stop, so a placeholder-pinned selector times out
 * on exactly the shot that wants a live chat.
 */
const COMPOSER = "textarea";
const SEND = 'button.btn-primary:has-text("Send")';
/** A user message bubble (right-aligned, so `rounded-br-md`). */
const USER_BUBBLE = "div.rounded-2xl.rounded-br-md";
const CREATE_CARD = 'button:has-text("Create chat")';
/** The transcript's own scroll container (the main pane is nested, not window). */
const SCROLLER = "div.flex-1.overflow-y-auto.overscroll-contain";

// -------------------------------------------------------------- page setup --

/**
 * Pin the composer's model to Haiku before the app boots. The select is backed
 * by `paddock:chatModel:<sessionId>` (lib/chatModel.ts) and defaults to Opus —
 * which would put a model on screen that is not the model running the turn.
 */
async function pinModel(page) {
  await page.addInitScript(
    ({ parent, slug, model }) => {
      try {
        localStorage.setItem(`paddock:chatModel:${parent}`, model);
        localStorage.setItem(`paddock:chatModel:new:${slug}`, model);
      } catch {
        /* ignore */
      }
    },
    { parent, slug, model: HAIKU },
  );
}

/** Load, settle, park the cursor. Mirrors scene1's helper. */
async function open(page, to = CHAT_URL, settleMs = LEAD_IN) {
  await page.goto(BASE + to, { waitUntil: "networkidle" });
  await settle(page, settleMs);
  await placeCursor(page, 1180, 700);
}

/**
 * Scale an element in place (scene1's `badges` trick) for a close-on shot.
 * `which` picks a hand-written resolver rather than eval'ing a string — the SPA
 * ships a CSP and `eval` inside page.evaluate is not worth the risk.
 */
async function zoom(page, which, scale, origin = "top left") {
  const ok = await page.evaluate(
    ([which, scale, origin]) => {
      let el = null;
      if (which === "chat-column") {
        // Walk up from a ROW, not from the "Chats" label: the label's first
        // ancestor in the 200–360px band is its own header strip, so scaling
        // that blew up the word CHATS and the count badge and left every chat
        // row at 1x. Require full column height as well as column width.
        el = document.querySelector("div.chat-row");
        while (el) {
          const b = el.getBoundingClientRect();
          if (b.width > 200 && b.width < 360 && b.height > 900) break;
          el = el.parentElement;
        }
      } else if (which === "status-row") {
        const meter = document.querySelector('span[title^="Context window used"]');
        el = meter ? meter.closest("div.mb-2") : null;
      }
      if (!el) return false;
      el.style.transform = `scale(${scale})`;
      el.style.transformOrigin = origin;
      return true;
    },
    [which, scale, origin],
  );
  if (!ok) throw new Error(`zoom: could not resolve ${which}`);
}

/**
 * A NESTED sidebar chat row. Sidebar rows are `div.chat-row > button`, not
 * anchors — the only `a[href*="/chat/"]` on the page are the transcript's
 * "open chat" pills, so anything that looks for links here silently finds
 * nothing and no-ops. The discriminator is the action-count class the row
 * already carries: a nested row gets a 7th action (detach), a top-level one
 * does not (SessionSidebar.tsx:220).
 */
const NESTED_ROW = "div.chat-row--actions-7 > button";

/**
 * Viewport points on the NAME of each nested sidebar row, in render order. `x`
 * is biased left so the pointer never rests on the hover action rail
 * (fork/rename/archive/delete/…) — resting on an icon pops a tooltip over the
 * held final frame of a shot.
 */
async function nestedRowPoints(page) {
  return rowPoints(page, NESTED_ROW);
}

/**
 * Same, for any row selector. Fractions of the box rather than fixed offsets so
 * the points stay correct after a CSS `scale()` (the tree shot zooms first, then
 * asks where the rows are).
 */
async function rowPoints(page, sel) {
  return page.evaluate((s) => {
    return [...document.querySelectorAll(s)]
      .map((r) => r.getBoundingClientRect())
      .map((b) => ({ x: Math.round(b.x + b.width * 0.22), y: Math.round(b.y + b.height * 0.26) }));
  }, sel);
}

/** Wait until at least `n` "Create chat" tool cards are on screen. */
async function waitForCreateCards(page, n, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = await page.locator(CREATE_CARD).count().catch(() => 0);
    if (count >= n) return count;
    if (Date.now() > deadline) return count;
    await sleep(350);
  }
}

// ------------------------------------------------------------------- shots --

const shots = {
  // SHOT 3.1 — the ask. Type it out so the words land, then click Send.
  // Ends the moment the message is on screen: the turn it starts is shot 3.2.
  async ask(page) {
    await open(page);
    await humanClick(page, COMPOSER, { moveMs: 800, postClickMs: 500 });
    await humanType(page, null, ASK, { cps: 13, focus: false });
    await sleep(700);
    await humanClick(page, SEND, { moveMs: 700, preClickMs: 380, postClickMs: 300 });
    await dwell(page, 2000);
  },

  // SHOT 3.2 — THE PAYOFF. The turn started by `ask` is already in flight; this
  // opens onto it and holds while the create_chat cards land in the transcript
  // and the three chats appear, nested, in the sidebar. The cursor drifts slowly
  // between the two so both halves of the story get pointed at.
  async spawn(page) {
    await open(page, CHAT_URL, 1000);
    await waitForCreateCards(page, 1, 150000);
    await moveCursor(page, 1150, 560, 900);
    await dwell(page, 1000);
    await waitForCreateCards(page, 2, 60000);
    await smoothScroll(page, `${CREATE_CARD} >> nth=-1`, 900).catch(() => {});
    await moveCursor(page, 1150, 700, 1100);
    await dwell(page, 1400);
    await waitForCreateCards(page, 3, 60000);
    await smoothScroll(page, `${CREATE_CARD} >> nth=-1`, 900).catch(() => {});
    await dwell(page, 1000);
    // Open a card. A LIVE create_chat renders collapsed — `pmActionDefaultOpen`
    // is a useState initialiser, evaluated on the first (pending, output-less)
    // render — so the rich body only auto-expands on reload. Clicking it here is
    // both the honest live behaviour and the better frame: "Created chat … in
    // hushpod · open chat" plus the kickoff prompt.
    await humanClick(page, `${CREATE_CARD} >> nth=0`, { moveMs: 800, postClickMs: 700 });
    await dwell(page, 1800);
    // …and over to the sidebar, where the same three chats are now a tree.
    // Resolved from the DOM, never hard-coded: row order and count shift with
    // what has spawned so far, and a stale y lands the pointer on the hover
    // action rail — which pops an "Archive chat — …" tooltip over the last,
    // held frame of the shot. Aim at the row's NAME (left of the icons).
    const rows = await nestedRowPoints(page);
    if (rows.length) {
      await moveCursor(page, rows[rows.length - 1].x, rows[rows.length - 1].y, 1300, { arc: 0.06 });
      await dwell(page, 1000);
      await moveCursor(page, rows[0].x, rows[0].y, 900, { arc: 0.05 });
    }
    await dwell(page, 2200);
  },

  // SHOT 3.3 — the tree itself: twisty, guide lines, running dots. Zoomed,
  // because at 1080p the whole story is 260px wide.
  async tree(page) {
    await open(page);
    await zoom(page, "chat-column", 1.8, "top left");
    await settle(page, 900);
    // Rows are measured AFTER the zoom, so these are real on-screen points.
    const all = await rowPoints(page, "div.chat-row > button");
    const nested = await nestedRowPoints(page);
    await placeCursor(page, 900, 800);
    if (all.length) {
      await moveCursor(page, all[0].x, all[0].y, 1200, { arc: 0.05 }); // the parent
      await dwell(page, 1300);
    }
    for (const p of nested.slice(0, 3)) {
      await moveCursor(page, p.x, p.y, 1000, { arc: 0.04 });
      await dwell(page, 1100);
    }
    await dwell(page, 1600);
  },

  // SHOT 3.4 — a spawned chat is a REAL chat: open one, read its kickoff, steer
  // it with a follow-up. Clicked from the sidebar so the nesting stays on screen.
  async follow(page) {
    await open(page);
    const n = await page.locator(NESTED_ROW).count();
    if (!n) throw new Error("follow: no nested chat row");
    // Prefer the implementation child. Not vanity: the children that go looking
    // for source code flail (hushpod's `repo:` is stripped on this instance, so
    // Read/Glob 404 into red `error` cards, and one of them spent 6m and $0.77 in
    // a sub-agent trying to clone the repo). The planning child produces a clean,
    // legible transcript. Falls back to the first nested row.
    let idx = 0;
    const labels = await page.locator(NESTED_ROW).allTextContents();
    for (const want of ["docs", "implementation", "tests"]) {
      const i = labels.findIndex((t) => t.toLowerCase().includes(want));
      if (i >= 0) {
        idx = i;
        break;
      }
    }
    await humanClick(page, `${NESTED_ROW} >> nth=${idx}`, { moveMs: 900, postClickMs: 900 });
    await settle(page, 1200);
    // Deliberately NO scroll to the top of a spawned child: `create_chat` was
    // called with preload_context, so its FIRST message is the whole of
    // OVERVIEW.md + CHANGELOG.md in one giant orange bubble — a wall of raw
    // markdown that reads as a bug on camera. The tail (the child's own plan) is
    // the part worth showing.
    await dwell(page, 2400);
    await humanClick(page, COMPOSER, { moveMs: 800, postClickMs: 400 });
    await humanType(page, null, "Start with the self-hosting quickstart.", { cps: 13, focus: false });
    await sleep(600);
    // Mid-turn there is no Send button — it is Stop, and clicking that would
    // kill the very turn the shot is about. Enter QUEUES instead, which is the
    // more interesting behaviour anyway: the message parks as a queued chip.
    if (await page.locator(SEND).count()) {
      await humanClick(page, SEND, { moveMs: 650, postClickMs: 400 });
    } else {
      await page.keyboard.press("Enter");
      await sleep(500);
    }
    await dwell(page, 2400);
  },

  // SHOT 3.5 — fork from any point in a transcript. Hover a message to raise its
  // rail, click the fork icon, and the name-the-fork modal opens. Ends there.
  //
  // The rail is `opacity-0 pointer-events-none` until `group-hover`, and it sits
  // at `-top-3` — 12px ABOVE its group, overlapping it by half. So the pointer
  // has to travel from the bubble to the rail along a near-vertical path near
  // the right edge (arc 0): swing wide and the group un-hovers mid-flight, the
  // rail fades, and the click lands on nothing.
  async fork(page) {
    await open(page);
    // Fork from the SECOND user message, not the first. Forking truncates at the
    // chosen message, so a fork taken at message #1 opens onto a near-empty
    // transcript that reads as a broken page; taken here it carries the whole
    // conversation so far.
    const idx = Math.min(1, (await page.locator(USER_BUBBLE).count()) - 1);
    await smoothScroll(page, `${USER_BUBBLE} >> nth=${idx}`, 1200).catch(() => {});
    await sleep(500);
    const pts = await page.evaluate(
      ([sel, i]) => {
        const b = [...document.querySelectorAll(sel)][i];
        if (!b) return null;
        // The rail lives in the message's `group` wrapper and is only clickable
        // while that group is hovered.
        const btn = b.closest("div.group")?.querySelector('button[title^="Fork a new chat"]');
        const bb = b.getBoundingClientRect();
        const fb = btn?.getBoundingClientRect();
        return {
          bubble: { x: Math.round(bb.x + bb.width - 44), y: Math.round(bb.y + 16) },
          fork: fb ? { x: Math.round(fb.x + fb.width / 2), y: Math.round(fb.y + fb.height / 2) } : null,
        };
      },
      [USER_BUBBLE, idx],
    );
    if (!pts?.fork) throw new Error("fork: could not locate the message's fork button");
    await moveCursor(page, pts.bubble.x, pts.bubble.y, 950);
    await dwell(page, 1500); // let the rail fade in on camera
    // Straight up the right edge, arc 0. The rail sits at `-top-3` — half of it
    // overlaps the group — so a bowed path leaves the group mid-flight, the rail
    // fades back to `pointer-events:none`, and the click lands on nothing.
    await moveCursor(page, pts.fork.x, pts.fork.y, 800, { arc: 0 });
    await sleep(600);
    await page.evaluate(() => window.__cursor?.press());
    await page.evaluate(([a, b]) => window.__cursor?.ripple(a, b), [pts.fork.x, pts.fork.y]).catch(() => {});
    await page.mouse.click(pts.fork.x, pts.fork.y);
    await page.evaluate(() => window.__cursor?.release());
    await settle(page, 1200);
    await dwell(page, 900);
    // Rest on the fork's brand-new sidebar row rather than leaving the pointer
    // stranded in the empty gutter: it ties the click to its result. Matched by
    // NAME — the fork lands nested under its parent, so neither "first row" nor
    // "first nested row" reliably points at it.
    const forkRow = await page.evaluate(() => {
      const b = [...document.querySelectorAll("div.chat-row > button")].find((n) =>
        n.textContent.trim().startsWith("Fork of"),
      );
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width * 0.22), y: Math.round(r.y + r.height * 0.26) };
    });
    if (forkRow) await moveCursor(page, forkRow.x, forkRow.y, 1200, { arc: 0.05 });
    await dwell(page, 2200);
  },

  // SHOT 3.5b — the fork NAMING modal.
  //
  // Worth knowing before cutting: "Fork from here" on a message rail does NOT
  // open a dialog. `forkFromMessage` (ProjectView.tsx:531) forks eagerly and
  // navigates — one click, no confirmation. The `ForkChatModal` (#279) is wired
  // only to the SIDEBAR row's fork action, which branches the whole chat. So the
  // rail and the modal are two different features; this clip is the modal one.
  async forkmodal(page) {
    await open(page);
    const row = page.locator("div.chat-row").first();
    const box = await row.boundingBox();
    await moveCursor(page, box.x + box.width * 0.3, box.y + box.height * 0.3, 900);
    await dwell(page, 1200); // the row's action rail fades in
    await humanClick(page, 'button[aria-label^="Fork chat "] >> nth=0', {
      moveMs: 800,
      preClickMs: 500,
      postClickMs: 700,
      arc: 0,
    });
    // Drift onto the modal's primary action and hold there. Leaving the pointer
    // parked back in the sidebar makes the dialog look like it opened by itself.
    await humanHover(page, 'button:has-text("Fork")>> nth=-1', { moveMs: 1100, postClickMs: 0 });
    await dwell(page, 2400);
  },

  // SHOT 3.5c — the Config screen: spawning is OPT-IN.
  //
  // Framed with CSS `zoom` on #root, not a `transform: scale()`. Zoom is a
  // LAYOUT property, so the form column genuinely gets wider (it is a
  // `max-w-2xl` centred in 1920px, i.e. two thirds of the frame is dead space at
  // 1x) and the pane's own scroller keeps working. A transform would leave the
  // layout at 1x and desync every scroll offset.
  //
  // It goes on #root and NOT on <body>: the synthetic pointer is a
  // position:fixed div appended to <body>, so zooming the body multiplies the
  // pointer's own translate3d as well — the drawn cursor drifts to 1.35x its
  // real coordinates and stops agreeing with what it is pointing at.
  //
  // NOTE for the edit: on THIS instance the read + write toggles are ON — Scene 3
  // needs them, since without them the keeper has no `create_chat` and there is
  // no spawn footage. What carries the "opt in" line is the pair below them:
  // "Self-management MCP (projects)" unchecked, and "Max spawn depth: 1".
  async config(page) {
    const Z = 1.35;
    await page.goto(BASE + "/config", { waitUntil: "networkidle" });
    await settle(page, 1200);
    await page.evaluate((z) => {
      document.getElementById("root").style.zoom = String(z);
    }, Z);
    await sleep(700);
    // Scroll in UNSCALED units: getBoundingClientRect reports zoomed pixels but
    // scrollTop is still layout pixels, so the delta has to be divided by Z or
    // the pane overshoots by a third of a screen.
    await page.evaluate((z) => {
      const sc = document.querySelector("div.min-h-0.flex-1.overflow-y-auto");
      const el = [...document.querySelectorAll("label")].find((l) =>
        l.textContent.startsWith("Self-management MCP (read)"),
      );
      if (sc && el) sc.scrollTop += (el.getBoundingClientRect().top - 300) / z;
    }, Z);
    await sleep(900);
    await placeCursor(page, 1700, 850);
    // Drift down the three self-management toggles, then rest on the spawn-depth
    // field — the actual gate (wake-injection.ts), not the checkboxes.
    const pts = await page.evaluate(() => {
      const at = (prefix) => {
        const l = [...document.querySelectorAll("label")].find((x) =>
          x.textContent.startsWith(prefix),
        );
        const r = l.getBoundingClientRect();
        return { x: Math.round(r.x + r.width * 0.5), y: Math.round(r.y + r.height * 0.5) };
      };
      return {
        read: at("Self-management MCP (read)"),
        projects: at("Self-management MCP (projects)"),
        depth: at("Max spawn depth"),
      };
    });
    await moveCursor(page, pts.read.x, pts.read.y, 1200, { arc: 0.05 });
    await dwell(page, 1200);
    await moveCursor(page, pts.projects.x, pts.projects.y, 900, { arc: 0.04 });
    await dwell(page, 1300);
    await moveCursor(page, pts.depth.x, pts.depth.y, 800, { arc: 0.04 });
    await dwell(page, 2400);
  },

  // SHOT 3.6 — close on the composer status row: model, context meter, cost.
  async context(page) {
    await open(page);
    await zoom(page, "status-row", 2.4, "left center");
    await settle(page, 900);
    // Land ON the scaled meter, not above it: the row grows about its vertical
    // centre, so its post-zoom y is measured rather than guessed.
    const meter = await page.evaluate(() => {
      const b = document.querySelector('span[title^="Context window used"]').getBoundingClientRect();
      return { x: Math.round(b.x + b.width * 0.12), y: Math.round(b.y + b.height * 0.5) };
    });
    await placeCursor(page, 1700, 800);
    await moveCursor(page, meter.x, meter.y, 1300, { arc: 0.05 });
    await dwell(page, 2400);
  },
};

const only = process.argv[2];
const names = only === "live" ? ["ask", "spawn"] : only ? [only] : Object.keys(shots);

for (const name of names) {
  if (!shots[name]) {
    console.error(`no such shot: ${name} (have: ${Object.keys(shots).join(", ")}, or "live")`);
    process.exit(1);
  }
  const out = await record(`s3-${name}`, shots[name], { onPage: pinModel });
  console.log(`OK s3-${name} -> ${out.path} (${out.ms}ms)`);
}
