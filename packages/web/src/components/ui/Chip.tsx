import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Chip / Badge — the small inline label.
 *
 * The app grew twenty distinct shapes of this (`StatusPill`, `HistoryPane`'s
 * origin chips, `toolFormatting`'s status chips, `TriggersPane`'s `TypeBadge`
 * and `StatusChip`, `ChangesPane`'s git-status letters, the header feature
 * badges, …) in four radii, four sizes and three weights, each spelling out its
 * own light/dark colour pair. One component, one `tone`, one `shape`.
 *
 * The tone names are DOMAIN meanings, not hues — see the table in
 * `styles/tokens.css`. Pick by what the chip means and the direction decides
 * what colour that is.
 */

export type ChipTone =
  | "neutral"
  | "accent"
  | "success"
  | "warn"
  | "danger"
  | "info"
  /** derivation & structure: renamed, spawned, hunk header, schedule-type */
  | "lineage";

const TONES: Record<ChipTone, string> = {
  neutral: "bg-surface-active text-fg-muted",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  lineage: "bg-lineage-soft text-lineage",
};

const DOTS: Record<ChipTone, string> = {
  neutral: "bg-fg-subtle",
  accent: "bg-accent-solid",
  success: "bg-success-solid",
  warn: "bg-warn-solid",
  danger: "bg-danger-solid",
  info: "bg-info-solid",
  lineage: "bg-lineage-solid",
};

export interface ChipProps {
  tone?: ChipTone;
  /** `pill` is fully round (statuses); `tag` is a soft rectangle (metadata). */
  shape?: "pill" | "tag";
  size?: "sm" | "md";
  /** Leading status dot. */
  dot?: boolean;
  icon?: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
}

export function Chip({
  tone = "neutral",
  shape = "tag",
  size = "md",
  dot = false,
  icon,
  title,
  className,
  children,
}: ChipProps) {
  return (
    <span
      title={title}
      className={cx(
        // `tabular` because a chip is very often a count, and a count that
        // jitters as it ticks is the thing tabular figures exist to stop.
        "inline-flex items-center gap-1 font-medium leading-none tabular",
        // The `tag` shape is cut square-ish — a stamped label rather than a
        // rounded blob — while `pill` stays fully round for live status. The
        // difference in radius is doing the same job as the difference in
        // meaning, which is the only reason to have two shapes.
        shape === "pill" ? "rounded-full px-2 py-0.5" : "rounded-sm px-1.5 py-0.5",
        size === "sm" ? "text-3xs" : "text-2xs",
        TONES[tone],
        className,
      )}
    >
      {dot && <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", DOTS[tone])} />}
      {icon}
      {children}
    </span>
  );
}

/** The bare status dot, for rows too dense for a whole chip. */
export function StatusDot({
  tone = "neutral",
  pulse = false,
  className,
}: {
  tone?: ChipTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cx("inline-block h-2 w-2 shrink-0 rounded-full", DOTS[tone], pulse && "animate-pulse", className)}
    />
  );
}

/**
 * A tinted notice block: the error/warning banner that appeared verbatim in
 * eight files and near-verbatim in five more.
 */
export function Callout({
  tone = "info",
  icon,
  className,
  children,
}: {
  tone?: ChipTone;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const EDGES: Record<ChipTone, string> = {
    neutral: "border-edge",
    accent: "border-accent-edge",
    success: "border-success-edge",
    warn: "border-warn-edge",
    danger: "border-danger-edge",
    info: "border-info-edge",
    lineage: "border-lineage-edge",
  };
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={cx(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        TONES[tone],
        EDGES[tone],
        className,
      )}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
