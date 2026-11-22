import { useEffect, useRef, useState } from "react";
import type { SortMode } from "../lib/types";
import { Tooltip } from "./Tooltip";
import { CheckIcon, SortIcon } from "./icons";

/** The three sort modes, in menu order, with their visible labels. */
export const SORT_MODES: ReadonlyArray<{ mode: SortMode; label: string }> = [
  { mode: "recent", label: "Most recent reply" },
  { mode: "created", label: "Created" },
  { mode: "manual", label: "Manual" },
];

const labelOf = (mode: SortMode) => SORT_MODES.find((m) => m.mode === mode)?.label ?? mode;

/**
 * A list's sort-mode picker: one icon button that opens a three-item menu.
 *
 * A menu rather than a cycling button like the nested/flat toggle beside it.
 * That toggle can show the state you will GET because it has two; with three,
 * a cycling button can show neither "where you are" nor "where one click
 * takes you" without reading the label. The menu shows all three with the
 * current one checked.
 *
 * Shared by the chat list's toolbar and the left nav's Projects header; the two
 * differ only in trigger size, hence `triggerClassName`.
 */
export function SortModeMenu({
  mode,
  onChange,
  noun,
  triggerClassName,
  iconSize = 16,
}: {
  mode: SortMode;
  onChange: (mode: SortMode) => void;
  /** What the list holds, for the accessible name: "chats", "projects". */
  noun: string;
  triggerClassName: string;
  iconSize?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <Tooltip content={`Sort ${noun}: ${labelOf(mode)}`}>
        <button
          type="button"
          aria-label={`Sort ${noun} (${labelOf(mode)})`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={triggerClassName}
        >
          <SortIcon width={iconSize} height={iconSize} className="mx-auto" />
        </button>
      </Tooltip>
      {open && (
        <div className="menu right-0 top-full mt-1" role="menu" aria-label={`Sort ${noun}`}>
          {SORT_MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              role="menuitemradio"
              aria-checked={m.mode === mode}
              className="menu-item"
              onClick={() => {
                setOpen(false);
                if (m.mode !== mode) onChange(m.mode);
              }}
            >
              <span className="flex w-3.5 shrink-0 justify-center">
                {m.mode === mode && <CheckIcon width={14} height={14} />}
              </span>
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
