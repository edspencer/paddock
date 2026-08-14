import { useMemo, useState } from "react";
import { TIPS } from "../../lib/onboarding/tips";
import { WHATS_NEW } from "../../lib/onboarding/whats-new";
import type { Tip, WhatsNewEntry } from "../../lib/onboarding/types";
import { BoltIcon, ChevronRightIcon, SparkIcon } from "../icons";
import { Card, cx } from "../ui";

/**
 * **Tips / What's New** — the root Home's two-tab panel (#865).
 *
 * One component, not two columns: they are the same shape of content (a title,
 * a line, a link out) and giving each its own card would spend twice the width
 * saying so. A small toggle picks the tab; back/forward arrows page through
 * every entry that tab has. Old-fashioned tip-of-the-day.
 *
 * ## Random on every landing, and stateless on purpose
 *
 * BOTH the tab and the entry are randomised per mount, and Home unmounts this
 * when you leave it, so every visit surfaces something different. There is
 * deliberately no seen-tracking, no history, no "don't show this again": random
 * each time IS the feature, and the moment it remembers what you have read it
 * needs storage, a reset, and an answer for what happens when the list changes.
 *
 * Unlike the Getting Started slideshow this is permanent — there is no close
 * button. A panel that re-randomises per visit only pays for its width if it is
 * always there.
 *
 * ## Both lists vary in length, including to zero
 *
 * The content lists are maintained separately from this file (`tips.ts`,
 * `whats-new.ts`, the latter under #866's cap), so their lengths are not this
 * component's to assume:
 *  - a tab with NO entries is not offered, and never randomly selected;
 *  - with both lists empty the whole panel renders nothing, because a card whose
 *    only content is "nothing to show" is worse than the gap it fills;
 *  - a single-entry tab renders no arrows and no counter — paging controls that
 *    cannot move are the orphan-arrow bug this note exists to prevent.
 */
export function TipsPanel({
  tips = TIPS,
  whatsNew = WHATS_NEW,
  /**
   * Injectable randomness. Defaults to `Math.random`; tests pass a constant so
   * "which tab, which entry" stops being a coin toss they have to tolerate.
   */
  random = Math.random,
  className,
}: {
  tips?: Tip[];
  whatsNew?: WhatsNewEntry[];
  random?: () => number;
  className?: string;
}) {
  /**
   * The tabs that actually have something to say, in display order. Computed
   * before any randomisation so an empty list can never be landed on.
   */
  const tabs = useMemo(
    () =>
      [
        { id: "tips" as const, label: "Tips", icon: SparkIcon, count: tips.length },
        { id: "whats-new" as const, label: "What's New", icon: BoltIcon, count: whatsNew.length },
      ].filter((t) => t.count > 0),
    [tips.length, whatsNew.length],
  );

  /**
   * One roll, at mount, for both questions. In a `useState` initializer rather
   * than an effect so the first painted frame is already the random one — a tab
   * that visibly switches a beat after landing reads as a bug, not a feature.
   */
  const [initial] = useState(() => {
    if (tabs.length === 0) return { tab: 0, index: 0 };
    const tab = Math.min(Math.floor(random() * tabs.length), tabs.length - 1);
    const count = tabs[tab]?.count ?? 1;
    return { tab, index: Math.min(Math.floor(random() * count), count - 1) };
  });

  const [tabIndex, setTabIndex] = useState(initial.tab);
  const [index, setIndex] = useState(initial.index);

  if (tabs.length === 0) return null;

  const active = tabs[Math.min(tabIndex, tabs.length - 1)];
  if (active === undefined) return null;
  const entries: Array<Tip | WhatsNewEntry> = active.id === "tips" ? tips : whatsNew;
  // Clamped rather than reset: switching to a shorter tab must land on a real
  // entry, and `entries[index]` being undefined is how that becomes a blank card.
  const at = Math.min(index, entries.length - 1);
  const entry = entries[at];
  if (entry === undefined) return null;
  const paged = entries.length > 1;

  const go = (delta: number) => {
    // Wraps: the arrows are a loop through a short list, not a scrollbar, so
    // there is no end to be stranded at and neither arrow is ever disabled.
    setIndex((i) => {
      const from = Math.min(i, entries.length - 1);
      return (from + delta + entries.length) % entries.length;
    });
  };

  return (
    <Card className={cx("flex flex-col", className)} data-testid="home-tips-panel">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="tablist" aria-label="Tips and What's New">
          {tabs.map((t, i) => {
            const selected = t.id === active.id;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => {
                  setTabIndex(i);
                  // A fresh tab opens at its first entry rather than carrying the
                  // previous tab's position across — position means nothing once
                  // the list underneath it has changed.
                  setIndex(0);
                }}
                className={cx(
                  "focus-visible:focus-ring flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold transition-colors",
                  selected
                    ? "bg-surface-active text-fg"
                    : "text-fg-subtle can-hover:hover:bg-surface-hover can-hover:hover:text-fg-muted",
                )}
              >
                <Icon width={13} height={13} />
                {t.label}
              </button>
            );
          })}
        </div>
        {paged && (
          <div className="flex shrink-0 items-center gap-0.5">
            <span className="mr-1 font-mono tabular text-2xs text-fg-subtle">
              {at + 1}/{entries.length}
            </span>
            <ArrowButton label={`Previous ${active.label} entry`} back onClick={() => go(-1)} />
            <ArrowButton label={`Next ${active.label} entry`} onClick={() => go(1)} />
          </div>
        )}
      </div>

      {/* `key` remounts the body on every move, so a screen reader announces the
          new entry instead of silently re-labelling the one it is already on. */}
      <div key={entry.id} role="tabpanel" className="min-w-0 flex-1">
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
    </Card>
  );
}

/** One paging arrow. `back` rotates the shared chevron; there is no left one. */
function ArrowButton({
  label,
  back = false,
  onClick,
}: {
  label: string;
  back?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="focus-visible:focus-ring rounded-md p-1 text-fg-subtle transition-colors can-hover:hover:bg-surface-hover can-hover:hover:text-fg"
    >
      <ChevronRightIcon width={14} height={14} className={back ? "rotate-180" : ""} />
    </button>
  );
}
