/**
 * Paddock server configuration, sourced from environment with sane defaults.
 *
 * Everything is resolved once at startup so the rest of the app can import a
 * frozen object. Paths are normalised to absolute.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * User-authentication strategy.
 *
 * - `none`            — no auth; every request is anonymous (default, fully open).
 * - `trusted-header`  — trust a reverse proxy to have authenticated the user and
 *                       pass identity in headers. Spoofable unless the proxy is
 *                       the only path to paddock (network-level trust).
 * - `jwt`             — verify a signed JWT (issued by the proxy/IdP) against a
 *                       remote JWKS. Self-contained / zero-trust: spoof-proof
 *                       even if a request reaches paddock directly.
 */
export type AuthMode = "none" | "trusted-header" | "jwt";

/**
 * Resolved authentication configuration (provider-agnostic).
 *
 * Driven entirely by `PADDOCK_AUTH_*` env vars so paddock is not coupled to any
 * single proxy/IdP (Authentik, oauth2-proxy, Authelia, Cloudflare Access,
 * Keycloak, …). See AUTH.md for the modes and provider examples.
 */
export interface AuthConfig {
  mode: AuthMode;
  /** trusted-header: header carrying the username (required in that mode). */
  userHeader: string;
  /** trusted-header: optional header carrying the user's email. */
  emailHeader?: string;
  /**
   * trusted-header / jwt: optional header carrying group membership. In
   * trusted-header mode the value is split on comma; in jwt mode this overrides
   * the claim source only when the proxy passes groups as a header (rare).
   */
  groupsHeader?: string;
  /** jwt: header carrying the token. `Authorization` strips a leading `Bearer `. */
  jwtHeader: string;
  /** jwt: JWKS endpoint used to verify the token signature (required in jwt mode). */
  jwksUrl?: string;
  /** jwt: expected `iss` claim (validated when set). */
  jwtIssuer?: string;
  /** jwt: expected `aud` claim (validated when set). */
  jwtAudience?: string;
  /** jwt: claim to read the username from (falls back preferred_username→email→sub). */
  usernameClaim?: string;
  /** jwt: claim to read groups from (default `groups`). */
  groupsClaim: string;
}

export interface PaddockConfig {
  /** HTTP/WS port. */
  port: number;
  /** Bind host. */
  host: string;
  /** Absolute (canonical) path to the data root. Holds state files (e.g. sweep). */
  dataDir: string;
  /** Absolute path to the root that contains per-project directories. */
  projectsRoot: string;
  /** Absolute path to the herdctl state directory (.herdctl). */
  stateDir: string;
  /**
   * Absolute path to the generated herdctl.yaml that the FleetManager loads.
   * Paddock owns/regenerates this file (one keeper agent per project).
   */
  herdctlConfigPath: string;
  /** Absolute path to the built web SPA (served in production). */
  webDist: string;
  /** Working directory for one-off / scratch chats. */
  scratchDir: string;
  /** Provider-agnostic user-authentication config (see AUTH.md). */
  auth: AuthConfig;
}

function abs(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * Canonicalize a path: resolve symlinks in the deepest EXISTING ancestor, then
 * re-append the not-yet-created tail. This matters because Claude Code records
 * session transcripts under the *real* working directory (e.g. macOS maps
 * `/tmp` -> `/private/tmp`), and SessionDiscoveryService encodes the configured
 * working_directory to find them. Without canonicalization the configured path
 * and the recorded path diverge and session discovery returns nothing.
 *
 * On Linux (the deploy target) this is typically a no-op, but it keeps paddock
 * portable and robust against symlinked data roots.
 */
function canonical(p: string): string {
  const absolute = abs(p);
  let dir = absolute;
  const tail: string[] = [];
  // Walk up to the first existing ancestor.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = fs.realpathSync(dir);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return absolute; // reached root without resolving
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v : fallback;
}

/** An env var's trimmed value, or undefined when unset/blank. */
function envOpt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Resolve the provider-agnostic auth config from `PADDOCK_AUTH_*` env vars.
 * Everything is optional; the default is `none` (fully open), preserving the
 * historical behaviour. Validation of mode-specific requirements (e.g. a JWKS
 * URL in jwt mode) happens in the auth plugin so a misconfig surfaces as a clear
 * startup error rather than a silently-open server.
 */
function loadAuthConfig(): AuthConfig {
  const rawMode = envOr("PADDOCK_AUTH_MODE", "none").toLowerCase();
  const mode: AuthMode =
    rawMode === "trusted-header" || rawMode === "jwt" ? rawMode : "none";

  return {
    mode,
    userHeader: envOr("PADDOCK_AUTH_USER_HEADER", "X-Forwarded-User"),
    emailHeader: envOpt("PADDOCK_AUTH_EMAIL_HEADER"),
    groupsHeader: envOpt("PADDOCK_AUTH_GROUPS_HEADER"),
    jwtHeader: envOr("PADDOCK_AUTH_JWT_HEADER", "Authorization"),
    jwksUrl: envOpt("PADDOCK_AUTH_JWKS_URL"),
    jwtIssuer: envOpt("PADDOCK_AUTH_JWT_ISSUER"),
    jwtAudience: envOpt("PADDOCK_AUTH_JWT_AUDIENCE"),
    usernameClaim: envOpt("PADDOCK_AUTH_USERNAME_CLAIM"),
    groupsClaim: envOr("PADDOCK_AUTH_GROUPS_CLAIM", "groups"),
  };
}

export function loadPaddockConfig(): PaddockConfig {
  // Ensure the data root exists first so symlinks (e.g. /tmp -> /private/tmp on
  // macOS) resolve consistently for every derived path below.
  const dataRoot = abs(envOr("PADDOCK_DATA_DIR", "./data"));
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
  } catch {
    /* best-effort; downstream mkdirs will surface real errors */
  }
  // working_directory of keeper/scratch agents MUST be canonical so session
  // discovery (which encodes the real path) can find Claude transcripts.
  const dataDir = canonical(dataRoot);
  const projectsRoot = canonical(envOr("PADDOCK_PROJECTS_DIR", path.join(dataRoot, "projects")));
  const stateDir = canonical(envOr("PADDOCK_STATE_DIR", path.join(dataRoot, ".herdctl")));
  const herdctlConfigPath = canonical(
    envOr("PADDOCK_HERDCTL_CONFIG", path.join(dataRoot, "herdctl.yaml")),
  );
  const scratchDir = canonical(envOr("PADDOCK_SCRATCH_DIR", path.join(dataRoot, "scratch")));

  // packages/server/src/config.ts -> packages/web/dist
  const defaultWebDist = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../web/dist",
  );

  return Object.freeze({
    port: Number(envOr("PORT", "4000")),
    host: envOr("HOST", "0.0.0.0"),
    dataDir,
    projectsRoot,
    stateDir,
    herdctlConfigPath,
    webDist: abs(envOr("PADDOCK_WEB_DIST", defaultWebDist)),
    scratchDir,
    auth: loadAuthConfig(),
  });
}

/** Default Claude home, used for session discovery. */
export function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude");
}
