/**
 * PWA service-worker registration (issue #199).
 *
 * Registered from main.tsx after load. Guarded so it's a no-op where a service
 * worker would be useless or harmful:
 *  - `serviceWorker` unsupported (older browsers) → skip.
 *  - Dev (`import.meta.env.DEV`) → skip, so the SW never shadows Vite's HMR /
 *    module graph during local development.
 *
 * The SW itself (`/public/sw.js`) is served from the web root, so its scope is
 * the whole app ("/"). Registration failures are swallowed — a broken SW must
 * never take down the app; the site just runs without offline support.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Non-fatal: no offline support this session.
    });
  });
}
