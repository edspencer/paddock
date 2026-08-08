import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * Button.
 *
 * Replaces the `.btn-*` class soup: before this existed there were 5 CSS
 * classes, 7 hand-rolled size overrides, 6 different icon-button shapes and no
 * loading state at all — every call site spelled its own `{saving ? "Saving…" :
 * "Save"}`.
 *
 * Styled entirely from tokens, so a visual direction restyles every button in
 * the app by editing `styles/tokens.css` and nothing else.
 */

export type ButtonVariant = "primary" | "ghost" | "subtle" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "icon-sm" | "icon-md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent-solid text-accent-fg shadow-xs hover:bg-accent-solid-hover active:scale-[0.98]",
  ghost: "bg-surface-active text-fg hover:bg-surface-selected",
  subtle: "text-fg-muted hover:bg-surface-hover hover:text-fg",
  danger: "bg-danger-solid text-danger-fg shadow-xs hover:brightness-110 active:scale-[0.98]",
  link: "text-accent underline underline-offset-2 hover:no-underline",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "gap-1.5 px-2 py-1 text-xs rounded-md",
  md: "gap-2 px-3.5 py-2 text-sm rounded-lg",
  // Hit targets stay >= 24px (>= 36px for the larger one), per the craft floor.
  "icon-sm": "h-6 w-6 justify-center rounded-md",
  "icon-md": "h-9 w-9 justify-center rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading glyph. Rendered before `children`, never stretched. */
  icon?: ReactNode;
  /**
   * Shows `loadingLabel` and disables the button. Prefer this over swapping the
   * label at the call site — it keeps the disabled/label pair in sync.
   */
  loading?: boolean;
  loadingLabel?: string;
  /** Left-align the content (nav-style rows). Default is centred. */
  align?: "center" | "start";
}

export function Button({
  variant = "ghost",
  size = "md",
  icon,
  loading = false,
  loadingLabel,
  align = "center",
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex select-none items-center font-medium",
        "motion-fast transition-[color,background-color,border-color,box-shadow,transform]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        align === "start" ? "justify-start text-left" : "justify-center",
        SIZES[size],
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}
