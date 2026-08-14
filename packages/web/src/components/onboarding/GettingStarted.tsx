import { useState } from "react";
import { SLIDES } from "../../lib/onboarding/slides";
import type { Slide } from "../../lib/onboarding/types";
import { XIcon } from "../icons";
import { Pager } from "./Pager";
import { Card, cx } from "../ui";

/**
 * **Getting Started** — the root Home's mini slideshow (#865).
 *
 * A handful of slides teaching the core of Paddock, with forward/back and a
 * diagram where one earns its place. Unlike {@link TipsPanel} this is NOT
 * randomised: it is a sequence, and a sequence you land in the middle of is not
 * a lesson.
 *
 * ## Closing it is instance config, and the Config screen can put it back
 *
 * The close button is the whole reason the dismissal is server-side (see
 * `useGettingStarted`): closed here, closed in every browser, and restorable
 * from the Config screen's "Getting Started dismissed" toggle — which flips the
 * same key rather than a story about one.
 *
 * ## An empty or single-slide list is a supported shape
 *
 * The slides are content, maintained in `slides.tsx` and replaced wholesale:
 *  - no slides at all renders nothing, not an empty card with a close button;
 *  - one slide renders no arrows and no dots, because paging controls that
 *    cannot move are furniture pretending to be an affordance.
 */
export function GettingStarted({
  slides = SLIDES,
  onClose,
  className,
}: {
  slides?: Slide[];
  onClose: () => void;
  className?: string;
}) {
  const [at, setAt] = useState(0);
  if (slides.length === 0) return null;

  const index = Math.min(at, slides.length - 1);
  const slide = slides[index];
  if (slide === undefined) return null;
  // Clamps rather than wraps, unlike the tips panel: this is a sequence with a
  // first and a last slide, and looping from the end back to the start would
  // quietly restart a lesson the reader had just finished.
  const go = (delta: number) =>
    setAt((i) => Math.max(0, Math.min(slides.length - 1, Math.min(i, slides.length - 1) + delta)));

  return (
    <Card className={cx("flex flex-col", className)} data-testid="home-getting-started">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
          Getting started
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Getting started"
          title="Close — restore it from Config"
          className="focus-visible:focus-ring -mr-1 rounded-md p-1 text-fg-subtle transition-colors can-hover:hover:bg-surface-hover can-hover:hover:text-fg"
        >
          <XIcon width={14} height={14} />
        </button>
      </div>

      <div key={slide.id} className="min-w-0 flex-1">
        {slide.diagram !== undefined && (
          <div className="mb-3 flex items-center justify-center rounded-xl border border-edge bg-surface px-3 py-2 text-fg-subtle">
            {slide.diagram}
          </div>
        )}
        <h4 className="text-sm font-semibold text-fg">{slide.title}</h4>
        <p className="mt-1 text-sm text-fg-muted">{slide.body}</p>
      </div>

      {/* The SAME control Tips uses — see `Pager` for why this is one component
          rather than two that happen to agree today. This card used to carry
          dots bottom-left and arrows bottom-right while Tips had a counter and
          arrows top-right: one row, two answers. Clamped, not wrapping: looping
          from the last slide back to the first quietly restarts a lesson the
          reader has just finished. */}
      <Pager
        index={index}
        count={slides.length}
        backLabel="Previous slide"
        nextLabel="Next slide"
        onBack={() => go(-1)}
        onNext={() => go(1)}
        clamped
        itemNoun="Slide"
      />
    </Card>
  );
}
