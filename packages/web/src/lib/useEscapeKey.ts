import { useEffect } from "react";

/**
 * Close-on-Escape for modals.
 *
 * Every dialog in the app had grown its own copy of this `window` keydown
 * listener; #541 was about to add a third, which is the point at which it
 * earned being one function.
 *
 * `enabled` is normally the modal's `open` flag. Pass `false` to make Escape a
 * no-op — `ConfirmDialog` uses that to ignore Escape while an async confirm is
 * still in flight, so you can't dismiss a dialog out from under a request that
 * is already running.
 */
export function useEscapeKey(enabled: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, onEscape]);
}
