import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SentFile } from "../lib/types";
import { SentFileBody, sentFileStableKey } from "./SentFileBlock";

export interface SentFileViewerProps {
  file: SentFile;
  /** Where this file sits among the chat's sent files; null when opened on its own. */
  position: { index: number; total: number } | null;
  canPrev: boolean;
  canNext: boolean;
  /**
   * What lies before the first loaded file (#914's render cap): `withheld` —
   * older messages exist but aren't loaded, and ← will load them; `loading`;
   * `none` — they loaded and held no earlier file; `error`; `idle` otherwise.
   */
  earlier: "idle" | "withheld" | "loading" | "none" | "error";
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

const EARLIER_NOTE: Record<SentFileViewerProps["earlier"], string | null> = {
  idle: null,
  withheld: "Earlier messages aren’t loaded — ← loads them",
  loading: "Loading earlier messages…",
  none: "No earlier files in this chat",
  error: "Couldn’t load earlier messages — ← to retry",
};

/**
 * The chat's full-screen viewer for agent-sent files (#944), portaled to
 * <body>. Every `send_file` kind opens here at the size of the viewport; ←/→
 * (or the side buttons) step through the chat's other sent files while the
 * transcript follows behind. Esc, the close button or a backdrop click close it.
 *
 * Arrow keys are left alone while focus is somewhere they already mean
 * something — a video's seek bar, a form field — and an HTML file's iframe
 * swallows its own keys, so clicking into one is how you scroll it.
 */
export function SentFileViewer({
  file,
  position,
  canPrev,
  canNext,
  earlier,
  onPrev,
  onNext,
  onClose,
}: SentFileViewerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Latest handlers for the one document listener, so it isn't re-bound (and
  // the page re-locked) on every step.
  const keys = useRef({ onPrev, onNext, onClose, canPrev, canNext });
  keys.current = { onPrev, onNext, onClose, canPrev, canNext };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (e.key === "Escape") return k.onClose();
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || ownsArrowKeys(e.target)) return;
      e.preventDefault();
      if (e.key === "ArrowLeft" && k.canPrev) k.onPrev();
      if (e.key === "ArrowRight" && k.canNext) k.onNext();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.({ preventScroll: true });
    };
  }, []);

  const note = EARLIER_NOTE[earlier];
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={file.filename}
      onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col gap-3 bg-overlay-strong p-3 backdrop-blur-sm sm:p-5"
    >
      <div className="flex items-center gap-3 text-sm text-white/90">
        <span className="min-w-0 truncate font-mono text-white/80" onClick={stop}>
          {file.filename}
        </span>
        {position ? (
          <span className="shrink-0 tabular-nums text-xs text-white/60" aria-live="polite">
            {position.index + 1} / {position.total}
          </span>
        ) : null}
        {note ? (
          <span className="min-w-0 truncate text-xs text-white/60" role="status">
            {note}
          </span>
        ) : null}
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
          className={`${ROUND_BTN} ml-auto h-9 w-9 shrink-0`}
        >
          <Glyph>
            <path d="M18 6 6 18M6 6l12 12" />
          </Glyph>
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center gap-2 sm:gap-3">
        {position ? <NavButton side="left" disabled={!canPrev} onClick={onPrev} /> : null}
        <div className="flex h-full min-w-0 flex-1 items-center justify-center">
          {/* Keyed on the file, so a video or iframe starts fresh on each step. */}
          <Stage key={sentFileStableKey(file)} file={file} />
        </div>
        {position ? <NavButton side="right" disabled={!canNext} onClick={onNext} /> : null}
      </div>

      {file.message ? (
        <div onClick={stop} className="mx-auto max-w-3xl text-center text-sm text-white/90">
          {file.message}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/** The file itself, sized to the space between the header and the caption. */
function Stage({ file }: { file: SentFile }) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (file.kind === "image" && file.rawUrl) {
    return (
      <img
        src={file.rawUrl}
        alt={file.filename}
        onClick={stop}
        className="max-h-full max-w-full object-contain"
      />
    );
  }
  if (file.kind === "video" && file.rawUrl) {
    return (
      <video
        src={file.rawUrl}
        controls
        playsInline
        preload="metadata"
        onClick={stop}
        // Fill the stage (letterboxed) — a clip is small at its natural size.
        className="h-full w-full object-contain"
      />
    );
  }
  // Everything else reads on a page, rendered by the same body the chat uses,
  // unbounded. A PDF or HTML page has no intrinsic height, so it takes all of
  // the stage; text kinds size to their content and scroll past the stage.
  const wide = file.kind === "pdf" || file.kind === "html";
  return (
    <div
      onClick={stop}
      className={`w-full overflow-auto rounded-lg bg-surface-raised shadow-lg ring-1 ring-edge ${
        wide ? "h-full max-w-6xl" : "max-h-full max-w-4xl"
      }`}
    >
      <SentFileBody file={file} fill />
    </div>
  );
}

const ROUND_BTN =
  "flex items-center justify-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

function NavButton({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  const label = side === "left" ? "Previous file" : "Next file";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      aria-label={label}
      title={`${label} (${side === "left" ? "←" : "→"})`}
      className={`${ROUND_BTN} h-10 w-10 shrink-0 disabled:pointer-events-none disabled:opacity-30`}
    >
      <Glyph>
        <path d={side === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
      </Glyph>
    </button>
  );
}

/** Focus targets whose own arrow-key behaviour must win over stepping files. */
function ownsArrowKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT", "VIDEO", "AUDIO"].includes(target.tagName);
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}
