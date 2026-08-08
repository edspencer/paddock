import { useId } from "react";
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

/**
 * A NUMBER input is a different instrument from a text input, so it is set like
 * one: figures right-aligned and tabular, and no spinner.
 *
 * Right-aligned because the Config screen is a long column of number fields in a
 * fixed control slot — token budgets, timeouts, retry counts, file limits. The
 * slot makes the FIELDS line up; only this makes the VALUES line up, so `5000`,
 * `1` and `0` end on the same pixel and the column can be read down rather than
 * one row at a time. That is the whole point of tabular figures, and it was the
 * one place in the app they were switched on and then wasted.
 *
 * No spinner because the steppers are useless at these magnitudes (nobody nudges
 * an 8000-token budget by one), and left visible they would sit exactly where
 * the right-aligned digits now end and collide with them.
 */
const NUMERIC = [
  "text-right tabular",
  "[appearance:textfield]",
  "[&::-webkit-inner-spin-button]:appearance-none",
  "[&::-webkit-outer-spin-button]:appearance-none",
].join(" ");

export function Input({ className, type, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input className={cx(CONTROL, type === "number" && NUMERIC, className)} type={type} {...rest} />
  );
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
}

/** Native checkbox at one consistent size, with the accent tint. */
export function Checkbox({ label, description, className, ...rest }: CheckboxProps) {
  const box = (
    <input
      type="checkbox"
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
