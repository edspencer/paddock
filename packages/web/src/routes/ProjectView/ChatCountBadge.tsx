/**
 * The chat-list header count — informational, and a filter.
 *
 * With nothing running it is the plain number it has always been. The moment a
 * turn goes live it SPLITS: total on the left, running count on the right, and
 * the right half toggles the list down to just those chats. The running chats
 * were always findable by hunting for spinning rings down the list; this makes
 * them a target you can hit.
 *
 * Two real buttons, not one control with a click-position check — the left half
 * ("show everything") and the right half ("show only what's running") are
 * separate actions, so they get separate tab stops, labels and pressed state.
 */
export function ChatCountBadge({
  activeTotal,
  shownCount,
  searching,
  runningCount,
  runningOnly,
  setRunningOnly,
}: {
  /** Unfiltered non-archived chat count — the denominator, and the left half. */
  activeTotal: number;
  /** How many chats the list is actually rendering (the search numerator). */
  shownCount: number;
  searching: boolean;
  /** Chats in this project with a live turn right now. */
  runningCount: number;
  runningOnly: boolean;
  setRunningOnly: (value: boolean) => void;
}) {
  // While searching the left half carries the existing "shown/total" reading
  // (#491), so the badge never loses the count it already had.
  const totalLabel = searching ? `${shownCount}/${activeTotal}` : `${activeTotal}`;
  const totalTitle = searching
    ? `${shownCount} of ${activeTotal} chats shown`
    : `${activeTotal} chats`;

  // Nothing running: stay exactly as before — a quiet number, not a control.
  // A split button that is permanently half-empty would be noise on the ~99% of
  // projects that are idle at any given moment.
  if (runningCount === 0 && !runningOnly) {
    return (
      <span className="text-[11px] text-paddock-400" title={totalTitle}>
        {totalLabel}
      </span>
    );
  }

  return (
    <span
      role="group"
      aria-label="Chat count and running filter"
      className="flex items-stretch overflow-hidden rounded-full border border-paddock-300/70 text-[11px] leading-none dark:border-paddock-700"
    >
      <button
        type="button"
        onClick={() => setRunningOnly(false)}
        aria-pressed={!runningOnly}
        title={runningOnly ? "Show all chats" : totalTitle}
        aria-label={runningOnly ? `Show all ${activeTotal} chats` : `${activeTotal} chats`}
        className={`px-1.5 py-0.5 transition-colors ${
          runningOnly
            ? "text-paddock-400 hover:bg-paddock-200/70 hover:text-paddock-700 dark:hover:bg-paddock-700 dark:hover:text-paddock-100"
            : "bg-paddock-200/70 font-medium text-paddock-600 dark:bg-paddock-800 dark:text-paddock-200"
        }`}
      >
        {totalLabel}
      </button>
      <button
        type="button"
        onClick={() => setRunningOnly(!runningOnly)}
        aria-pressed={runningOnly}
        title={
          runningOnly
            ? "Showing only running chats — click to show all"
            : `Show only the ${runningCount} chat${runningCount === 1 ? "" : "s"} running now`
        }
        aria-label={`Show only running chats (${runningCount} running)`}
        className={`flex items-center gap-1 border-l border-paddock-300/70 px-1.5 py-0.5 transition-colors dark:border-paddock-700 ${
          runningOnly
            ? "bg-accent font-semibold text-white"
            : "font-medium text-accent hover:bg-accent/10"
        }`}
      >
        {/* The same stepped spinner the per-chat rings use, so "running" looks
            like one thing across the sidebar. `spin-eco` is already
            prefers-reduced-motion aware (index.css). */}
        <span
          aria-hidden="true"
          className={`spin-eco h-2.5 w-2.5 rounded-full border-[1.5px] border-current border-t-transparent`}
        />
        {runningCount}
      </button>
    </span>
  );
}
