/**
 * The shapes the root Home's onboarding content is written against (#865).
 *
 * Both lists are CONTENT, maintained separately from the component that renders
 * them: `tips.ts` and `whats-new.ts` are edited by whoever is writing the words,
 * and nothing in here knows how many entries they hold. `EntryCard` must
 * therefore survive a list of length 0 and a list of length 1 — no orphan
 * arrows, no crash, no "1 of 0" — because the lists genuinely vary in length
 * between releases and a short one is not a bug.
 *
 * Kept deliberately plain: no markdown, no JSX in the strings. The card renders
 * these at a height it shares with its neighbour, and the moment a body can
 * carry markup it stops being able to promise it will fit.
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
