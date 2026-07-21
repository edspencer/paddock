import { useRef, useState } from "react";
import { useMediaQuery } from "../lib/useMediaQuery";
import {
  clampWidth,
  clearPaneWidth,
  DESKTOP_QUERY,
  nextWidth,
  readPaneWidth,
  writePaneWidth,
  type PaneSpec,
} from "../lib/paneWidth";

/**
 * Drag-to-resize for a desktop pane (#374). Reuses the pointer-capture pattern
 * from ResizableBox's vertical `ResizeHandle`, but horizontal: the strip sits on
 * the pane's right edge, drag adjusts the width, double-click resets to the
 * default, and Arrow{Left,Right} nudge for keyboard accessibility. The parent
 * owns the width via {@link usePaneWidth}; this component is purely the handle.
 */

/**
 * Own a pane's resizable width: reads the persisted value on mount, exposes a
 * live `preview` (during drag) + `commit` (persist on release) + `reset`, and an
 * inline `style` applied ONLY on desktop — below `lg` the pane keeps its CSS
 * drawer width, so an inline pixel width never breaks the mobile layout.
 */
export function usePaneWidth(spec: PaneSpec) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // The user's explicit width (persisted or mid-drag); null → use the default.
  const [override, setOverride] = useState<number | null>(() => readPaneWidth(spec));
  const width = clampWidth(spec, override ?? spec.def);
  return {
    isDesktop,
    width,
    /** Inline style for the pane — only on desktop, else undefined (CSS wins). */
    style: isDesktop ? ({ width } as const) : undefined,
    /** Live width during a drag (state only, not persisted). */
    preview: (px: number) => setOverride(clampWidth(spec, px)),
    /** Commit + persist a width (on pointer-up / keyboard nudge). */
    commit: (px: number) => {
      const c = clampWidth(spec, px);
      setOverride(c);
      writePaneWidth(spec, c);
    },
    /** Reset to the default (double-click), forgetting the persisted width. */
    reset: () => {
      setOverride(null);
      clearPaneWidth(spec);
    },
    spec,
  };
}

export function PaneResizer({
  spec,
  width,
  onPreview,
  onCommit,
  onReset,
  label,
}: {
  spec: PaneSpec;
  width: number;
  onPreview: (px: number) => void;
  onCommit: (px: number) => void;
  onReset: () => void;
  label: string;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const latest = useRef(width);
  latest.current = width;
  const STEP = 16;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      tabIndex={0}
      onPointerDown={(e) => {
        drag.current = { startX: e.clientX, startWidth: width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onPreview(nextWidth(drag.current.startWidth, e.clientX - drag.current.startX, spec));
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = null;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* pointer already released */
        }
        onCommit(latest.current);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const px = nextWidth(width, e.key === "ArrowRight" ? STEP : -STEP, spec);
          onPreview(px);
          onCommit(px);
        }
      }}
      title="Drag to resize · double-click to reset"
      // Desktop-only (belt-and-suspenders with the conditional render); a thin
      // hit strip straddling the pane's right edge, subtle until hover/focus.
      className="group/resizer absolute inset-y-0 right-0 z-10 hidden w-1.5 -mr-0.5 cursor-ew-resize touch-none lg:block"
    >
      <span className="absolute inset-y-0 right-0 w-px bg-paddock-200 transition group-hover/resizer:w-0.5 group-hover/resizer:bg-accent group-focus/resizer:w-0.5 group-focus/resizer:bg-accent dark:bg-paddock-800" />
    </div>
  );
}
