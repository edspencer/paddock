// Whether this browser has dismissed the #882 transcripts-migration offer.
//
// ARCHITECTURE §3, storage class 2 — a client-only preference, same read/write
// + try-catch shape as `chatViewPrefs.ts`. That placement is a decision, not a
// convenience, and the repo has a rule pointing the other way: #488 removed the
// `paddock:lastSeen:*` localStorage mirror because read state has to follow a
// user across devices, and Class 3 sidecars are the house answer for anything
// that must. So this needs its own argument.
//
// **Losing this entry costs one more sighting of an offer. Losing the offer
// costs the feature.** Class 2's own criterion is that nothing in it is
// authoritative and losing it "costs a draft or a scroll position, nothing
// more" — which is exactly the shape of this. Read state fails the criterion in
// the other direction: claiming a reply was read when it was not is a false
// statement about the user's data.
//
// The asymmetry is what settles it. A server-side dismissal is one instance-wide
// switch that ANY browser can throw, permanently, to remove the only discovery
// surface this feature has — on every device, for everyone using the instance.
// A per-browser one degrades toward showing the offer again, which is the
// direction #882 asks for when it insists the migration stay findable. Given a
// bug on either side, "the banner came back on my phone" is a shrug and "nobody
// on this instance can ever find the migration again" is the feature not
// shipping.
//
// Two supporting points, neither of them load-bearing on its own:
//
//  - There is nothing to write to. #899 shipped the read half of the migration
//    API; no endpoint accepts client state, and inventing a preferences sidecar
//    to hold one boolean is a larger design than the banner it serves.
//  - The offer is not lost when it is dismissed. The Config screen carries it
//    whenever the instance is on `own` (design §10.4), which is what the toast
//    on dismissal points at, and is why hiding the banner is allowed to be as
//    forgetful as clearing a browser profile.

const KEY = "paddock:transcriptsMigration:dismissed";

/**
 * Has the offer been dismissed in this browser?
 *
 * Only the exact value we write counts as a dismissal. Anything else — unset,
 * corrupt, a storage that throws in private mode — falls back to SHOWING the
 * offer, because the fallback must never be the state that hides something.
 */
export function readMigrationOfferDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Persist the dismissal, or clear it. Best effort; never throws.
 *
 * Clearing is called when the probe says the instance is not eligible, so the
 * flag cannot outlive the offer it silenced: an instance that migrates and later
 * finds itself back on `own` with chats pending gets one fresh offer rather than
 * inheriting a dismissal from a migration two months ago.
 */
export function writeMigrationOfferDismissed(value: boolean): void {
  try {
    if (value) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
