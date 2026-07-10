import { useEffect, useRef, useState } from "react";
import { clearItemHeight, readItemHeight, writeItemHeight } from "../lib/itemHeight";

/**
 * A long sent-file text/code/markdown embed can dominate a transcript (a
 * 500-line code file renders every line inline). This wraps such an embed in a
 * bounded, internally-scrolling box with a drag handle to resize, a double-click
 * to reset, and a per-item height persisted in localStorage (issue #136, keyed
 * on the stable `turn.id` from #135). Short content is left untouched — no fixed
 * height, no scrollbar, no handle.
 *
 * Height resolution (see `readItemHeight`):
 *  - a persisted height (the user dragged this item before) always wins, clamped
 *    to `[minHeight, natural]`;
 *  - otherwise, if the natural content height exceeds `defaultMaxHeight`, bound
 *    it to `defaultMaxHeight`;
 *  - otherwise render the children unbounded (no handle).
 *
 * jsdom / SSR have no layout, so `scrollHeight` reads 0. We treat an unknown
 * (falsy) natural height as "render unbounded, no handle" so tests and the first
 * server-rendered paint never crash — a persisted height still applies, since an
 * explicit user choice doesn't need a measurement to honour.
 */
export function ResizableBox({
  itemId,
  children,
  defaultMaxHeight = 360,
  minHeight = 80,
}: {
  itemId: string;
  children: React.ReactNode;
  defaultMaxHeight?: number;
  minHeight?: number;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  // Natural (full) content height; 0 = not yet / can't measure (jsdom, SSR).
  const [natural, setNatural] = useState(0);
  // The user's explicit height for this item (drag or persisted); null = none,
  // so the default bounding rules apply.
  const [override, setOverride] = useState<number | null>(() => readItemHeight(itemId));

  // Re-read the persisted height if this box is reused for a different item.
  useEffect(() => {
    setOverride(readItemHeight(itemId));
  }, [itemId]);

  // Measure the natural content height on mount and whenever the content
  // changes. A ResizeObserver keeps it correct as async content (highlighted
  // code, rendered markdown, fonts) settles; guard for jsdom where it's absent.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setNatural(el.scrollHeight || 0);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);

  const measured = natural > 0;
  const maxDrag = measured ? natural : Number.POSITIVE_INFINITY;

  let bounded = false;
  let appliedHeight = 0;
  if (override != null) {
    bounded = true;
    appliedHeight = clamp(override, minHeight, maxDrag);
  } else if (measured && natural > defaultMaxHeight) {
    bounded = true;
    appliedHeight = defaultMaxHeight;
  }

  // Unbounded: short content (or unknown measurement) renders as-is, no handle.
  if (!bounded) {
    return <div ref={contentRef}>{children}</div>;
  }

  return (
    <div className="group relative" style={{ height: appliedHeight }}>
      <div className="h-full overflow-y-auto">
        <div ref={contentRef}>{children}</div>
      </div>
      <ResizeHandle
        appliedHeight={appliedHeight}
        onResize={(px) => setOverride(px)}
        onCommit={(px) => writeItemHeight(itemId, px)}
        onReset={() => {
          clearItemHeight(itemId);
          setOverride(null);
        }}
        minHeight={minHeight}
        maxHeight={maxDrag}
      />
    </div>
  );
}

/**
 * The drag strip along the bottom edge. Pointer capture keeps the drag tracking
 * even when the cursor leaves the strip; double-click resets to the default
 * height; ArrowUp/ArrowDown nudge the height by a step (accessibility).
 */
function ResizeHandle({
  appliedHeight,
  onResize,
  onCommit,
  onReset,
  minHeight,
  maxHeight,
}: {
  appliedHeight: number;
  onResize: (px: number) => void;
  onCommit: (px: number) => void;
  onReset: () => void;
  minHeight: number;
  maxHeight: number;
}) {
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const latest = useRef(appliedHeight);
  latest.current = appliedHeight;

  const STEP = 24;

  return (
    <div
      role="slider"
      aria-label="Resize"
      aria-orientation="vertical"
      aria-valuenow={Math.round(appliedHeight)}
      tabIndex={0}
      onPointerDown={(e) => {
        drag.current = { startY: e.clientY, startHeight: appliedHeight };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const px = nextHeight(drag.current.startHeight, e.clientY - drag.current.startY, minHeight, maxHeight);
        onResize(px);
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
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? STEP : -STEP;
          const px = nextHeight(appliedHeight, delta, minHeight, maxHeight);
          onResize(px);
          onCommit(px);
        }
      }}
      className="absolute inset-x-0 bottom-0 flex h-2 cursor-ns-resize touch-none items-center justify-center border-t border-paddock-100 bg-paddock-50/40 opacity-60 transition hover:bg-paddock-100 hover:opacity-100 dark:border-paddock-800 dark:bg-paddock-900/40 dark:hover:bg-paddock-800"
    >
      <span className="h-0.5 w-8 rounded-full bg-paddock-300 group-hover:bg-paddock-400 dark:bg-paddock-600 dark:group-hover:bg-paddock-500" />
    </div>
  );
}

/**
 * Pure height arithmetic for a drag: the new height is the drag's start height
 * plus the vertical delta, clamped to `[minHeight, maxHeight]`. Extracted so the
 * clamping is unit-testable without a real pointer / layout.
 */
export function nextHeight(
  startHeight: number,
  deltaY: number,
  minHeight: number,
  maxHeight: number,
): number {
  return clamp(startHeight + deltaY, minHeight, maxHeight);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
