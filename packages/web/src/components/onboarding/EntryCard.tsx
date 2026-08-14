import { useState } from "react";
import type { Tip, WhatsNewEntry } from "../../lib/onboarding/types";
import { Pager } from "./Pager";
import { Card, cx } from "../ui";

/**
 * One onboarding card: a heading, ONE entry from a list, and a pager (#865).
 *
 * The root Home renders two of these side by side — **What's New** and **Tips**.
 *
 * ## Why two cards rather than one two-tab panel
 *
 * This started as a single panel with a Tips / What's New toggle, on the theory
 * that the two are the same shape of content and a card each would spend twice
 * the width saying so. In practice the toggle cost more than it saved: it hid
 * half the content behind a click, and the randomised tab meant the card you
 * landed on was a coin toss — you could not go looking for what changed in the
 * last release, because the release notes might simply not be the visible tab.
 *
 * Two cards say both things at once, and each keeps a stable identity in a fixed
 * place, which is what makes "the left one is the release notes" learnable.
 *
 * ## Random entry per landing, and stateless on purpose
 *
 * Each card rolls its own entry per mount, and Home unmounts these when you
 * leave it, so every visit surfaces something different. There is deliberately
 * no seen-tracking, no history, no "don't show this again": random each time IS
 * the feature, and the moment it remembers what you have read it needs storage,
 * a reset, and an answer for what happens when the list changes.
 *
 * These are permanent — there is no close button. A card that re-randomises per
 * visit only pays for its width if it is always there.
 *
 * ## The lists vary in length, including to zero
 *
 * The content lists are maintained separately from this file (`tips.ts`,
 * `whats-new.ts`, the latter under #866's cap), so their lengths are not this
 * component's to assume:
 *  - an EMPTY list renders nothing at all, because a card whose only content is
 *    "nothing to show" is worse than the gap it fills — and the caller drops the
 *    grid to one column when only one card survives, so the other does not end
 *    up marooned at half width;
 *  - a SINGLE entry renders no arrows and no counter (`Pager` returns null below
 *    two), which is the orphan-arrow bug this note exists to prevent.
 */
export function EntryCard({
  label,
  icon: Icon,
  entries,
  itemNoun,
  testId,
  /**
   * Injectable randomness. Defaults to `Math.random`; tests pass a constant so
   * "which entry" stops being a coin toss they have to tolerate.
   */
  random = Math.random,
  className,
}: {
  label: string;
  icon: (props: { width?: number; height?: number }) => JSX.Element;
  entries: Array<Tip | WhatsNewEntry>;
  /** Singular noun for the pager's screen-reader text, e.g. "Tip". */
  itemNoun: string;
  testId: string;
  random?: () => number;
  className?: string;
}) {
  /**
   * One roll, at mount, in a `useState` initializer rather than an effect so the
   * first painted frame is already the random one — an entry that visibly
   * changes a beat after landing reads as a bug, not as a feature.
   */
  const [initial] = useState(() =>
    entries.length === 0 ? 0 : Math.min(Math.floor(random() * entries.length), entries.length - 1),
  );
  const [index, setIndex] = useState(initial);

  if (entries.length === 0) return null;

  // Clamped rather than reset: the list can shrink under a mounted card, and
  // `entries[index]` being undefined is how that becomes a blank card.
  const at = Math.min(index, entries.length - 1);
  const entry = entries[at];
  if (entry === undefined) return null;

  const go = (delta: number) => {
    // Wraps: the arrows are a loop through a short list, not a scrollbar, so
    // there is no end to be stranded at and neither arrow is ever disabled.
    setIndex((i) => {
      const from = Math.min(i, entries.length - 1);
      return (from + delta + entries.length) % entries.length;
    });
  };

  return (
    <Card className={cx("flex flex-col", className)} data-testid={testId}>
      <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-fg-muted">
        <Icon width={13} height={13} />
        {label}
      </div>

      {/* `key` remounts the body on every move, so a screen reader announces the
          new entry instead of silently re-labelling the one it is already on. */}
      <div key={entry.id} className="min-w-0 flex-1">
        {"version" in entry && (
          <span className="mb-1 inline-block rounded-md bg-surface-active px-1.5 py-0.5 font-mono tabular text-2xs text-fg-muted">
            v{entry.version}
          </span>
        )}
        <h4 className="text-sm font-semibold text-fg">{entry.title}</h4>
        <p className="mt-1 text-sm text-fg-muted">{entry.body}</p>
        {entry.href !== undefined && entry.href !== "" && (
          <a
            href={entry.href}
            target="_blank"
            rel="noreferrer"
            className="focus-visible:focus-ring mt-2 inline-block rounded-md text-xs text-accent can-hover:hover:underline"
          >
            Read more →
          </a>
        )}
      </div>

      {/* Bottom-anchored, and the SAME control the sibling card uses — the two
          share a grid row, so both pagers land on one baseline. */}
      <Pager
        index={at}
        count={entries.length}
        backLabel={`Previous ${label} entry`}
        nextLabel={`Next ${label} entry`}
        onBack={() => go(-1)}
        onNext={() => go(1)}
        itemNoun={itemNoun}
      />
    </Card>
  );
}
