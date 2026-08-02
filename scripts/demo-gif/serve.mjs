/**
 * serve.mjs — launch a Paddock server against a seeded demo data dir.
 *
 * Used by shoot.mjs (and runnable standalone for eyeballing the rig):
 *
 *   node scripts/demo-gif/serve.mjs --data /tmp/paddock-demo --port 5099
 *
 * ── Why this exists as its own module ───────────────────────────────────────
 * Two things about the environment are load-bearing and easy to get wrong:
 *
 *  1. **The environment must be scrubbed, not merely overridden.** A devbox that
 *     already runs Paddock exports ~20 `PADDOCK_*` vars. Several silently change
 *     what the camera sees — `PADDOCK_BRAND_NAME` / `PADDOCK_BRAND_LOGO` rebrand
 *     the sidebar, `PADDOCK_AUTH_*` 401s every request — and `PADDOCK_DATA_DIR`
 *     would point the demo at production data. So we build the child env from a
 *     whitelist instead of inheriting: anything `PADDOCK_*` not set below is
 *     deleted.
 *
 *  2. **The fake `claude` binary must win on PATH.** `test/bin/claude` is the
 *     deterministic stand-in used by the E2E suite. With `PADDOCK_DRIVE_MODE=batch`
 *     herdctl spawns `claude` from PATH, so prepending `test/bin` is what keeps
 *     the shoot free of real Anthropic calls. We also delete
 *     `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`: if a future change ever
 *     slips back onto the SDK runtime, we want it to fail loudly rather than
 *     quietly bill a real account.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Build a scrubbed child environment. See the header note on whitelisting. */
export function demoEnv({ dataDir, port, home, fakeScript }) {
  const env = { ...process.env };

  // Drop every inherited Paddock var — we set the ones we want below.
  for (const key of Object.keys(env)) {
    if (key.startsWith("PADDOCK_")) delete env[key];
  }
  // Credentials: absent on purpose, so an accidental real-runtime call fails
  // loudly instead of spending money. Do not "helpfully" restore these.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CONFIG_DIR;
  // The devbox exports NODE_ENV=production, which breaks the dev server paths.
  delete env.NODE_ENV;

  env.HOME = home;
  env.PATH = `${path.join(REPO_ROOT, "test", "bin")}${path.delimiter}${env.PATH}`;
  env.PORT = String(port);
  env.HOST = "127.0.0.1";
  env.PADDOCK_DATA_DIR = dataDir;
  env.PADDOCK_PROJECTS_DIR = path.join(dataDir, "projects");
  env.PADDOCK_WEB_DIST = path.join(REPO_ROOT, "packages", "web", "dist");
  // batch drive-mode → herdctl spawns the fake `claude` from PATH.
  env.PADDOCK_DRIVE_MODE = "batch";
  env.PADDOCK_AUTH_MODE = "none";
  env.PADDOCK_DANGEROUSLY_ALLOW_OPEN = "1";
  // The sweeper would rewrite the seeded OVERVIEW.md/CHANGELOG.md mid-shoot.
  env.PADDOCK_SWEEP_MIN_INTERVAL_MS = "999999999";
  env.LOG_LEVEL = "warn";
  if (fakeScript) env.PADDOCK_FAKE_SCRIPT = fakeScript;

  return env;
}

/** Spawn the server and resolve once /api/health answers. */
export async function startServer({ dataDir, port, home, fakeScript, logFile }) {
  const entry = path.join(REPO_ROOT, "packages", "server", "dist", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Server build missing at ${entry}\nRun:  env -u NODE_ENV npm run build`,
    );
  }

  const log = logFile ? fs.openSync(logFile, "w") : "ignore";
  const child = spawn(process.execPath, [entry], {
    env: demoEnv({ dataDir, port, home, fakeScript }),
    stdio: ["ignore", log, log],
    detached: false,
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      const tail = logFile ? `\n--- server log ---\n${fs.readFileSync(logFile, "utf8").slice(-2000)}` : "";
      throw new Error(`Server exited early (code ${child.exitCode})${tail}`);
    }
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`Server did not become healthy at ${base}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  return { child, base, stop: () => { try { child.kill("SIGTERM"); } catch {} } };
}

// Standalone: `node scripts/demo-gif/serve.mjs --data DIR --port N`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? dflt : process.argv[i + 1];
  };
  const dataDir = path.resolve(arg("data", "/tmp/paddock-demo/data"));
  const port = Number(arg("port", "5099"));
  const home = path.resolve(arg("home", path.join(path.dirname(dataDir), "home")));
  const fakeScript = arg("fake-script", path.join(path.dirname(dataDir), "fake-script.json"));

  const { base } = await startServer({
    dataDir,
    port,
    home,
    fakeScript: fs.existsSync(fakeScript) ? fakeScript : undefined,
    logFile: path.join(path.dirname(dataDir), "server.log"),
  });
  console.log(`Paddock demo server up: ${base}`);
  console.log("Ctrl-C to stop.");
}
