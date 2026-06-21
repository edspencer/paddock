import { useEffect, useRef, useState } from "react";
import { MoreIcon, PencilIcon, TrashIcon } from "./icons";

/**
 * A "…" overflow menu for project actions (Edit metadata / Delete project).
 * Closes on outside-click or Escape. The trigger is square and unobtrusive so
 * it sits cleanly on a project card or in the project header.
 */
export function ProjectMenu({
  onEdit,
  onDelete,
  align = "right",
  label = "Project actions",
  size = 16,
}: {
  onEdit: () => void;
  onDelete: () => void;
  align?: "left" | "right";
  label?: string;
  size?: number;
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

  // When used inside a <Link>/<NavLink>, stop the click from navigating.
  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={(e) => {
          stop(e);
          setOpen((o) => !o);
        }}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-paddock-400 transition-colors hover:bg-paddock-200/70 hover:text-paddock-700 dark:hover:bg-paddock-800 dark:hover:text-paddock-200"
      >
        <MoreIcon width={size} height={size} />
      </button>
      {open && (
        <div
          className={`menu top-8 ${align === "right" ? "right-0" : "left-0"}`}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={(e) => {
              stop(e);
              setOpen(false);
              onEdit();
            }}
          >
            <PencilIcon width={14} height={14} />
            Edit details
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item-danger"
            onClick={(e) => {
              stop(e);
              setOpen(false);
              onDelete();
            }}
          >
            <TrashIcon width={14} height={14} />
            Delete project
          </button>
        </div>
      )}
    </div>
  );
}
