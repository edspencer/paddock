import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertIcon } from "./icons";

/**
 * The shared inline image embed used by BOTH an agent-sent image
 * (`mcp__paddock__send_file`, issue #112) and an image `Read` tool result
 * (issue #239). A checkerboard mat behind the image, a hover-reveal action bar
 * (download / open-in-new-tab / maximize), and a full-screen lightbox. The image
 * itself is click-to-maximize with a zoom cursor, so you don't have to hunt for
 * the maximize icon. Falls back to a small "couldn't display" row on a load error.
 */
export function InlineImage({
  src,
  filename,
  message,
}: {
  src?: string;
  filename: string;
  /** An optional caption (the agent's `send_file` message) shown in the lightbox. */
  message?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const checker =
    "repeating-conic-gradient(rgb(0 0 0 / 0.06) 0% 25%, transparent 0% 50%) 50% / 20px 20px";
  if (!src || failed) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
        <AlertIcon width={16} height={16} className="shrink-0" />
        <span>Could not display this image.</span>
      </div>
    );
  }
  // `group` + `relative` so the hover action bar can reveal + position itself.
  return (
    <div
      className="group relative flex items-center justify-center overflow-auto p-4"
      style={{ background: checker }}
    >
      <img
        src={src}
        alt={filename}
        onError={() => setFailed(true)}
        // Click the image itself to maximize — a shortcut to the lightbox, with a
        // zoom cursor so it's obviously interactive.
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={`Open ${filename} full screen`}
        className="max-h-[480px] max-w-full cursor-zoom-in object-contain shadow-sm"
      />
      <MediaActions src={src} filename={filename} onMaximize={() => setOpen(true)} />
      {open ? (
        <ImageLightbox
          src={src}
          filename={filename}
          message={message}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * A bottom-right cluster of icon actions over a media embed: download, open in
 * a new tab, and (images only) maximize into a lightbox. On a hover-capable
 * device it fades in on hover/focus of the parent `group`; on touch (no hover)
 * it stays visible — the `can-hover` variant (tailwind.config.js) gates the
 * hide-until-hover behavior. Kept keyboard-focusable so `group-focus-within`
 * reveals it. All actions key off `src` (the file's `rawUrl`). Also used by the
 * PDF embed (without `onMaximize`).
 */
export function MediaActions({
  src,
  filename,
  onMaximize,
}: {
  src: string;
  filename: string;
  /** Provided only where a fuller view exists (image); omitted for PDF. */
  onMaximize?: () => void;
}) {
  const btn =
    "pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white shadow-sm transition-colors hover:bg-black/75 focus-visible:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";
  return (
    <div className="pointer-events-none absolute bottom-2 right-2 z-10 flex items-center gap-1.5 opacity-100 transition-opacity can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:group-focus-within:opacity-100">
      <a
        href={src}
        download={filename}
        className={btn}
        aria-label={`Download ${filename}`}
        title="Download"
      >
        <DownloadGlyph />
      </a>
      <a
        href={src}
        target="_blank"
        rel="noreferrer noopener"
        className={btn}
        aria-label={`Open ${filename} in new tab`}
        title="Open in new tab"
      >
        <ExternalLinkGlyph />
      </a>
      {onMaximize ? (
        <button
          type="button"
          onClick={onMaximize}
          className={btn}
          aria-label="Maximize"
          title="Maximize"
        >
          <MaximizeGlyph />
        </button>
      ) : null}
    </div>
  );
}

/**
 * A full-viewport image lightbox, portaled to <body>. Esc and a backdrop click
 * close it (clicks on the image/caption don't); the page is scroll-locked while
 * open and the close button takes focus on mount. The filename — and the
 * caption, if any — sit beneath the image, legible on the dim backdrop.
 */
function ImageLightbox({
  src,
  filename,
  message,
  onClose,
}: {
  src: string;
  filename: string;
  message?: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Scroll-lock the page while open, restoring the prior value on unmount.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={filename}
      onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/80 p-6"
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close"
        title="Close"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <CloseGlyph />
      </button>
      {/* stopPropagation so clicks on the image/caption don't dismiss. */}
      <img
        src={src}
        alt={filename}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[95vw] object-contain"
      />
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-w-[95vw] text-center text-sm text-white/90"
      >
        <div className="font-mono text-white/70">{filename}</div>
        {message ? <div className="mt-1">{message}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/** Shared frame for the media-action glyphs — currentColor stroke, ~14px. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width={14}
      height={14}
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

function DownloadGlyph() {
  return (
    <Glyph>
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </Glyph>
  );
}

function ExternalLinkGlyph() {
  return (
    <Glyph>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Glyph>
  );
}

function MaximizeGlyph() {
  return (
    <Glyph>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
    </Glyph>
  );
}

function CloseGlyph() {
  return (
    <Glyph>
      <path d="M18 6 6 18M6 6l12 12" />
    </Glyph>
  );
}
