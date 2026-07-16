/**
 * Router error boundary (issue #222).
 *
 * Wired as the root route's `errorElement`, so it catches anything thrown while
 * rendering the app — including a rejected lazy-route `import()` (a stale chunk
 * after a deploy, or a transient auth/network blip). Without it, such a failure
 * dead-ends at React Router's default "Unexpected application error" screen.
 *
 * For a chunk-load error we reload ONCE onto the current build (guarded against
 * loops); for anything else — or a chunk error that already survived a reload —
 * we show a friendly error with a manual reload.
 */
import { useEffect } from "react";
import { useRouteError } from "react-router-dom";
import { decideChunkRecovery, markReloaded } from "../lib/chunk-error";

export function RouteError() {
  const error = useRouteError();
  const action = decideChunkRecovery(error);

  useEffect(() => {
    if (action === "reload") {
      markReloaded();
      window.location.reload();
    }
  }, [action]);

  if (action === "reload") {
    // A fresh build is (almost certainly) live — reload is imminent. Show the
    // same unobtrusive spinner the route fallback uses, not an error.
    return (
      <div
        className="flex h-[100dvh] items-center justify-center bg-canvas dark:bg-canvas-dark"
        aria-busy="true"
        aria-live="polite"
      >
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-paddock-300 border-t-accent dark:border-paddock-700 dark:border-t-accent" />
        <span className="sr-only">Updating…</span>
      </div>
    );
  }

  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-canvas px-6 text-center dark:bg-canvas-dark">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-1 max-w-md text-sm text-paddock-500 dark:text-paddock-400">
          The app hit an unexpected error. Reloading usually fixes it.
        </p>
        {message ? (
          <p className="mt-2 max-w-md break-words font-mono text-[11px] text-paddock-400">
            {message}
          </p>
        ) : null}
      </div>
      <button className="btn-primary" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
