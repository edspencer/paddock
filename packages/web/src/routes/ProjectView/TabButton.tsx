/**
 * A tab in the ProjectView main-area tab bar (extracted from ProjectView.tsx, #403).
 *
 * The active underline (`border-b-2`) is meant to sit ON the tab bar's 1px rule,
 * not above it. That overlap used to be a `-mb-px` here — but the strip is a
 * scroll container (`overflow-x: auto` forces `overflow-y` to `auto` too), and a
 * scroll container's scrollable area is the union of its descendants' BORDER
 * boxes, which a negative margin does not pull in. So every tab contributed 1px
 * of phantom vertical overflow and the strip grew a scrollbar it had no use for.
 * The -1px now hangs off the scroller itself, whose parent is not a scroll
 * container — same pixels, no overflow. See the tab bar in ProjectView.tsx.
 */
export function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
        active
          ? "border-accent text-fg"
          : "border-transparent text-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
