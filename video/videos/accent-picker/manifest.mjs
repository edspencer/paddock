/**
 * manifest.mjs — THE CUT for the accent-picker docs clip (~24s).
 *
 *   env -u NODE_ENV node video/lib/assemble.mjs \
 *     video/videos/accent-picker/manifest.mjs --name accent-picker --target 24 --no-gif
 *
 * 1280x800, not the harness default 1920x1080: this ships into
 * website/public/demo/ alongside config-filter.mp4 (1280x800) and
 * subagent-bar.mp4 (1280x720), and it is displayed in a docs column. Recording
 * at 1920 and downscaling would render the UI text 1.5x smaller than native at
 * the size it is actually watched, and small UI text is the entire payload.
 *
 * --no-gif is deliberate and settled: DemoVideo.astro's own header carries the
 * measurement (MP4 1.1 MB vs GIF 6.1 MB *and already too soft to read* on a
 * comparable clip). GIF's 256-colour dithering destroys small UI text, and on
 * THIS clip it would also band the very colour gradients that are the subject.
 *
 * TRIM POINTS ARE MEASURED, NOT NOMINAL. Each was read off a 2 fps contact
 * sheet of the actual clip, not assumed from the 2.2s lead-in. Re-record any
 * shot and you must re-derive its trim point — the clicks land wherever the
 * cursor animation got to, which moves between takes.
 *
 *   accent-hues.webm    teal 4.6s · ember 8.5s · violet 11.4s   (len 15.48)
 *   accent-persist.webm violet 4.7s · navigation 7.3s           (len 13.40)
 *   accent-themes.webm  parchment 4.8s · terminal 8.8s · sci-fi 11.8s (len 17.32)
 *
 * DURATIONS ARE EXACT FRAME MULTIPLES (n/25 = 0.04s steps). Segments are cut
 * with `-frames:v round(duration x 25)`, so a duration of 2.1s asks for 52.5
 * frames, gets 53, and runs 0.02s long. Four such segments put the film two
 * frames past its own expected total and assemble.mjs reported
 * `*** MISMATCH ***` — correctly. It is a rounding artefact rather than a
 * defect, but the whole point of the exact-frame arithmetic is that the check
 * stays meaningful, so the durations below are quantised instead of the
 * warning being ignored.
 *
 * Two clips are each cut into TWO segments so a beat can carry its own caption
 * — same source file, different trims, hard cut between. That is cheaper and
 * steadier than re-recording the shot twice.
 *
 * ⛔ CAPTIONS: no beat here makes a readability claim, in EITHER direction.
 * solve() does treat the contrast floor as a guarantee and repairFill does
 * repair derived tokens, so "nothing is enforced" is false; but a FAILING solve
 * is applied silently — `hit` discarded, report.ok never surfaced (#813; #816
 * for the tint equivalent) — so "every combination passes AA" is false too. The
 * claim is "the whole UI follows", which the frames show and which is
 * independent of both issues.
 */
import { OUT_DIR } from "../../lib/paths.mjs";

const OUT = OUT_DIR;

export default {
  width: 1280,
  height: 800,
  gifEnabled: false,
  target: 24,
  // The join is `-c copy`, so the SHIPPED bitrate is set by segmentCrf, not
  // finalCrf — finalCrf only bites when --crossfade forces a second encode.
  // The harness default (16) is tuned for a 1920x1080 hero film and produced a
  // 4.4 MB file here: it was faithfully preserving VP8's own 1 Mbit/s
  // compression noise. 32 lands at ~1.2 MB — in line with subagent-bar.mp4 (1.07 MB, 35s)
  // in website/public/demo/, with no visible difference on UI chrome.
  segmentCrf: 32,
  segments: [
    // Establish. Still frame, no cursor movement — the cut itself is the beat.
    {
      clip: `${OUT}/accent-open.webm`,
      trimStart: 2.4,
      duration: 2.12,
      caption: "Appearance lives in Config",
      captionDelay: 0.25,
      captionDuration: 1.7,
    },

    // Teal. One click, five accented surfaces move at once: the wordmark, the
    // Config row, the chip borders, and the PREVIEW row's Send / link / dot.
    //
    // The caption ENUMERATES rather than generalising, for two reasons. "Pick
    // any colour" — the first version — is the ACCENT COLOUR section's own
    // subtitle, verbatim, legible in the same frame: a caption that repeats
    // on-screen text spends three seconds saying nothing. And the tempting
    // generalisation, "every surface follows", is contradicted by a label in
    // this very frame: the PREVIEW row ends "status hues (theme's, not yours)"
    // and those four dots deliberately do NOT track the accent. Chrome, buttons
    // and links do, all three visibly, and nothing on screen argues with it.
    {
      clip: `${OUT}/accent-hues.webm`,
      trimStart: 4.1,
      duration: 3.92,
      caption: "Chrome, buttons and links",
      captionDelay: 0.9,
      captionDuration: 2.6,
    },

    // Ember, then Violet. Two more recolours with no save step in between.
    //
    // The caption deliberately does NOT say "no restart", though the panel's own
    // subtitle does. This beat is on /config, and the amber banner at the foot
    // of that page reads "...take effect only after the server restarts". Both
    // statements are true and they are about different scopes — appearance is
    // per-browser and immediate; the banner is about file-backed instance config
    // — but a viewer seeing both words in one frame reads a contradiction, and a
    // 24-second clip is exactly where nobody can stop to reason about scope.
    // Dropping the colliding word is right, but it does not go far enough: the
    // subtitle overhead already reads "Applies immediately — no save, no
    // restart", so ANY phrasing of the immediacy claim is repeating text the
    // viewer can already read. So this beat stops making that claim at all and
    // says something the frame does not: how many named hues there are. Ten
    // chips, Ember through Rose, all of them on screen and none of them
    // contradicted. Caught by looking at the frame, not by reading the manifest.
    {
      clip: `${OUT}/accent-hues.webm`,
      trimStart: 8.0,
      duration: 4.72,
      caption: "Ten named hues",
      captionDelay: 0.4,
      captionDuration: 3.2,
    },

    // Route change. Trimmed in AFTER the pick so the shot is the navigation;
    // the violet on the destination was genuinely produced on camera.
    {
      clip: `${OUT}/accent-persist.webm`,
      trimStart: 6.8,
      duration: 3.52,
      caption: "Everywhere, not just here",
      captionDelay: 1.0,
      captionDuration: 2.3,
    },

    // Parchment. Ground, chrome and typeface all change, so the whole frame
    // moves — the longest hold in the film, for the bitrate's sake.
    {
      clip: `${OUT}/accent-themes.webm`,
      trimStart: 4.2,
      duration: 4.4,
      caption: "Four themes",
      captionDelay: 0.9,
      captionDuration: 2.8,
    },

    // Terminal, then Sci-Fi. The longest segment, and deliberately so: Sci-Fi
    // does not land until source 12.0s, so the first cut of this gave the
    // payoff beat a 1.0s hold and it read as an accident of the ending. Note
    // segments 4 and 5 are CONTIGUOUS in the source (4.2→8.6→14.2) — shortening
    // either one without moving the other opens a gap and the cursor jumps.
    // Lands on Sci-Fi; the loop back to Foundation reads as a reset.
    {
      clip: `${OUT}/accent-themes.webm`,
      trimStart: 8.6,
      duration: 5.6,
      caption: "Ground, type and chrome, together",
      captionDelay: 0.5,
      captionDuration: 3.4,
    },
  ],
};
