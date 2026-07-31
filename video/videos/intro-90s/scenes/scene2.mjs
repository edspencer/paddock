/**
 * scene2.mjs — Scene 2: "off the laptop".
 *
 * Same shape as scene1/scene3: one clip per SHOT, `open()` for load + settle +
 * cursor park, and ~2s of stillness at the end of every shot so a caption can
 * sit on a stable frame.
 *
 * Shots:
 *   reload    — a chat mid-turn survives a hard browser reload (LIVE turn)
 *   phone     — the same instance at a 430x932 mobile viewport (PORTRAIT clip)
 *   readstate — unread cues in the sidebar, cleared by opening the chat
 *   triggers  — the Triggers tab, then the History tab's unattended runs
 *
 *   env -u NODE_ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node scene2.mjs [shot]
 *
 * All four are shot in the ROOT workspace's own chats (the six seeded
 * "NAS backup / drip irrigation / …" ones) except `triggers`, which needs a
 * project. That is deliberate: the root chats are the only transcripts on this
 * instance that were AUTHORED for the demo, so they are the only ones certain
 * to be free of anything that shouldn't be on camera.
 */
import { record, sleep } from "../../../lib/record.mjs";
import {
  moveCursor,
  humanClick,
  humanType,
  smoothScroll,
  dwell,
  settle,
  placeCursor,
} from "../../../lib/cinematics.mjs";

const BASE = process.env.QC_BASE || "https://5015.dev.projects.valfenda.net";
const API = "http://127.0.0.1:5015";
const LEAD_IN = 2200;
const HAIKU = "claude-haiku-4-5-20251001";

/** Root-workspace chats, by the name they carry in the sidebar. */
const CHATS = {
  nas: "e0e0d91d-4866-47ee-83ef-69e5e2519d01", // NAS backup retention policy
  drip: "2336c420-af28-470b-a8d2-8db928bc950c", // Drip irrigation for late July
  blog: "b346fc98-1a77-41d2-83bc-5733df6bc055", // Self-hosting blog post outline
  ups: "bece32df-838f-4c95-b9f7-5a1d68d725ba", // Rack UPS upgrade shortlist
  vlan: "328486b8-6bb8-4e60-814c-ae614471b086", // Home network VLAN layout
  cron: "5a5b64d5-efc8-4a79-a180-1bfc56e688bd", // Cron vs systemd timers
};

const COMPOSER = "textarea";
const SEND = 'button.btn-primary:has-text("Send")';
/** The transcript's own scroll container (the main pane is nested, not window). */
const SCROLLER = "div.flex-1.overflow-y-auto.overscroll-contain";

/**
 * Pin the composer's model to Haiku before the app boots — the select is backed
 * by `paddock:chatModel:<sessionId>` and defaults to Opus, which would put a
 * model on screen that is not the model running the turn. Root chats key on the
 * session id alone (there is no slug in a root chat's storage key).
 */
function pinModel(sessionId) {
  return async (page) => {
    await page.addInitScript(
      ({ id, model }) => {
        try {
          localStorage.setItem(`paddock:chatModel:${id}`, model);
          localStorage.setItem("paddock:chatModel:new:", model);
        } catch {
          /* ignore */
        }
      },
      { id: sessionId, model: HAIKU },
    );
  };
}

async function open(page, to, settleMs = LEAD_IN) {
  await page.goto(BASE + to, { waitUntil: "networkidle" });
  await settle(page, settleMs);
  await placeCursor(page, 1180, 700);
}

/**
 * How the unread cues in `readstate` are set up — NOT by this file.
 *
 * The obvious route, `POST /chats/:id/unread`, sets the MANUAL override, and on
 * camera that only half-works: AppShell's badge is
 * `unread || at > readLastSeen(sid)` where `unread` is the manual flag folded in
 * from the last `/api/projects` payload. Opening the chat bumps the client's
 * in-memory lastSeen, so the row's dot clears — but the manual flag is still
 * true in the cached payload, and the projects context has NO poll, so the
 * aggregate Home count sits there stale for the rest of the take.
 *
 * So the three chats are made unread by DERIVATION instead: their `lastSeen`
 * watermarks are rolled back in `read-state.json` (staging/patch-readstate.py) and
 * the server restarted. Then opening one clears its dot AND decrements Home in
 * the same frame, which is the whole point of the shot.
 */
