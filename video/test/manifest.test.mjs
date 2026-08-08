/**
 * manifest.test.mjs — ~20s proving timeline for the assembly pipeline.
 *
 * Nothing here is real footage. Five synthetic clips from make-test-clips.mjs
 * (each carrying a fake 2.2s page-load lead-in that MUST be trimmed) plus the
 * two real still assets that already exist in $PADDOCK_VIDEO_OUT.
 *
 * The captions are chosen as a torture test for text handling, not for prose:
 *   seg 1 — straight apostrophes  '   (the character that killed a drawtext chain)
 *   seg 2 — U+2019 ’ and U+00B7 · (the other one)
 *   seg 4 — a colon  :            (drawtext option separator)
 *   seg 5 — an ampersand & and a comma , (XML escape + drawtext arg separator)
 *   seg 6 — an em dash —
 * Segment 3 deliberately has NO caption, to exercise the uncaptioned path.
 */
import { OUT_DIR as OUT } from "../lib/paths.mjs";

export default {
  name: "test",
  target: 90,
  segments: [
    {
      clip: `${OUT}/testclips/t1-dashboard.webm`,
      trimStart: 2.2,
      duration: 3.6,
      caption: "Every project, one keeper",
      captionDelay: 0.4,
      captionDuration: 2.9,
    },
    {
      clip: `${OUT}/testclips/t2-chat.webm`,
      trimStart: 2.2,
      duration: 3.6,
      caption: "It's the keeper's chat",
      captionDelay: 0.35,
      captionDuration: 3.0,
    },
    {
      // Real 3s still-image clip that already exists (VP8, 25fps, static frame).
      clip: `${OUT}/scene2-minipc.webm`,
      trimStart: 0,
      duration: 2.4,
      caption: "Ed’s mini-PC · always on",
      captionDelay: 0.3,
      captionDuration: 1.9,
    },
    {
      // Bare PNG still: no trimStart, held for `duration` at the timeline fps.
      clip: `${OUT}/placeholder-minipc.png`,
      duration: 1.8,
    },
    {
      clip: `${OUT}/testclips/t3-diff.webm`,
      trimStart: 2.2,
      duration: 3.2,
      caption: "Diffs: line by line",
      captionDelay: 0.3,
      captionDuration: 2.6,
    },
    {
      clip: `${OUT}/testclips/t4-triggers.webm`,
      trimStart: 2.2,
      duration: 2.8,
      caption: "Triggers, schedules & diffs",
      captionDelay: 0.3,
      captionDuration: 2.2,
    },
    {
      clip: `${OUT}/testclips/t5-mobile.webm`,
      trimStart: 2.2,
      duration: 2.6,
      caption: "Works on your phone — really",
      captionDelay: 0.3,
      captionDuration: 2.0,
    },
  ],
};
