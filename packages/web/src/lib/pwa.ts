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
    const sw = navigator.serviceWorker;
    // Whether a SW already controls this page at load. A later `controllerchange`
    // only means "a NEW build activated" (skipWaiting + clients.claim) when a
    // controller was already in place — the first-ever install also fires
    // controllerchange but needs no reload (issue #221).
    const hadController = !!sw.controller;
    let reloading = false;
    sw.addEventListener("controllerchange", () => {
      if (reloading || !hadController) return;
      reloading = true;
      // A fresh build took control — reload once so this tab runs the new assets
      // instead of a stale mix (prevents post-deploy "module script failed").
      window.location.reload();
    });
    sw.register("/sw.js").catch(() => {
      // Non-fatal: no offline support this session.
    });
  });
}
