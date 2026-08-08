import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * Card / Section / EmptyState — the three container primitives.
 *
 * Radii are concentric: a `Card` is `rounded-2xl`, so anything nested inside it
 * should be `rounded-xl` or tighter (docs/DESIGN.md, "Radius").
 */

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Interactive cards get a hover treatment; static ones must not. The old
   * `.card` class baked a `hover:-translate-y-0.5` lift into all eight of its
   * uses, six of which were not clickable.
   */
  interactive?: boolean;
  /** Drop the default padding (a card whose child manages its own gutters). */
  flush?: boolean;
}

export function Card({ interactive = false, flush = false, className, ...rest }: CardProps) {
  return (
    <div
      className={cx(
        "rounded-2xl border border-edge bg-surface-raised shadow-xs",
        flush ? "" : "p-4",
        interactive &&
          "motion-fast transition-[border-color,box-shadow] hover:border-edge-strong hover:shadow-sm",
        className,
      )}
      {...rest}
    />
  );
}

export interface SectionProps {
  title: ReactNode;
  /** One line under the title. Sits above the body, outside any card. */
  description?: ReactNode;
  /** Pushed to the right of the title row. */
  action?: ReactNode;
  /** Scroll-spy anchor / deep-link target. */
  id?: string;
  /**
   * `card` wraps the body in a `Card` (the settings-style group).
   * `rule` separates from the previous section with a hairline (the config-style
   * long form). `bare` does neither.
   */
  variant?: "card" | "rule" | "bare";
  /** Suppresses the leading rule on the first `rule` section. */
  first?: boolean;
  /**
   * `variant="card"` only: drop the card's padding, for a body that manages its
   * own gutters — a divided list of rows whose separators must reach the card's
   * edges rather than stopping short of them.
   */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A titled group of related content.
 *
 * `SettingsPane` and `InstanceConfigForm` each defined their own incompatible
 * `Section` (h3 uppercase eyebrow + card vs. h2 sentence case + hairline), and
 * five more places inlined a third and fourth variant. This is all of them:
 * `variant` picks the separation, everything else is shared.
 */
export function Section({
  title,
  description,
  action,
  id,
  variant = "card",
  first = false,
  flush = false,
  className,
  children,
}: SectionProps) {
  return (
    <section
      id={id}
      className={cx(
        "scroll-mt-4",
        variant === "rule" && !first && "mt-9 border-t border-edge pt-7",
        variant === "rule" ? "" : "mb-6",
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        {/*
         * Two voices, on purpose, and the split is the direction's "repeat the
         * pattern, then break it" in its smallest form.
         *
         * A `rule` section is a real editorial heading: display face, sentence
         * case, one rung up. A `card`/`bare` section is a CLASSIFICATION of the
         * content below it, so it gets the eyebrow — mono, tracked, small. The
         * previous shared style set every one of them in the heading face,
         * uppercased and letter-spaced — which under a serif display reads as an
         * invitation rather than as a label.
         */}
        <h3
          className={cx(
            variant === "rule"
              ? "text-lg font-semibold text-fg"
              : "eyebrow text-2xs text-fg-subtle",
          )}
        >
          {title}
        </h3>
        {action}
      </div>
      {description && (
        <p className={cx("text-xs leading-snug text-fg-muted", variant === "rule" ? "mt-1.5" : "mt-1")}>
          {description}
        </p>
      )}
      {variant === "card" ? (
        <Card className="mt-2" flush={flush}>
          {children}
        </Card>
      ) : (
        <div className="mt-4">{children}</div>
      )}
    </section>
  );
}

export interface EmptyStateProps {
  /** Positive framing — what CAN happen, not what is absent. */
  title: string;
  /** One line of explanation. Keep it to one. */
  body?: ReactNode;
  /** The next step. An empty state without one is a dead end. */
  action?: ReactNode;
  icon?: ReactNode;
  /**
   * `inline` is the quiet form for a slot inside an already-titled section —
   * one line, no border, no icon. `panel` is the full invitation.
   */
  variant?: "inline" | "panel";
  className?: string;
}

/**
 * An empty state is an invitation to act.
 *
 * The app had 25+ of these written by hand in six different shapes, and a fresh
 * project's Home screen stacked five identical grey-italic boxes — "No files
 * yet.", "No OVERVIEW.md yet.", … — with no next step anywhere on the screen.
 * `action` is why this component exists; pass one whenever there is a plausible
 * next move.
 */
export function EmptyState({
  title,
  body,
  action,
  icon,
  variant = "inline",
  className,
}: EmptyStateProps) {
  if (variant === "inline") {
    return (
      <div className={cx("px-1 py-2", className)}>
        <p className="text-sm text-fg-muted">{title}</p>
        {body && <p className="mt-0.5 text-xs text-fg-subtle">{body}</p>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    );
  }
  /*
   * The panel form is an unwritten page rather than a placeholder box: no
   * dashed outline, no tinted icon tile. The icon is drawn in the muted ink,
   * because this direction spends hue on provenance and status only — an empty
   * state is not a status.
   */
  return (
    <div className={cx("mx-auto max-w-lg px-8 py-14 text-center", className)}>
      {icon && (
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-edge-subtle bg-surface-sunken text-fg-subtle">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold text-fg">{title}</h3>
      {body && <p className="mx-auto mt-2 max-w-sm text-sm text-fg-muted">{body}</p>}
      {action && <div className="mt-5 flex items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
