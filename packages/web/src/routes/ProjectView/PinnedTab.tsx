import { PinIcon, XIcon } from "../../components/icons";

/** A pinned-file sibling tab with a small unpin "x" (extracted from ProjectView.tsx, #403). */
export function PinnedTab({
  file,
  active,
  onSelect,
  onUnpin,
}: {
  file: string;
  active: boolean;
  onSelect: () => void;
  onUnpin: () => void;
}) {
  // A nested pin (e.g. "design/plan.md") shows its basename as the tab label to
  // stay compact; the full project-relative path lives in the title/aria-label.
  const label = file.includes("/") ? file.slice(file.lastIndexOf("/") + 1) : file;
  return (
    <div
      className={`group/pin -mb-px flex items-center gap-1 border-b-2 pr-1 transition-colors ${
        active
          ? "border-accent"
          : "border-transparent"
      }`}
    >
      <button
        onClick={onSelect}
        title={file}
        aria-label={`Open ${file} tab`}
        role="tab"
        aria-selected={active}
        className={`flex items-center gap-1.5 py-2.5 pl-3 pr-1 text-sm font-medium transition-colors ${
          active
            ? "text-ink dark:text-ink-dark"
            : "text-paddock-500 hover:text-paddock-700 dark:hover:text-paddock-300"
        }`}
      >
        <PinIcon width={12} height={12} className="shrink-0 text-accent" />
        <span className="max-w-[10rem] truncate">{label}</span>
      </button>
      <button
        type="button"
        aria-label={`Unpin ${file}`}
        title={`Unpin ${file}`}
        onClick={(e) => {
          e.stopPropagation();
          onUnpin();
        }}
        className="flex h-5 w-5 items-center justify-center rounded text-paddock-400 opacity-60 transition hover:bg-paddock-200/70 hover:text-paddock-700 focus:opacity-100 group-hover/pin:opacity-100 dark:hover:bg-paddock-800"
      >
        <XIcon width={12} height={12} />
      </button>
    </div>
  );
}
