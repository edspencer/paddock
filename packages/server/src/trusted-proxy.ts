/**
 * Which peers' `X-Forwarded-Proto` the `/mcp` transport guard believes (#474).
 *
 * #471 gave the Management API a plaintext guard: a bearer token must not cross
 * a real network readable-in-transit, so `/mcp` refuses plaintext from anything
 * but a loopback client. It also accepted `X-Forwarded-Proto: https` — from ANY
 * peer, with no trust check — so the guard could be switched off by the very
 * operator it protects, with a header copy-pasted out of a smoke-test recipe.
 *
 * ── What this is and is not ────────────────────────────────────────────────
 * NOT an authentication control. A valid bearer token is still required, and an
 * attacker who spoofs the header gains nothing they could not already do — they
 * still need the credential. What the header could do was mislead an OPERATOR
 * into believing their token was protected while it travelled in clear. So the
 * job here is to make the "is this connection secure?" answer rest on something
 * the caller cannot set: the immediate peer's address, taken from the socket.
 *
 * ── The trust list ─────────────────────────────────────────────────────────
 * A forwarded scheme is believed only from a peer in the trusted list. Entries
 * are IPs, CIDRs, or the {@link proxyAddr} preset names (`loopback`,
 * `linklocal`, `uniquelocal`), plus two words of our own: `none` (believe no
 * peer) and `all` (believe everyone — the pre-#474 behaviour, reportable and
 * loud).
 *
 * The DEFAULT is {@link DEFAULT_TRUSTED_PROXIES}: loopback + link-local +
 * unique-local (RFC1918 / fc00::/7 / fe80::/10). That is a COMPATIBILITY
 * posture, chosen because in every deployment recipe the TLS terminator sits on
 * the host or on a private container/pod network — an nginx or Caddy sidecar on
 * a Compose bridge, an ingress in a pod network, a proxy on loopback. A peer
 * with a PUBLIC address is never one of those, so believing it is always wrong;
 * that case is now refused where it previously succeeded.
 *
 * The default's honest limit: it cannot tell your reverse proxy at 172.18.0.5
 * from a laptop at 192.168.1.50, because nothing in an IP packet says which one
 * is a proxy. Naming the proxy explicitly is what upgrades this from a footgun
 * preventer to a control, and the guard says so at runtime — believing a
 * forwarded scheme under the default list logs a one-per-peer warning.
 *
 * Deliberately NOT loopback-equivalent: the Docker bridge gateway (`172.17.0.1`).
 * A request from another host to a `0.0.0.0`-published port is SNAT'd to that
 * same address, so "peer is the gateway" does not prove the traffic stayed on
 * the box. Smoke-test from INSIDE the container instead (`docker compose exec
 * paddock curl http://127.0.0.1:7233/mcp …`), where the peer really is loopback.
 */
import proxyAddr from "proxy-addr";

/**
 * The compatibility default: loopback plus the private address space. See the
 * module header for why this is the default and what it does not prove.
 */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = ["loopback", "linklocal", "uniquelocal"];

/** Believe no peer at all — the strict posture. */
export const TRUST_NONE = "none";
/** Believe every peer — restores the pre-#474 behaviour. Reported loudly. */
export const TRUST_ALL = "all";

/** A resolved trust list plus how we came by it. */
export interface TrustedProxies {
  /**
   * The entries as configured (already validated). Empty means "believe no
   * peer". `["all"]` means "believe every peer".
   */
  entries: string[];
  /**
   * True when the operator named these peers (env or YAML), false when this is
   * {@link DEFAULT_TRUSTED_PROXIES}. Only an explicit list is a control, so the
   * guard warns when a forwarded scheme is believed under the default.
   */
  explicit: boolean;
}

/** The default list, wrapped. */
export function defaultTrustedProxies(): TrustedProxies {
  return { entries: [...DEFAULT_TRUSTED_PROXIES], explicit: false };
}

export interface ParsedTrustedProxies {
  trusted: TrustedProxies;
  /** Entries that were dropped because they are not an IP, CIDR, or preset. */
  errors: string[];
  /** Advice worth logging at boot (currently: `all` disables the guard). */
  warnings: string[];
}

/**
 * Parse an operator-supplied list (a YAML array, or a comma/newline-delimited
 * string) into a validated trust list.
 *
 * An unparseable entry is DROPPED with an error rather than taking the instance
 * down — one typo in a CIDR must not stop Paddock booting. Note the direction of
 * that failure: dropping an entry can only make the guard stricter (a peer stops
 * being trusted), never more permissive, so the fail-safe way is also the safe
 * way here.
 *
 * `undefined` / empty input means "the operator said nothing" and yields the
 * default list; an explicit `none` yields an empty, explicit list.
 */
export function parseTrustedProxies(raw: string[] | string | undefined): ParsedTrustedProxies {
  const errors: string[] = [];
  const warnings: string[] = [];

  const tokens = (
    Array.isArray(raw)
      ? raw.map((v) => String(v))
      : String(raw ?? "")
          .split(/[\n,]/)
          .map((v) => v)
  )
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);

  if (tokens.length === 0) return { trusted: defaultTrustedProxies(), errors, warnings };

  if (tokens.includes(TRUST_ALL) || tokens.includes("*")) {
    warnings.push(
      `managementApi.trustedProxies: "all" — every peer's X-Forwarded-Proto is believed, so the ` +
        `/mcp plaintext guard can be switched off by any client that can reach this instance. ` +
        `This is the pre-#474 behaviour; name your proxy's address instead.`,
    );
    return {
      trusted: { entries: [TRUST_ALL], explicit: true },
      errors,
      warnings,
    };
  }

  const entries: string[] = [];
  for (const token of tokens) {
    if (token === TRUST_NONE) continue; // an explicit empty list
    try {
      proxyAddr.compile([token]);
      entries.push(token);
    } catch {
      errors.push(
        `managementApi.trustedProxies: "${token}" is not an IP address, CIDR, or one of ` +
          `loopback/linklocal/uniquelocal/none/all — entry ignored`,
      );
    }
  }

  return { trusted: { entries, explicit: true }, errors, warnings };
}

/**
 * Compiled matchers, keyed by the joined list. `proxyAddr.compile` parses every
 * entry, so we do it once per distinct list rather than once per request.
 */
const compiled = new Map<string, (addr: string) => boolean>();

function matcherFor(entries: string[]): (addr: string) => boolean {
  const key = entries.join(",");
  let fn = compiled.get(key);
  if (!fn) {
    if (entries.length === 0) {
      fn = () => false;
    } else if (entries.length === 1 && entries[0] === TRUST_ALL) {
      fn = () => true;
    } else {
      const trust = proxyAddr.compile(entries);
      fn = (addr: string) => trust(addr, 0);
    }
    compiled.set(key, fn);
  }
  return fn;
}

/**
 * Whether `addr` — the IMMEDIATE peer from the socket, never a header — is a
 * trusted proxy. An unknown/absent address is never trusted.
 */
export function isTrustedProxy(addr: string | undefined, trusted: TrustedProxies): boolean {
  if (!addr) return false;
  try {
    return matcherFor(trusted.entries)(addr);
  } catch {
    // proxyAddr throws on an address it cannot parse (it should not happen for a
    // real socket, but a malformed value must not 500 the request).
    return false;
  }
}

/**
 * Whether `addr` is a loopback socket address — the client is on this host, so
 * nothing was put on a wire. Covers IPv4 `127.0.0.0/8`, IPv6 `::1`, and the
 * IPv4-mapped form Node reports on a dual-stack listener.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return isTrustedProxy(addr, { entries: ["loopback"], explicit: false });
}
