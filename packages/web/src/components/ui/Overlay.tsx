import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useEscapeKey } from "../../lib/useEscapeKey";
import { cx } from "./cx";

/**
 * Dialog + Menu — the two overlay primitives.
 *
 * Before this there were eight hand-rolled overlays: the backdrop class string
 * was copy-pasted six times, the panel string four times, three of them
 * re-implemented Escape rather than using `useEscapeKey`, two carried no
 * `role="dialog"` at all, and NONE trapped or restored focus. `Dialog` does all
 * of that once.
 */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** The accessible name. Rendered as the heading unless `hideTitle`. */
  title: string;
  hideTitle?: boolean;
  description?: ReactNode;
  /** Footer content, typically the action buttons. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** `alertdialog` for a destructive confirmation. */
  role?: "dialog" | "alertdialog";
  /** Backdrop clicks close by default; pass false while a request is in flight. */
  dismissOnBackdrop?: boolean;
  /** Renders the panel as a `<form>` and wires `onSubmit`. */
  onSubmit?: (e: React.FormEvent) => void;
  className?: string;
  children?: ReactNode;
}

const SIZES = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl" } as const;

export function Dialog({
  open,
  onClose,
  title,
  hideTitle = false,
  description,
  footer,
  size = "md",
  role = "dialog",
  dismissOnBackdrop = true,
  onSubmit,
  className,
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<Element | null>(null);

  useEscapeKey(open, onClose);

  // Focus management: remember what had focus, move focus into the panel on
  // open, and put it back on close. Without this a keyboard user is dropped at
  // the top of the document every time a dialog closes.
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement;
    const first = panelRef.current?.querySelector<HTMLElement>(
      "[autofocus], input:not([type=hidden]), textarea, select, button, [href], [tabindex]:not([tabindex='-1'])",
    );
    (first ?? panelRef.current)?.focus();
    return () => {
      const back = restoreTo.current;
      if (back instanceof HTMLElement) back.focus();
    };
  }, [open]);

  // Keep Tab inside the panel while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          "input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
        ),
      ];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const Panel = onSubmit ? "form" : "div";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm"
      onClick={() => dismissOnBackdrop && onClose()}
    >
      <Panel
        // The ref type differs between form and div; the DOM node is the same.
        ref={panelRef as never}
        role={role}
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        onSubmit={onSubmit}
        className={cx(
          "flex max-h-[85vh] w-full flex-col animate-scale-in rounded-2xl border border-edge",
          "bg-surface-raised p-6 shadow-2xl outline-none",
          SIZES[size],
          className,
        )}
      >
        {!hideTitle && <h2 className="text-base font-semibold text-fg">{title}</h2>}
        {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 py-1">{children}</div>
        {footer && <div className="mt-4 flex items-center justify-end gap-2">{footer}</div>}
      </Panel>
    </div>
  );
}

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the menu itself. */
  label: string;
  align?: "left" | "right";
  /** Vertical offset from the trigger, e.g. `top-8`. */
  position?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A dropdown menu. Handles outside-click, Escape and roving arrow-key
 * navigation, which the two ad-hoc menus claimed via `role="menu"` but never
 * implemented.
 *
 * Render it inside a `relative` wrapper together with its trigger.
 */
export function Menu({
  open,
  onClose,
  label,
  align = "right",
  position = "top-8",
  className,
  children,
}: MenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEscapeKey(open, onClose);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // `mousedown` on the document, not `click`, so the menu closes before a
    // click lands on whatever is underneath it.
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    items[(next + items.length) % items.length].focus();
  };

  if (!open) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cx(
        "absolute z-50 min-w-40 animate-scale-in overflow-hidden rounded-xl border border-edge",
        "bg-surface-raised py-1 shadow-xl",
        position,
        align === "right" ? "right-0" : "left-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  danger = false,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cx(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm motion-fast transition-colors",
        danger ? "text-danger hover:bg-danger-soft" : "text-fg-muted hover:bg-surface-hover hover:text-fg",
        className,
      )}
      {...rest}
    />
  );
}
