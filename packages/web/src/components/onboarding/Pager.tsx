import { ChevronRightIcon } from "../icons";

/**
 * The pager shared by the two onboarding cards (#865).
 *
 * ## One component, because "make them match" is what already failed
 *
 * The two cards sit side by side in one row doing the same job. In an earlier
 * shape — a Tips/What's New panel beside a Getting Started slideshow — they had
 * already drifted to different corners AND different notations: `2/3 ‹ ›` top
 * right on one, dots bottom left with arrows bottom right on the other. One row,
 * two answers, which reads as broken. Both are now the same `EntryCard` rendered
 * twice, so they cannot drift; this stays a separate component so that a future
 * card of a different shape has one to reuse rather than a reason to invent its
 * own.
 *
 * ## Why a counter and not dots
 *
 * Dots do not survive the real content. #867 ships 31 tips; 31 dots is a smear,
 * and a control that only works for a short list is not a shared control. `n/N`
 * reads the same at 2 and at 31.
 *
 * ## Why the bottom
 *
 * The cards are equal-height (they share a grid row), so a bottom-anchored
 * footer puts both pagers on the same baseline — the clearest available signal
 * that they do the same thing — and spends the height the shorter card gains
 * from being equalised. Anchored at the top, that height would collect as dead
 * space under the text instead.
 */
export function Pager({
  index,
  count,
  backLabel,
  nextLabel,
  onBack,
  onNext,
  clamped = false,
  itemNoun,
}: {
  /** Zero-based position of the item on show. */
  index: number;
  count: number;
  /** `aria-label` for the back arrow — the cards page over different things. */
  backLabel: string;
  nextLabel: string;
  onBack: () => void;
  onNext: () => void;
  /**
   * Stop at the ends rather than wrap, disabling the arrow that cannot move.
   * A SEQUENCE clamps (looping would quietly restart a lesson just finished); a
   * bag of tips wraps (there is no end to be stranded at).
   */
  clamped?: boolean;
  /** Singular noun for the screen-reader status, e.g. "Tip". */
  itemNoun: string;
}) {
  // Nothing to page. Rendered as nothing at all rather than as two dead arrows:
  // controls that cannot move are furniture pretending to be an affordance, and
  // the content lists genuinely arrive at length 1 (and 0).
  if (count <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-between gap-2">
      <span className="font-mono tabular text-2xs text-fg-subtle" aria-hidden="true">
        {index + 1}/{count}
      </span>
      {/* The counter above is glanceable but reads as "two slash six" aloud. */}
      <span className="sr-only" role="status">
        {itemNoun} {index + 1} of {count}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Arrow label={backLabel} back disabled={clamped && index === 0} onClick={onBack} />
        <Arrow label={nextLabel} disabled={clamped && index === count - 1} onClick={onNext} />
      </div>
    </div>
  );
}

/** One arrow. `back` rotates the shared chevron; the set has no left one. */
function Arrow({
  label,
  back = false,
  disabled = false,
  onClick,
}: {
  label: string;
  back?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="focus-visible:focus-ring rounded-md p-1 text-fg-subtle transition-colors disabled:opacity-30 can-hover:hover:enabled:bg-surface-hover can-hover:hover:enabled:text-fg"
    >
      <ChevronRightIcon width={14} height={14} className={back ? "rotate-180" : ""} />
    </button>
  );
}
