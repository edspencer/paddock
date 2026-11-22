import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * How far (px) the pointer must travel before a press on a row becomes a drag.
 * Below it the press is still a click, so the row opens as it always did.
 */
export const DRAG_THRESHOLD_PX = 5;

/** Where a dragged row would land. */
export interface DropTarget {
  /** The group it lands in. */
  group: string;
  /** Insert before this row; `null` with `atStart` unset means the group's end. */
  beforeId: string | null;
  /** Dropped on the group's heading: insert at the very top of the group. */
  atStart?: boolean;
}

/** Where to draw the drop marker: an edge of a row, or a whole heading. */
export type DropMarker = { id: string; side: "before" | "after" } | { heading: string };

export interface DragState {
  id: string;
  group: string;
  target: DropTarget | null;
  marker: DropMarker | null;
}

interface Pending {
  id: string;
  group: string;
  x: number;
  y: number;
  pointerId: number;
  el: HTMLElement;
  active: boolean;
}

const ROW = "[data-reorder-id]";
const HEADING = "[data-reorder-heading]";

/**
 * Pointer-driven drag-to-reorder for a list of rows, hand-rolled on Pointer
 * Events with pointer capture (the PaneResizer pattern) rather than HTML5
 * drag-and-drop, which neither styles nor tests well.
 *
 * Rows opt in by spreading `rowProps(id, group)`, which tags them with
 * `data-reorder-id` / `data-reorder-group`; the drop position is read back off
 * those rows' rects inside `containerRef`. With `crossGroup`, a row may land in
 * another group, and elements tagged `data-reorder-heading={group}` accept a
 * drop at the top of that group.
 *
 * The press becomes a drag only after {@link DRAG_THRESHOLD_PX} of travel, so a
 * click still opens the row; the click that ends a real drag is swallowed.
 * Mouse and pen only: a touch press is ignored outright, so scrolling and
 * tapping on a phone are unaffected. Escape cancels a drag in flight.
 */
export function useDragReorder({
  enabled,
  containerRef,
  crossGroup = false,
  onDrop,
}: {
  enabled: boolean;
  containerRef: RefObject<HTMLElement>;
  crossGroup?: boolean;
  /** Called on release over a valid target. */
  onDrop: (id: string, fromGroup: string, target: DropTarget) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const pending = useRef<Pending | null>(null);
  const swallowClick = useRef(false);
  const latest = useRef({ onDrop, crossGroup });
  latest.current = { onDrop, crossGroup };

  /** The target (and marker) under `y` for the row being dragged. */
  const locate = useCallback(
    (id: string, group: string, y: number): Pick<DragState, "target" | "marker"> => {
      const root = containerRef.current;
      if (!root) return { target: null, marker: null };
      const cross = latest.current.crossGroup;
      if (cross) {
        for (const h of root.querySelectorAll<HTMLElement>(HEADING)) {
          const r = h.getBoundingClientRect();
          if (y >= r.top && y <= r.bottom) {
            const heading = h.dataset.reorderHeading ?? "";
            return {
              target: { group: heading, beforeId: null, atStart: true },
              marker: { heading },
            };
          }
        }
      }
      const rows = [...root.querySelectorAll<HTMLElement>(ROW)].filter(
        (r) => r.dataset.reorderId !== id && (cross || r.dataset.reorderGroup === group),
      );
      for (const r of rows) {
        const rect = r.getBoundingClientRect();
        if (y < rect.top + rect.height / 2) {
          const before = r.dataset.reorderId!;
          return {
            target: { group: r.dataset.reorderGroup ?? "", beforeId: before },
            marker: { id: before, side: "before" },
          };
        }
      }
      const last = rows[rows.length - 1];
      if (!last) return { target: null, marker: null };
      return {
        target: { group: last.dataset.reorderGroup ?? "", beforeId: null },
        marker: { id: last.dataset.reorderId!, side: "after" },
      };
    },
    [containerRef],
  );

  const end = useCallback((drop: boolean, y?: number) => {
    const p = pending.current;
    pending.current = null;
    if (!p?.active) return;
    try {
      p.el.releasePointerCapture?.(p.pointerId);
    } catch {
      /* pointer already released */
    }
    document.body.style.userSelect = "";
    swallowClick.current = true;
    // A drag that ends without a click (released outside the row) must not
    // swallow the NEXT, unrelated click.
    setTimeout(() => {
      swallowClick.current = false;
    }, 0);
    setDrag(null);
    if (drop && y !== undefined) {
      const { target } = locate(p.id, p.group, y);
      if (target) latest.current.onDrop(p.id, p.group, target);
    }
  }, [locate]);

  // Escape cancels; so does the list losing its ability to reorder mid-drag
  // (a search starting, say).
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") end(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag, end]);
  useEffect(() => {
    if (!enabled) end(false);
  }, [enabled, end]);

  const rowProps = (id: string, group: string) => ({
    "data-reorder-id": id,
    "data-reorder-group": group,
    // Links and images are natively draggable; that drag would steal the pointer.
    draggable: false,
    onDragStart: (e: React.DragEvent) => e.preventDefault(),
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (!enabled || e.pointerType === "touch" || e.button !== 0) return;
      pending.current = {
        id,
        group,
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
        el: e.currentTarget,
        active: false,
      };
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const p = pending.current;
      if (!p || p.id !== id) return;
      if (!p.active) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD_PX) return;
        p.active = true;
        try {
          p.el.setPointerCapture?.(p.pointerId);
        } catch {
          /* capture is an optimisation; moves still arrive while over the row */
        }
        document.body.style.userSelect = "none";
      }
      const next = { id, group, ...locate(id, group, e.clientY) };
      // A move within the same slot changes nothing; skip the re-render.
      setDrag((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      if (pending.current?.id !== id) return;
      end(true, e.clientY);
    },
    onPointerCancel: () => end(false),
    onClickCapture: (e: React.MouseEvent) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  });

  /** The marker to draw on one row, if any. */
  const markerFor = (id: string): "before" | "after" | null => {
    const m = drag?.marker;
    return m && "id" in m && m.id === id ? m.side : null;
  };

  /** Whether a heading is the current drop target. */
  const headingTargeted = (group: string) => {
    const m = drag?.marker;
    return !!m && "heading" in m && m.heading === group;
  };

  return { drag, rowProps, markerFor, headingTargeted };
}

/**
 * Apply a drop to one group's current order: take `id` out (wherever it was)
 * and put it before `beforeId`, at the top (`atStart`), or at the end.
 */
export function placeInOrder(
  order: readonly string[],
  id: string,
  target: Pick<DropTarget, "beforeId" | "atStart">,
): string[] {
  const rest = order.filter((x) => x !== id);
  if (target.atStart) return [id, ...rest];
  const at = target.beforeId === null ? -1 : rest.indexOf(target.beforeId);
  if (at < 0) return [...rest, id];
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
