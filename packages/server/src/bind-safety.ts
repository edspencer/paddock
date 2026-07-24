/**
 * Safe-by-default bind guard (#435).
 *
 * Paddock runs code and spends Claude tokens, so a careless launch on a routable
 * interface is a real footgun. Two things protect against it:
 *
 *  1. The bind host now defaults to `127.0.0.1` (see config.ts) — a fresh
 *     source/tarball run is network-closed.
 *  2. This guard couples EXPOSURE to AUTH: if the resolved bind host is
 *     NON-loopback AND `auth.mode === "none"`, Paddock REFUSES to start — mirroring
 *     the jwt-without-JWKS fail-closed behavior in auth.ts — unless the operator
 *     sets `PADDOCK_DANGEROUSLY_ALLOW_OPEN` (accepts 1/true/yes), in which case it
 *     starts but logs a loud one-line warning.
 *
 * Binding non-loopback WITH a real auth mode (`trusted-header`/`jwt`) is fine and
 * needs no flag.
 *
 * Scope note: this is the APP/source-layer guard for bare-metal / tarball / VM /
 * LXC-systemd runs. Inside a container the network namespace is the isolation
 * boundary and the app can't see the host's port-publish posture, so the image
 * keeps binding `0.0.0.0` and the deploy RECIPE carries the safe publish posture
 * (see #406/#410) — this guard is not the container's police.
 */
import type { AuthMode } from "./config.js";

/** Inputs the bind-safety decision is a pure function of. */
export interface BindSafetyInput {
  /** The resolved bind host (cfg.host). */
  host: string;
  /** The resolved auth mode (cfg.auth.mode). */
  authMode: AuthMode;
  /** Whether PADDOCK_DANGEROUSLY_ALLOW_OPEN is set (truthy). */
  dangerouslyAllowOpen: boolean;
}

export type BindSafetyDecision =
  | { action: "allow" }
  | { action: "warn"; message: string }
  | { action: "refuse"; message: string };

/**
 * True when `host` names a loopback-only interface — one that is NOT reachable
 * from other machines. Covers `localhost`, the whole IPv4 `127.0.0.0/8` block,
 * the IPv6 loopback `::1`, and IPv4-mapped loopback (`::ffff:127.x.x.x`). Bracket
 * forms (`[::1]`) and surrounding whitespace/case are normalized away.
 *
 * `0.0.0.0` and `::` (all interfaces) are NOT loopback — they are the footgun.
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost") return true;
  if (h === "::1") return true;
  // IPv4-mapped IPv6 loopback, e.g. ::ffff:127.0.0.1
  const mapped = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  // IPv4 127.0.0.0/8 — first octet 127, and a plausible dotted-quad shape.
  return /^127(?:\.\d{1,3}){3}$/.test(mapped);
}

/**
 * Decide whether it's safe to bind `host` under `authMode`. Pure — the caller
 * (assertBindSafety) resolves env and acts on the decision (throw / warn / go).
 */
export function evaluateBindSafety(input: BindSafetyInput): BindSafetyDecision {
  const { host, authMode, dangerouslyAllowOpen } = input;

  // Loopback bind, or a real auth mode gating a non-loopback bind: safe.
  if (isLoopbackHost(host) || authMode !== "none") return { action: "allow" };

  // Non-loopback + auth.mode=none — the footgun.
  if (dangerouslyAllowOpen) {
    return {
      action: "warn",
      message:
        `SECURITY: binding ${host} with PADDOCK_AUTH_MODE=none and ` +
        `PADDOCK_DANGEROUSLY_ALLOW_OPEN set — Paddock is OPEN and UNAUTHENTICATED ` +
        `on a routable interface. Anyone who can reach this port can run code and ` +
        `spend Claude tokens as you. Put an auth mode / reverse proxy in front of it.`,
    };
  }

  return {
    action: "refuse",
    message:
      `refusing to start: bind host "${host}" is not loopback and ` +
      `PADDOCK_AUTH_MODE=none, which would expose an unauthenticated Paddock (it ` +
      `runs code and spends Claude tokens) on a routable interface. Choose one: ` +
      `set an auth mode behind a reverse proxy (PADDOCK_AUTH_MODE=trusted-header|jwt); ` +
      `bind loopback (HOST=127.0.0.1) and reach it via a proxy/sidecar; or — only ` +
      `if you TRULY intend an open, unauthenticated server — set ` +
      `PADDOCK_DANGEROUSLY_ALLOW_OPEN=1.`,
  };
}
