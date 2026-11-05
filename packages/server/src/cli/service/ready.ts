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
import net from "node:net";

/** Where the poll got to when it stopped. */
export type Readiness = "ready" | "timeout";

/** What `/api/health` said, when it said anything (SPEC §8). */
export interface HealthAnswer {
  ok: boolean;
  /** The version the RUNNING server reports. Absent from a pre-contract Paddock. */
  version?: string;
}

/**
 * Ask `<url>/api/health` once, and say what it answered.
 *
 * Distinct from {@link waitForReady}, which only needs a boolean and polls for
 * it. `status` needs the body: the version in it is the only way to tell a
 * server that is running the installed Paddock from one that has been up since
 * before an upgrade — the single most confusing state a service can be in, and
 * invisible from the outside until something reports both numbers.
 *
 * `undefined` means nothing answered. That is a real answer (exit 3), not an
 * error, so nothing is thrown.
 */
export async function fetchHealth(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<HealthAnswer | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${url}/api/health`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ok?: unknown; version?: unknown };
    return {
      ok: body.ok === true,
      ...(typeof body.version === "string" ? { version: body.version } : {}),
    };
  } catch {
    return undefined;
  }
}

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

/** What {@link waitForVersion} concluded (CLI contract SPEC §5 step 12). */
export type VersionVerdict =
  | { state: "ok"; version: string }
  /** Something answers, and it is not the version we were waiting for. */
  | { state: "wrong-version"; version: string }
  | { state: "no-answer" };

/**
 * Poll until `/api/health` reports exactly `version` (SPEC §5 step 12).
 *
 * The version is the point, and it is what makes `update`'s health check mean
 * something. "The URL answers" is satisfied by the OLD server that has not
 * finished shutting down, by a sibling instance on the same port, and by a
 * supervisor that restarted the old unit because the new one crashed — all
 * three of which are exactly the failures step 13's rollback exists for. An
 * update that polled for a 200 would call every one of them a success.
 *
 * The distinction between "no answer" and "the wrong version answers" is kept
 * because the two read completely differently in a failure report: one is a
 * server that did not come up, the other is a server that came up as something
 * else.
 */
export async function waitForVersion(opts: ReadyOptions & { version: string }): Promise<VersionVerdict> {
  const {
    url,
    version,
    timeoutMs = READY_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    fetchImpl = fetch,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;

  const deadline = now() + timeoutMs;
  let last: string | undefined;
  for (;;) {
    const health = await fetchHealth(url, {
      fetchImpl,
      timeoutMs: Math.max(250, Math.min(2_000, deadline - now())),
    });
    if (health?.version !== undefined) {
      if (health.version === version) return { state: "ok", version };
      last = health.version;
    }
    if (deadline - now() <= 0) {
      return last !== undefined ? { state: "wrong-version", version: last } : { state: "no-answer" };
    }
    await sleep(intervalMs);
  }
}

/** Is anything accepting connections at host:port? A second at most. */
export function isListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.setTimeout(1000);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("timeout", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(false));
  });
}

/**
 * Is what answers at `url` a Paddock, and which version? Undefined when nothing
 * answers `/api/health` there.
 *
 * `/api/health`'s `{ ok, version }` is the CLI contract's, so every one of the
 * six tools answers it alike; `/api/busy`'s `counts.chat` and
 * `counts.background` are Paddock's own. A Paddock older than 0.81 has no
 * `/api/busy`, and reads as not-Paddock here — callers that can tell it apart
 * some other way (an installed unit on that port) should.
 */
export async function identifyPaddock(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ paddock: boolean; version?: string } | undefined> {
  const health = await fetchHealth(url, { fetchImpl });
  if (health === undefined) return undefined;
  const version = health.version !== undefined ? { version: health.version } : {};
  try {
    const res = await fetchImpl(`${url}/api/busy`, { signal: AbortSignal.timeout(2_000) });
    const body = (await res.json()) as { counts?: Record<string, unknown> };
    const counts = body.counts ?? {};
    return { paddock: health.ok && typeof counts.chat === "number" && "background" in counts, ...version };
  } catch {
    return { paddock: false, ...version };
  }
}
