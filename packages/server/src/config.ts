/**
 * Paddock server configuration, sourced from environment with sane defaults.
 *
 * Everything is resolved once at startup so the rest of the app can import a
 * frozen object. Paths are normalised to absolute.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export interface PaddockConfig {
  /** HTTP/WS port. */
  port: number;
  /** Bind host. */
  host: string;
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
    projectsRoot,
    stateDir,
    herdctlConfigPath,
    webDist: abs(envOr("PADDOCK_WEB_DIST", defaultWebDist)),
    scratchDir,
  });
}

/** Default Claude home, used for session discovery. */
export function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude");
}
