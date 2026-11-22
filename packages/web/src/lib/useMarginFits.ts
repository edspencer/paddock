import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * Whether the element is at least `minRem` wide, kept current by a
 * ResizeObserver: whether the transcript has room for something in the margin
 * beside its centred column. False where there is no ResizeObserver (jsdom) or
 * no layout. A container query cannot be used for this: `container-type` makes
 * the transcript the containing block for its `fixed` overlays.
 */
export function useMarginFits(ref: RefObject<HTMLElement | null>, minRem: number): boolean {
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setFits(el.getBoundingClientRect().width >= minRem * rem);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, minRem]);
  return fits;
}
