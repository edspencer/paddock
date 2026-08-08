import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * A small shared hover/focus tooltip (#508).
 *
 * Everything that needed a hint used the browser's native `title=` attribute,
 * which can't be themed, can't hold markup, has an uncontrollable ~1s delay, and
 * (the reason this exists) can't carry the chat list's "Shift-click to archive
 * all 20" affordance in a way anyone would find. This is the replacement.
 *
 * Three implementation choices worth knowing:
 *
 *  - **Portalled + `position: fixed`.** The chat list lives in an
 *    `overflow-y-auto` column, so an absolutely-positioned bubble would be
 *    clipped by its scroll container. It renders into `document.body` and is
 *    positioned from the trigger's viewport rect instead; any scroll or resize
 *    dismisses it rather than letting it drift away from its trigger.
 *  - **The child is cloned to carry `aria-describedby`.** The bubble is not an
 *    accessible name — the trigger keeps its own `aria-label` — it's a
 *    DESCRIPTION, and pointing at it from the real interactive element is what
 *    makes a screen reader announce it. The wrapper only carries the events.
 *  - **The wrapper is `inline-flex`, not `display: contents`.** It has to be
 *    measurable to position from, and every current call site is an icon button
 *    in a flex row, where an inline-flex wrapper is layout-neutral.
 *
 * Hover waits out `delayMs` (so sweeping the cursor across a row of actions
 * doesn't flash six bubbles); keyboard focus shows immediately, because a focused
 * control is a deliberate stop.
 */
export function Tooltip({
  content,
  children,
  delayMs = 250,
  className = "",
}: {
  /** The bubble's contents. Rich nodes are fine — that's half the point. */
  content: ReactNode;
  /** Exactly one element: the trigger. It is cloned to add `aria-describedby`. */
  children: ReactElement;
  /** Hover dwell before the bubble opens. Focus ignores this. */
  delayMs?: number;
  /** Extra classes for the wrapper (layout only). */
  className?: string;
}) {
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // null = closed. `below` flips the bubble under the trigger when there isn't
  // room above (a row near the top of the viewport).
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const close = useCallback(() => {
    clearTimer();
    setAt(null);
  }, []);

  const open = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Prefer above; drop below when the trigger sits too close to the top edge.
    const below = rect.top < 56;
    setAt({
      x: rect.left + rect.width / 2,
      y: below ? rect.bottom + 6 : rect.top - 6,
      below,
    });
  }, []);

  useEffect(() => clearTimer, []);

  // While open: dismiss on Escape, and on any scroll/resize — a fixed bubble
  // positioned from a stale rect would otherwise float away from its trigger.
  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [at, close]);

  // Nudge the bubble back inside the viewport. Done after render because it needs
  // the bubble's measured width — the chat list hugs the left edge, where a
  // centre-anchored bubble on a narrow icon button would otherwise overhang.
  useLayoutEffect(() => {
    if (!at || !bubbleRef.current) return;
    const w = bubbleRef.current.offsetWidth;
    if (!w) return; // jsdom / not laid out — leave the centre anchor alone
    const min = 8 + w / 2;
    const max = window.innerWidth - 8 - w / 2;
    const clamped = Math.min(Math.max(at.x, min), Math.max(min, max));
    if (clamped !== at.x) setAt({ ...at, x: clamped });
  }, [at]);

  const child = Children.only(children);
  const trigger = isValidElement(child)
    ? cloneElement(child as ReactElement<{ "aria-describedby"?: string }>, {
        "aria-describedby": at ? id : undefined,
      })
    : child;

  return (
    <>
      <span
        ref={wrapRef}
        className={`inline-flex ${className}`}
        onPointerEnter={(e) => {
          // Touch "hover" fires alongside the tap that already performs the
          // action, so a bubble there is noise. Pointer/keyboard only.
          if (e.pointerType === "touch") return;
          clearTimer();
          timer.current = setTimeout(open, delayMs);
        }}
        onPointerLeave={close}
        onPointerDown={close}
        onFocusCapture={open}
        onBlurCapture={close}
      >
        {trigger}
      </span>
      {at &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            style={{
              position: "fixed",
              left: at.x,
              top: at.y,
              transform: `translate(-50%, ${at.below ? "0" : "-100%"})`,
            }}
            className="pointer-events-none z-[70] max-w-[15rem] animate-fade-in rounded-lg bg-fg px-2 py-1 text-2xs leading-snug text-surface shadow-lg"
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
