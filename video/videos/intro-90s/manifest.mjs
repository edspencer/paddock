/**
 * manifest.mjs — the 90-second Paddock intro timeline.
 *
 * Mirrors the storyboard in the paddock project's VIDEO-intro.md. Captions are
 * the noun-phrase labels from that doc; the voiceover is a SEPARATE track and is
 * deliberately not reflected here beyond the scene boundaries.
 *
 * Segments whose clip does not exist yet are SKIPPED with a warning, so this
 * builds a rough cut from whatever footage is in the can. That is intentional:
 * seeing Scene 1 assembled early is worth more than waiting for all 28 shots.
 *
 *   env -u NODE_ENV node video/lib/assemble.mjs \
 *     video/videos/intro-90s/manifest.mjs --name final --target 90
 *
 * Clip paths are absolute, resolved through OUT_DIR — NOT relative to this
 * file. The manifest lives in the repo; the footage does not, and must not.
 */
import fs from "node:fs";
import path from "node:path";
import { OUT_DIR } from "../../lib/paths.mjs";

const OUT = OUT_DIR;

/** Every shot, in order. `pending` ones are simply not shot yet. */
const ALL = [
  // ---------------------------------------------------------------- SCENE 1
  // Cold open. Ed's own zellij — must be captured on his machine; deliberately
  // not faked with a generic terminal.
  { clip: `${OUT}/s0-terminal.webm`, trimStart: 0, duration: 3.0 },

  { clip: `${OUT}/s1-reveal.webm`, trimStart: 2.2, duration: 4.0,
    caption: "Every conversation, named", captionDelay: 0.6, captionDuration: 3.0 },
  { clip: `${OUT}/s1-projects.webm`, trimStart: 2.2, duration: 3.0,
    caption: "Sorted into projects", captionDelay: 0.3, captionDuration: 2.4 },
  { clip: `${OUT}/s1-badges.webm`, trimStart: 2.2, duration: 2.0,
    caption: "Live: what's new, what's working", captionDelay: 0.2, captionDuration: 1.7 },

  // ---------------------------------------------------------------- SCENE 2
  // Trim points below are MEASURED off the recorded clips, not the nominal 2.2s
  // lead-in — same as Scene 3. `s2-reload` especially: the reload itself is the
  // beat, and it lands ~23.6s in, after the ask has been typed and the turn has
  // been running long enough to have something on screen to lose.
  { clip: `${OUT}/s2-reload.webm`, trimStart: 22.6, duration: 4.4,
    caption: "Reload. Nothing lost.", captionDelay: 1.2, captionDuration: 2.6 },
  // Placeholder slate until Ed's photo of the actual box arrives.
  { clip: `${OUT}/scene2-minipc.webm`, trimStart: 0, duration: 3.0,
    caption: "8 watts. On 24/7.", captionDelay: 0.4, captionDuration: 2.4 },
  // Recorded PORTRAIT at 430x932 (recordVideo.size must equal the viewport or
  // Playwright pads with grey instead of scaling). Pre-composited into 16:9
  // against a darkened blurred plate of itself — see s2-phone-16x9.webm.
  { clip: `${OUT}/s2-phone-16x9.webm`, trimStart: 4.6, duration: 5.6,
    caption: "Same session, on your phone", captionDelay: 0.8, captionDuration: 3.6 },
  { clip: `${OUT}/s2-readstate.webm`, trimStart: 11.0, duration: 4.2,
    caption: "Read state follows you", captionDelay: 0.3, captionDuration: 2.4 },
  // Two beats in one clip: the Triggers table, the tab click at ~18.5s, then
  // History's "13 new runs ran while you were away." Cutting it shorter than
  // ~4.5s loses one of them.
  { clip: `${OUT}/s2-triggers.webm`, trimStart: 16.4, duration: 4.8,
    caption: "It runs while you're asleep", captionDelay: 0.6, captionDuration: 3.0 },

  // ---------------------------------------------------------------- SCENE 3
  // The multiplier. Longest scene, best footage.
  // Trim points below are derived from the ACTUAL recorded clips, not the
  // nominal 2.2s lead-in: these are live-turn shots, so the interesting moment
  // lands whenever the keeper got there. s3-spawn especially — the browser boots
  // faster than the keeper's first tool call, so the payoff is the last ~10s.
  { clip: `${OUT}/s3-ask.webm`, trimStart: 18.5, duration: 3.0 },
  { clip: `${OUT}/s3-spawn.webm`, trimStart: 15.5, duration: 5.0,
    caption: "One chat starting three more", captionDelay: 1.4, captionDuration: 3.2 },
  { clip: `${OUT}/s3-tree.webm`, trimStart: 13.5, duration: 3.0,
    caption: "Spawned chats nest under their parent", captionDelay: 0.3, captionDuration: 2.5 },
  { clip: `${OUT}/s3-follow.webm`, trimStart: 16.5, duration: 4.0,
    caption: "Real chats — watch, stop, redirect", captionDelay: 0.8, captionDuration: 2.9 },
  // NOTE for the cut: on the demo instance the self-MCP read + write toggles are
  // ON — Scene 3 needs them or there is no spawn footage. What carries "off by
  // default" is the row below them, "Self-management MCP (projects)" unchecked,
  // plus "Max spawn depth: 1". The cursor lands on exactly those two.
  // Caption reworded from "Off by default. You opt in." — on this instance the
  // self-MCP read+write toggles are visibly ON (Scene 3 needs them), so that
  // caption would be contradicted by the frame it sits on. What the cursor
  // actually lands on is "Self-management MCP (projects)" unchecked and
  // "Max spawn depth: 1", which supports the weaker, true claim.
  { clip: `${OUT}/s3-config.webm`, trimStart: 6.4, duration: 3.4,
    caption: "You choose what it can do", captionDelay: 0.3, captionDuration: 2.4 },
  { clip: `${OUT}/s3-fork.webm`, trimStart: 8.0, duration: 5.0,
    caption: "Fork from any point", captionDelay: 1.4, captionDuration: 3.2 },
  // Bonus texture: the sidebar-row fork action DOES open a naming modal, unlike
  // "Fork from here" which forks eagerly. Uncaptioned — it's a 2s beat.
  { clip: `${OUT}/s3-forkmodal.webm`, trimStart: 10.0, duration: 2.0 },
  { clip: `${OUT}/s3-context.webm`, trimStart: 7.0, duration: 3.0,
    caption: "Context window, always visible", captionDelay: 0.3, captionDuration: 2.4 },

  // ---------------------------------------------------------------- SCENE 4
  { clip: `${OUT}/s4-promote.webm`, trimStart: 5.8, duration: 4.4,
    caption: "Promote a chat into a project", captionDelay: 0.8, captionDuration: 2.9 },
  // The git URL is typed between ~12.5s and ~15.5s; this window catches the
  // typing and the explainer under the field. Never submitted — no clone.
  { clip: `${OUT}/s4-newproject.webm`, trimStart: 12.0, duration: 4.0,
    caption: "Optionally backed by a git repo", captionDelay: 0.3, captionDuration: 2.4 },
  { clip: `${OUT}/s4-changes.webm`, trimStart: 11.5, duration: 4.5,
    caption: "The agent commits its own work", captionDelay: 0.8, captionDuration: 2.9 },
  { clip: `${OUT}/s4-sweeper.webm`, trimStart: 8.6, duration: 4.0,
    caption: "And keeps its own notes current", captionDelay: 0.3, captionDuration: 2.4 },
  // LIVE turn: the rendered file block lands at ~39s. Everything before that is
  // typing and waiting.
  { clip: `${OUT}/s4-sendfile.webm`, trimStart: 38.8, duration: 4.6,
    caption: "Files come back rendered, not attached", captionDelay: 0.8, captionDuration: 2.9 },
  // LIVE turn: the create_chat card lands at ~29s, expands at ~31s.
  { clip: `${OUT}/s4-crossproject.webm`, trimStart: 30.6, duration: 3.4,
    caption: "Chats reach across projects", captionDelay: 0.2, captionDuration: 1.7 },

  // ---------------------------------------------------------------- SCENE 5
  { clip: `${OUT}/s5-montage.webm`, trimStart: 9.0, duration: 4.5,
    caption: "Works with your Claude subscription", captionDelay: 0.5, captionDuration: 3.0 },
  { clip: `${OUT}/s5-close.webm`, trimStart: 6.0, duration: 4.0,
    caption: "Self-hosted. Docker, Compose, Kubernetes.", captionDelay: 0.5, captionDuration: 3.0 },
];

const present = [];
const missing = [];
for (const seg of ALL) {
  (fs.existsSync(seg.clip) ? present : missing).push(seg);
}

if (missing.length) {
  console.warn(
    `\n[intro-90s] ${missing.length}/${ALL.length} shots not yet recorded — SKIPPED:\n` +
      missing.map((s) => `    ${path.basename(s.clip)}`).join("\n") +
      `\n[intro-90s] Building a ROUGH CUT from ${present.length} shots. ` +
      `This is NOT the finished 90s film.\n`,
  );
}

export default {
  name: "final",
  target: 90,
  segments: present,
};
