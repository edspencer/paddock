/**
 * Recovery for failed lazy-route imports (issue #222).
 *
 * The routes in main.tsx are code-split via `React.lazy(() => import(...))`. A
 * dynamic import can reject for two mundane, recoverable reasons:
 *   - a deploy changed the chunk hashes and this tab is holding the old ones
 *     (the new build no longer has them), or
 *   - a transient auth lapse / network blip 401'd or dropped the chunk request.
 * Either way the right move is "I'm probably on a stale build — reload onto the
 * current one", not the dead-end "Unexpected application error" screen.
 *
 * These helpers detect that class of error and bound reloads to at most once per
 * short window (via sessionStorage) so a genuinely-broken build can't loop.
 */

const RELOAD_KEY = "paddock:chunkReloadAt";
const RELOAD_WINDOW_MS = 10_000;

// Cross-browser wording for a dynamic-import / module-script load failure:
//   Chrome:  "Failed to fetch dynamically imported module: <url>"
//   Firefox: "error loading dynamically imported module"
//   Safari:  "Importing a module script failed." / "module script failed"
//   Vite:    preload errors surface as "Failed to fetch" / "Unable to preload"
const CHUNK_ERROR_RE =
  /dynamically imported module|module script|importing a module|failed to fetch|unable to preload|load failed|error loading/i;

/** True when `error` looks like a failed lazy-chunk / module-script import. */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error) {
    if (error.name === "ChunkLoadError") return true;
    return CHUNK_ERROR_RE.test(error.message);
  }
  return CHUNK_ERROR_RE.test(String(error));
}

function safeSession(): Storage | undefined {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : undefined;
  } catch {
    // Access can throw in sandboxed/partitioned contexts.
    return undefined;
  }
}

/**
 * Whether we already triggered a chunk-error reload within the recent window — if
 * so, reloading again would loop, so the caller should show the error UI instead.
 */
export function reloadedRecently(now: number = Date.now(), storage = safeSession()): boolean {
  if (!storage) return false;
  const raw = storage.getItem(RELOAD_KEY);
  if (!raw) return false; // never reloaded — distinct from a timestamp of 0
  const last = Number(raw);
  return Number.isFinite(last) && now - last < RELOAD_WINDOW_MS;
}

/** Stamp "we just reloaded for a chunk error" so a repeat failure won't loop. */
export function markReloaded(now: number = Date.now(), storage = safeSession()): void {
  try {
    storage?.setItem(RELOAD_KEY, String(now));
  } catch {
    /* storage unavailable — the reload still happens, just unguarded */
  }
}

/**
 * Decide the response to a route error: reload once for a fresh chunk failure,
 * otherwise surface it. Pure so it's unit-testable; the component performs the
 * actual `location.reload()`.
 */
export function decideChunkRecovery(
  error: unknown,
  now: number = Date.now(),
  storage = safeSession(),
): "reload" | "show" {
  if (isChunkLoadError(error) && !reloadedRecently(now, storage)) return "reload";
  return "show";
}
