import { useEffect, useState } from "react";

/**
 * Resolve a MediaQueryList defensively: null when `matchMedia` is unavailable
 * (SSR/jsdom) OR returns a non-object (a partial test mock). Keeps the hook from
 * throwing on `.matches` in any of those environments.
 */
function getMql(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(query) ?? null;
  } catch {
    return null;
  }
}

/**
 * Subscribe to a CSS media query, returning whether it currently matches (#374).
 * SSR/jsdom-safe: when `window.matchMedia` is unavailable (or returns nothing) it
 * reports `false`, so a server render / test defaults to the mobile-first layout
 * and never crashes. Used to gate the desktop-only pane-resize affordance to
 * `(min-width: 1024px)` (Tailwind's `lg`), so applying an inline pixel width
 * never fights the mobile off-canvas drawer.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => getMql(query)?.matches ?? false);

  useEffect(() => {
    const mql = getMql(query);
    if (!mql) return;
    const onChange = () => setMatches(!!mql.matches);
    onChange(); // sync in case it changed between render and effect
    // Older Safari only has add/removeListener; guard both APIs.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener?.(onChange);
    return () => mql.removeListener?.(onChange);
  }, [query]);

  return matches;
}
