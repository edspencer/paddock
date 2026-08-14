import type { Slide } from "./types";

/**
 * Getting Started slides for the root Home (#865).
 *
 * PLACEHOLDER — the minimum that makes the app build and the slideshow step.
 * The real six slides are #868 and replace this file wholesale, diagrams
 * included; nothing here is meant to teach anyone anything.
 *
 * **No diagrams here on purpose.** `Slide.diagram` is optional and #868 owns the
 * medium — HTML/CSS built from the design tokens, having rejected inline SVG on
 * rendered evidence (SVG text will not hold the type scale across the card's
 * width range, and `rx` cannot follow `--radius-*`, so Sci-Fi's square corners
 * come out rounded). A throwaway diagram here would ship a bad one on the
 * first-run screen for the sake of a placeholder. Both branches of the renderer
 * are covered in `GettingStarted.test.tsx` against its own fixtures.
 *
 * Say **Claude** in UI microcopy and **Claude Code** where the product is meant
 * (#871). There is no user-facing noun for a per-project agent.
 */
export const SLIDES: Slide[] = [
  {
    id: "projects-are-directories",
    title: "A project is a directory",
    body: "Point Paddock at a directory on this machine and Claude works there — reading, writing and running commands in that directory, with its conversations kept alongside it.",
  },
  {
    id: "work-continues",
    title: "Work carries on without you",
    body: "Turns keep running after you close the tab, and Home shows you what is still going and what has replied since you last looked.",
  },
];
