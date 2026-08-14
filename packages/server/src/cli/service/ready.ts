/**
 * "Is it actually up?" — the bounded readiness poll the service CLI uses before
 * it claims success (#873, #861).
 *
 * Every service command that starts something has the same failure mode without
 * this: the supervisor accepts the request and returns, so the CLI prints a URL
 * and a cheerful past tense while the server is still binding — or is already
 * crash-looping on a port clash, which `launchctl` and `systemctl` will both
 * happily report as "running" for the ten seconds between restarts. A message
 * that can sit over a crash-loop and still say "running at <url>" is not a
 * status line, it is a guess.
 *
 * So the check is deliberately end-to-end: an HTTP request to the URL a human
 * would open, not a pid lookup. `/api/health` is the probe because it is in
 * `ALWAYS_PUBLIC_PATHS` (`auth.ts`) — it answers whatever `PADDOCK_AUTH_MODE`
 * the installed unit runs with, so this does not quietly stop working for the
 * people who configured a credential.
 *
 * The result is a tri-state on purpose. "I could not confirm it" is a real and
 * common answer — an unusual bind host, a slow first boot — and it is not the
 * same claim as "it failed". Callers print it as a caveat, not an error, and
 * point at the logs.
 */

/** Where the poll got to when it stopped. */
export type Readiness = "ready" | "timeout";

export interface ReadyOptions {
  /** Base URL of the server, e.g. `http://127.0.0.1:7233` — no trailing slash. */
  url: string;
  /** Give up after this long. */
  timeoutMs?: number;
  /** Gap between attempts. */
  intervalMs?: number;
  /** Injected for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Injected for tests, so a timeout can be proven without waiting for one. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long to wait before saying "could not confirm".
 *
 * Generous rather than snappy: this budget is only ever spent on the unhappy
 * path (a ready server answers in well under a second), and the cost of being
 * too short is a false "did not answer" on a cold boot — the single most
 * alarming thing this output could say about a service that is in fact fine.
 */
export const READY_TIMEOUT_MS = 20_000;

/** The same budget as prose, so a message and the clock cannot drift apart. */
export const READY_TIMEOUT_LABEL = `${READY_TIMEOUT_MS / 1000} seconds`;

const DEFAULT_INTERVAL_MS = 250;

/**
 * Poll `<url>/api/health` until it answers, or until `timeoutMs` elapses.
 *
 * Connection errors are the expected case rather than the exceptional one — a
 * server that has not finished binding refuses the connection — so they are
 * swallowed and retried. Only the clock ends the loop.
 *
 * Each request carries its own abort so a hung socket cannot outlive the budget
 * it was given; without it a single connection that opens and never replies
 * would park here well past `timeoutMs`.
 */
export async function waitForReady(opts: ReadyOptions): Promise<Readiness> {
  const {
    url,
    timeoutMs = READY_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    fetchImpl = fetch,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;

  const deadline = now() + timeoutMs;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) return "timeout";

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), Math.min(remaining, timeoutMs));
    try {
      const res = await fetchImpl(`${url}/api/health`, { signal: abort.signal });
      if (res.ok) return "ready";
    } catch {
      // Refused, reset, aborted — all "not yet", all retried until the clock says stop.
    } finally {
      clearTimeout(timer);
    }

    if (deadline - now() <= 0) return "timeout";
    await sleep(intervalMs);
  }
}
