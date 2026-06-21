/**
 * Paddock server configuration, sourced from environment with sane defaults.
 *
 * Everything is resolved once at startup so the rest of the app can import a
 * frozen object. Paths are normalised to absolute.
 */
import path from "node:path";
import os from "node:os";

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

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v : fallback;
}

export function loadPaddockConfig(): PaddockConfig {
  const dataRoot = abs(envOr("PADDOCK_DATA_DIR", "./data"));
  const projectsRoot = abs(envOr("PADDOCK_PROJECTS_DIR", path.join(dataRoot, "projects")));
  const stateDir = abs(envOr("PADDOCK_STATE_DIR", path.join(dataRoot, ".herdctl")));
  const herdctlConfigPath = abs(
    envOr("PADDOCK_HERDCTL_CONFIG", path.join(dataRoot, "herdctl.yaml")),
  );
  const scratchDir = abs(envOr("PADDOCK_SCRATCH_DIR", path.join(dataRoot, "scratch")));

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