const UNREAD_SETUP = "staging/patch-readstate.py + a server restart (see the note above)";

/** Viewport points on the NAME of each sidebar chat row, in render order. */
function rowPoints(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("div.chat-row")]
      .map((r) => r.getBoundingClientRect())
      .map((b) => ({ x: Math.round(b.x + b.width * 0.22), y: Math.round(b.y + b.height * 0.3) })),
  );
}

const shots = {
  /**
   * SHOT 2.1 — reload mid-turn.
   *
   * The whole point is that the turn is SERVER-side: the browser is a view onto
   * it, not the thing running it. So this types a real message, sends it, waits
   * until tokens are visibly streaming, then does a hard `page.reload()` and
   * holds while the transcript rehydrates with the same turn still in flight.
   *
   * The ask is deliberately long-form ("ten worked examples") — on Haiku a
   * two-sentence answer finishes before the reload lands and the shot has
   * nothing to prove.
   */
  async reload(page) {
    await open(page, `/chat/${CHATS.cron}`);
    await humanClick(page, COMPOSER, { moveMs: 800, postClickMs: 400 });
    await humanType(
      page,
      null,
      "Write me the full crontab reference: the five fields explained, twenty worked " +
        "examples with commentary, then a section on the mistakes people always make.",
      { cps: 14, focus: false },
    );
    await sleep(500);
    await humanClick(page, SEND, { moveMs: 650, preClickMs: 350, postClickMs: 300 });
    // Wait for the turn to be visibly ALIVE before reloading: Send flips to Stop
    // the instant the WS accepts, but text takes a beat longer.
    await page
      .locator('button:has-text("Stop")')
      .first()
      .waitFor({ state: "visible", timeout: 60000 })
      .catch(() => {});
    // Only ~3s of accumulation, and the ask above is deliberately a long one. An
    // earlier take waited 7s on a ten-example ask: Haiku had FINISHED by the time
    // the reloaded page settled, so the clip proved "the transcript came back"
    // but not "the turn is still running", which is the actual claim.
    await sleep(3000);
    await moveCursor(page, 1180, 300, 900);
    await dwell(page, 600);
    // The cut. A real reload — not a client-side route change.
    await page.reload({ waitUntil: "domcontentloaded" });
    await settle(page, 1500);
    await placeCursor(page, 1180, 620);
    await sleep(2500); // transcript rehydrates, stream reattaches
    await smoothScroll(page, SCROLLER, 900).catch(() => {});
    await moveCursor(page, 1500, 940, 1100, { arc: 0.05 }); // the "connected" pill
    await dwell(page, 2400);
  },

  /**
   * SHOT 2.2 — the phone.
   *
   * PORTRAIT. `recordVideo.size` must EQUAL the viewport or Playwright pads the
   * frame with grey rather than scaling it, so this clip is genuinely 430x932
   * and has to be composited into the 16:9 timeline, not just dropped in.
   *
   * `isMobile: true` WITHOUT `hasTouch`: we want the mobile layout, but the
   * cinematics drive `page.mouse`, and in a touch-only context every
   * mouse-driven click resolves as "outside of the viewport" and times out.
   */
  async phone(page) {
    await open(page, "/", 2000);
    await placeCursor(page, 215, 640);
    await moveCursor(page, 215, 300, 900);
    await dwell(page, 1200);
    // Drift down the six root chats, then tap into one.
    const target = await page.evaluate(() => {
      const el = [...document.querySelectorAll("button")]
        .filter((e) => (e.textContent || "").startsWith("Self-hosting blog post outline"))
        .find((e) => e.getBoundingClientRect().x > 0); // the drawer holds a duplicate at x<0
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width * 0.35), y: Math.round(r.y + r.height / 2) };
    });
    await moveCursor(page, target.x, target.y, 1000, { arc: 0.05 });
    await dwell(page, 900);
    await page.evaluate(() => window.__cursor?.press());
    await page.evaluate(([a, b]) => window.__cursor?.ripple(a, b), [target.x, target.y]);
    await sleep(120);
    await page.mouse.click(target.x, target.y);
    await page.evaluate(() => window.__cursor?.release());
    await settle(page, 1600);
    // The transcript opens pinned to the bottom; ease UP a little so it reads as
    // a real conversation rather than a wall that appeared.
    await smoothScroll(page, -420, 1400);
    await dwell(page, 2400);
  },

  /**
   * SHOT 2.3 — read state.
   *
   * Three root chats are flagged unread out of camera (server-side, per user —
   * this is the same state a second device would see), so the sidebar opens with
   * three accent dots + bolded names and a "3" on the Home row. Clicking one
   * clears its dot and drops the Home count to 2.
   */
  async readstate(page) {
    void UNREAD_SETUP;
    await open(page, `/chat/${CHATS.cron}`);
    const rows = await rowPoints(page);
    // Home's unread count first — that's the number that has to move.
    await moveCursor(page, 250, 82, 900, { arc: 0.06 });
    await dwell(page, 1300);
    await moveCursor(page, rows[0].x, rows[0].y, 900, { arc: 0.05 }); // NAS (unread)
    await dwell(page, 1000);
    await moveCursor(page, rows[3].x, rows[3].y, 800, { arc: 0.04 }); // Rack UPS (unread)
    await dwell(page, 1400);
    await humanClick(page, "div.chat-row >> nth=3", { moveMs: 500, preClickMs: 400, postClickMs: 900 });
    await settle(page, 1200);
    // Back up to the Home badge so the decrement is what the shot lands on.
    await moveCursor(page, 250, 82, 1100, { arc: 0.06 });
    await dwell(page, 2400);
  },

  /**
   * SHOT 2.4 — triggers, then history.
   *
   * The triggers on this instance are three DISABLED, read-only-or-tool-less
   * ones authored for this shot (production's were stripped from the copy).
   * They never fire; the tab is the point. History then shows the runs that
   * really did happen unattended — the spawned children from Scene 3.
   */
  async triggers(page) {
    await open(page, "/projects/hushpod/triggers");
    await moveCursor(page, 1050, 320, 1000, { arc: 0.06 }); // nightly-digest
    await dwell(page, 1300);
    await moveCursor(page, 1050, 385, 700, { arc: 0.04 }); // feed-health
    await dwell(page, 1100);
    await moveCursor(page, 1300, 445, 700, { arc: 0.04 }); // archive-wrapup / Disabled
    await dwell(page, 1600);
    await humanClick(page, 'button:has-text("History")', {
      moveMs: 900,
      preClickMs: 400,
      postClickMs: 900,
    });
    await settle(page, 1200);
    await moveCursor(page, 900, 175, 900, { arc: 0.05 }); // "13 new runs ran while you were away."
    await dwell(page, 1600);
    // Drift DOWN the run rows rather than scrolling. The banner is the line the
    // shot is for and it sits at the very top of the pane's scroller, so any
    // scroll at all pushes it out of frame — an earlier take ended on a wall of
    // anonymous run ids with the sentence gone.
    await moveCursor(page, 700, 330, 900, { arc: 0.04 });
    await dwell(page, 1000);
    await moveCursor(page, 700, 500, 800, { arc: 0.04 });
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
  const opts = { onPage: pinModel(CHATS.cron) };
  if (name === "phone") {
    opts.width = 430;
    opts.height = 932;
    opts.deviceScaleFactor = 2;
    opts.contextOptions = { isMobile: true, hasTouch: false };
  }
  const out = await record(`s2-${name}`, shots[name], opts);
  console.log(`OK s2-${name} -> ${out.path} (${out.ms}ms)`);
}
