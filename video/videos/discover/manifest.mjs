/**
 * manifest.mjs — THE CUT for the Discover clip (~19s).
 *
 *   env -u NODE_ENV node video/lib/assemble.mjs \
 *     video/videos/discover/manifest.mjs --name discover --no-gif
 *
 * Serves the 0.68 What's New entry, which has no image at all. Discover is a
 * process — scan, list, choose, import, projects appear with their
 * conversations — and a still can only show one frame of it.
 *
 * 1280x800 and segmentCrf 34 for the same reasons as videos/accent-picker:
 * it matches website/public/demo/config-filter.mp4, and 34 was chosen by
 * comparing crops of the smallest type rather than by bitrate alone.
 *
 * TRIM POINTS ARE MEASURED, NOT NOMINAL — read off 2 fps contact sheets:
 *
 *   discover-land    list painted ~1.0s                        (len 8.76)
 *   discover-choose  third row unticked ~5.0s, footer counts down (len 10.08)
 *   discover-import  click ~4.6s · "Importing…" ~5.2s · result ~6.0s (len 12.32)
 *   discover-chat    project page painted ~1.2s                (len 8.32)
 *
 * Re-recording `land` or `choose` requires re-running seed-discover.mjs FIRST:
 * import is one-way and has already consumed the candidates. That failure is
 * silent — you get a correctly-rendered empty list, not an error.
 *
 * CAPTIONS ARE TAKEN FROM THE UI'S OWN WORDS where they make a promise. The
 * screen says "Importing one links it as a project and copies its conversations
 * in; your own history is never moved or deleted", so the caption is "Your
 * history is never moved or deleted" — not the storyboard's "Nothing is cloned.
 * Nothing is written into your directories", which overstates it in one
 * direction (conversations ARE copied into Paddock) and is vaguer in the other.
 */
import { OUT_DIR as OUT } from "../../lib/paths.mjs";

/**
 * Scaled from caption.mjs's 1920-wide defaults to 1280. bottomMargin 100 puts
 * the pill at y=651, in the empty band below the candidate list (which ends
 * ~y=550) — this screen, unlike /config, has room at the bottom.
 */
const CAPTION = { size: 24, bottomMargin: 100, accentBarWidth: 3, accentGap: 10 };
const cap = (caption, captionDelay, captionDuration) => ({
  caption,
  captionDelay,
  captionDuration,
  captionStyle: CAPTION,
});

export default {
  width: 1280,
  height: 800,
  gifEnabled: false,
  target: 19,
  segmentCrf: 34,
  segments: [
    // The list itself: three directories, their conversation counts and when
    // each was last active. No cursor movement — this frame IS the claim.
    { clip: `${OUT}/discover-land.webm`, trimStart: 2.4, duration: 4.0,
      ...cap("History you already have", 0.5, 3.0) },

    // Choosing. The storyboard said "tick two rows"; the shipping UI arrives
    // with everything already ticked, so the same control is demonstrated by
    // UNticking one — the footer counts down to "7 conversations from 2
    // directories" and the button to "Import 2 projects".
    { clip: `${OUT}/discover-choose.webm`, trimStart: 3.8, duration: 4.6,
      ...cap("Choose what to import", 0.4, 2.6) },

    // The import. The clip re-does the untick off-camera first (see scene1.mjs)
    // and is trimmed in AFTER it, so this segment enters on the same "Import 2
    // projects" state the previous segment ended on. Click ~4.5s, "Importing…"
    // ~4.8s, then the result panel — "2 projects, 7 conversations" — with both
    // new projects live in the sidebar.
    { clip: `${OUT}/discover-import.webm`, trimStart: 3.8, duration: 6.0,
      ...cap("Never moved, never deleted", 1.6, 3.0) },

    // And the conversations are really there, not just the folder.
    { clip: `${OUT}/discover-chat.webm`, trimStart: 2.4, duration: 4.4,
      ...cap("Projects, with their conversations", 0.5, 3.0) },
  ],
};
