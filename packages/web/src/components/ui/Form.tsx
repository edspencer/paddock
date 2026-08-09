import { useEffect, useId, useRef } from "react";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cx } from "./cx";

/**
 * Form primitives: Input / Textarea / Select / Label / Field / Toggle.
 *
 * The control styling is one shared string so the three element types cannot
 * drift apart (they had: the commit box in `ChangesPane` was a hand-copy of
 * `.input` that had silently lost 2px of horizontal padding).
 *
 * The focus treatment is a `box-shadow` ring, never `outline` — `outline`
 * ignores `border-radius` and paints a rectangle around a rounded control.
 */
const CONTROL = [
  "w-full rounded-lg border border-edge-strong bg-surface-sunken px-3 py-2 text-sm text-fg",
  "outline-none motion-fast transition-[border-color,box-shadow]",
  "focus:border-accent focus:ring-2 focus:ring-accent/25",
  "disabled:cursor-not-allowed disabled:opacity-60",
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/25",
].join(" ");

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(CONTROL, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(CONTROL, "resize-y", className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(CONTROL, className)} {...rest} />;
}

export function Label({
  className,
  ...rest
}: React.LabelHTMLAttributes<HTMLLabelElement> & { children: ReactNode }) {
  return (
    <label
      className={cx("mb-1 block text-xs font-semibold uppercase tracking-wide text-fg-muted", className)}
      {...rest}
    />
  );
}

/** One line of help under a control. */
export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("mt-1 text-xs leading-snug text-fg-muted", className)}>{children}</p>;
}

export interface FieldProps {
  label: ReactNode;
  /** Help text. Rendered under the control and linked via `aria-describedby`. */
  hint?: ReactNode;
  /**
   * When set, replaces `hint`, colours the message and marks the control
   * invalid. The pre-primitive app set `aria-invalid` but never
   * `aria-describedby`, so no error message was programmatically associated
   * with its control anywhere.
   */
  error?: ReactNode;
  /** Pushed to the right of the label (a chip, a toggle, a "restore" link). */
  aside?: ReactNode;
  className?: string;
  /** Receives the ids to wire onto the control. */
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
}

/**
 * Label + control + help/error, correctly associated.
 *
 * Uses `htmlFor`/`id` rather than wrapping the control in the `<label>`, so the
 * label's accessible name stays exactly the field name and the help text
 * reaches the control through `aria-describedby`.
 */
export function Field({ label, hint, error, aside, className, children }: FieldProps) {
  const id = useId();
  const describedBy = error || hint ? `${id}-desc` : undefined;
  return (
    <div className={cx("mb-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {label}
        </label>
        {aside}
      </div>
      {children({
        id,
        "aria-describedby": describedBy,
        ...(error ? ({ "aria-invalid": true } as const) : {}),
      })}
      {(error || hint) && (
        <p
          id={describedBy}
          className={cx("mt-1 text-xs leading-snug", error ? "text-danger" : "text-fg-muted")}
        >
          {error || hint}
        </p>
      )}
    </div>
  );
}

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. Required — a switch with no name is unusable. */
  label: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * A checkbox styled as a switch — still a real checkbox, so it keeps native
 * keyboard behaviour, form semantics and testability.
 */
export function Toggle({ checked, onChange, label, disabled, id, className }: ToggleProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <label htmlFor={inputId} className={cx("relative inline-block shrink-0 cursor-pointer", className)}>
      <input
        id={inputId}
        type="checkbox"
        aria-label={label}
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        className={cx(
          "block h-[18px] w-8 rounded-full bg-edge-strong",
          "motion-fast transition-colors",
          "after:absolute after:left-0.5 after:top-0.5 after:h-3.5 after:w-3.5 after:rounded-full",
          "after:bg-surface-raised after:shadow-2xs after:transition-transform after:content-['']",
          "peer-checked:bg-accent-solid peer-checked:after:translate-x-3.5",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-accent/50",
          "peer-disabled:opacity-50",
        )}
      />
    </label>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  /** Renders the label beside the box. Omit for a bare checkbox in a grid. */
  label?: ReactNode;
  /** A second, quieter line under the label. */
  description?: ReactNode;
  /**
   * The third state: some of this box's children are ticked (#745).
   *
   * There is no `indeterminate` attribute — it is a DOM PROPERTY only, so it can
   * only be set imperatively, which is why a parent checkbox that renders a dash
   * cannot be done with JSX alone. Doing it here means every caller gets the
   * `aria-checked="mixed"` that goes with it, rather than each growing its own
   * ref effect and half of them forgetting the ARIA half.
   */
  indeterminate?: boolean;
}

/** Native checkbox at one consistent size, with the accent tint. */
export function Checkbox({
  label,
  description,
  indeterminate = false,
  className,
  ...rest
}: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const box = (
    <input
      ref={ref}
      type="checkbox"
      // `aria-checked` on a native checkbox is normally redundant and best left
      // alone — but "mixed" is the one value the implicit mapping cannot produce,
      // so it is set only when it is actually mixed.
      {...(indeterminate ? { "aria-checked": "mixed" as const } : {})}
      className={cx(
        "h-4 w-4 shrink-0 cursor-pointer rounded border-edge-strong accent-[var(--accent-solid)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        label ? "mt-0.5" : "",
        className,
      )}
      {...rest}
    />
  );
  if (!label) return box;
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm text-fg">
      {box}
      <span className="min-w-0">
        {label}
        {description && <span className="block text-xs leading-snug text-fg-muted">{description}</span>}
      </span>
    </label>
  );
}
