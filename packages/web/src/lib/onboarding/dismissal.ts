// Whether this browser has dismissed one of root Home's onboarding cards
// (What's New, Tips).
//
// A client-only preference, same read/write + try-catch shape as
// `migrationOfferDismissal.ts`, and for the same reason: losing it costs one
// more sighting of a card, nothing more.
//
// A dismissal is recorded against the card's CONTENT, not as a bare flag: the
// stored value is the list's entry ids, and the card counts as dismissed only
// while that list is unchanged. So a release that adds a What's New entry (or a
// new tip) brings the card back once, without a reset control to find.

const PREFIX = "paddock:onboardingDismissed:";

/** The fingerprint a dismissal is stored against: the list's ids, in order, as a JSON array
 * so no id's content can make two different lists look the same. */
function fingerprint(ids: readonly string[]): string {
  return JSON.stringify(ids);
}

/**
 * Has `card` been dismissed while showing exactly these entries? Anything other
 * than a matching stored value — unset, stale, a storage that throws — counts
 * as NOT dismissed, so the fallback is always the state that shows the card.
 */
export function readCardDismissed(card: string, ids: readonly string[]): boolean {
  try {
    return localStorage.getItem(PREFIX + card) === fingerprint(ids);
  } catch {
    return false;
  }
}

/** Record that `card` was dismissed while showing these entries. Never throws. */
export function writeCardDismissed(card: string, ids: readonly string[]): void {
  try {
    localStorage.setItem(PREFIX + card, fingerprint(ids));
  } catch {
    /* ignore */
  }
}
