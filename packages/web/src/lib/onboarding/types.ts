import type { ReactNode } from "react";

/**
 * The shapes the root Home's onboarding content is written against (#865).
 *
 * These three lists are CONTENT, maintained separately from the components that
 * render them: `tips.ts`, `whats-new.ts` and `slides.tsx` are edited by whoever
 * is writing the words, and nothing in here knows how many entries they hold.
 * Every consumer must therefore survive a list of length 0 and a list of length
 * 1 — no orphan arrows, no crash, no "1 of 0" — because the lists genuinely vary
 * in length between releases and a short one is not a bug.
 *
 * Kept deliberately plain: no markdown, no JSX in the strings. The panels render
 * these into a small fixed-height card, and the moment a body can carry markup
 * the card stops being able to promise it will fit.
 */

/** One tip-of-the-day: a thing Paddock can do that a new user would not guess. */
export interface Tip {
  /** Stable kebab-case slug. Never reused for different content. */
  id: string;
  /** Short — roughly six words. */
  title: string;
  /** 1–2 sentences, plain text, no markdown. */
  body: string;
  /** Optional deep link to the relevant docs page. */
  href?: string;
}

/**
 * One line about something that landed in a release, linking out to the website
 * entry where the screenshots and videos already live (#866 owns the list and
 * its ~12-entry cap; this only says what one entry looks like).
 */
export interface WhatsNewEntry {
  id: string;
  /** e.g. "0.69". */
  version: string;
  title: string;
  /** Exactly one line. */
  body: string;
  /** The website entry. Not optional: an entry nobody can read more about is a changelog line. */
  href: string;
}

/** One Getting Started slide. */
export interface Slide {
  id: string;
  title: string;
  body: string;
  /**
   * Omitted ENTIRELY when the slide is better without one. An empty box where a
   * diagram would go is worse than a slide that never promised one, so the
   * renderer keys off presence rather than reserving the space.
   */
  diagram?: ReactNode;
}
