/**
 * `paddock doctor [--json] [--offline]` (CLI contract SPEC §1).
 *
 * One `✓` / `!` / `✗` line a check (`-` for one that doesn't apply here), with a
 * `fix:` line under every failure and warning. Exit 1 if any check failed;
 * warnings don't change the code.
 *
 * The contract's eight come first, with the ids every tool uses so a script can
 * read any of them: `node-engines`, `install-method`, `unit`,
 * `running-version`, `port`, `linger`, `data-home` and `update`. Then Paddock's
 * own: the config loads (`config`), the projects folder (`projects`), a Claude
 * login it can use (`claude-login`) and a `claude` on PATH (`claude-cli`).
 *
 * It only reads, with one exception: like `update --check`, the `update` check
 * writes what it found to `<data-dir>/update-check.json`, so `service status`
 * can repeat it (SPEC §3) — but only into a data dir that's already there, so
 * `doctor` never creates an instance. It asks the npm registry only because a
 * person ran it, and `--offline` doesn't. It never prints a credential: the
 * login check says which KIND of login it found.
 *
 * The service checks reuse `service status`'s own report (`buildStatus`), so the
 * two cannot disagree about what is installed and what is running.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MIN_NODE_MAJOR, type CliOptions } from "./args.js";
import { EXIT } from "./exit-codes.js";
import {
  buildStatus,
  serviceBackend,
  type ServiceContext,
  type StatusReport,
} from "./service/index.js";
import { defaultDataDir, DEFAULT_PORT } from "./service/spec.js";
import { missingPaths, which } from "./service/path-env.js";
import type { LingerState, ServiceManager } from "./service/manager.js";
import { fetchHealth } from "./service/ready.js";
import { describeInstall, detectInstall, updateCommand, type InstallInfo } from "./update/install-method.js";
import { npmConfigGet, npmGlobalRoot } from "./update/package-manager.js";
import { RegistryError, resolveRegistry, resolveTarget } from "./update/registry.js";
import { compareVersions, isPrerelease, satisfiesEngines } from "./update/semver.js";
import { updateNotice, writeUpdateCheck } from "./update/update-check.js";
import { readLiveRuntimeFile } from "../runtime-file.js";
import { PADDOCK_NAME, PADDOCK_VERSION } from "../version.js";
import {
  PADDOCK_IMAGE,
  PADDOCK_PACKAGE,
  paddockChangelogUrl,
} from "./update-command.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

/** One line of the report, and one entry of `--json`'s `checks` (`schemas/doctor.schema.json`). */
export interface Check {
  /** Stable, for scripts. */
  id: string;
  status: CheckStatus;
  message: string;
  /** What to do about it. Every `fail` has one, and so does every `warn`. */
  fix?: string;
}

const MARK: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗", skip: "-" };

/** The variables that log Claude Code in without a file (the same list `claude-home.ts` checks at boot). */
const TOKEN_ENV_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** What `doctor` reads of the instance's resolved config. */
export interface InstanceConfig {
  projectsRoot: string;
  claudeHome: string;
  credentials: "own" | "host";
  driveMode: "session" | "batch";
}

export interface DoctorInput {
  ctx: ServiceContext;
  /** `--data-dir`, when it was given. */
  dataDir?: string;
  offline?: boolean;
  /** `process.argv[1]`, for SPEC §6's walk-up. */
  entry: string;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. Everything below defaults to the real thing. */
  nodeVersion?: string;
  npmGlobalRoot?: () => string | undefined;
  registry?: string;
  registryFetch?: typeof fetch;
  /** Is anything accepting connections at host:port? */
  isListening?: (host: string, port: number) => Promise<boolean>;
  /** Is what answers at `url` a Paddock, and which version? Undefined if nothing answers HTTP there. */
  identify?: (url: string) => Promise<{ paddock: boolean; version?: string } | undefined>;
  /** Load the instance's config for `dataDir`. Throws what `paddock serve` would fail with. */
  loadConfig?: (dataDir: string) => Promise<InstanceConfig>;
  /** The macOS Keychain probe `claude-home.ts` runs at boot. */
  keychain?: () => Promise<"found" | "unknown">;
  /** `~/.claude`, the machine's own Claude home. */
  userClaudeHome?: string;
}

export interface DoctorResult {
  checks: Check[];
  /** SPEC §3's update notice, for stderr. */
  notice?: string;
}

/** `/home/me/x` → `~/x`, for lines a person reads. */
function tildify(p: string, home: string): string {
  if (p === home) return "~";
  return p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p;
}

export async function diagnose(i: DoctorInput): Promise<DoctorResult> {
  const checks: Check[] = [];
  const add = (c: Check): void => void checks.push(c);
  const ctx = i.ctx;
  const env = i.env ?? process.env;
  const t = (p: string): string => tildify(p, ctx.homeDir);
  let notice: string | undefined;

  // ---- how it was installed (SPEC §6). First, because the engines check reads
  //      the package root it finds.
  const info: InstallInfo = detectInstall({
    packageName: PADDOCK_PACKAGE,
    envPrefix: "PADDOCK",
    entry: i.entry,
    env,
    npmGlobalRoot: i.npmGlobalRoot ?? (() => npmGlobalRoot({ env })),
  });

  // ---- this Node against the package's `engines`
  const nodeVersion = i.nodeVersion ?? process.versions.node;
  const engines = enginesOf(info.packageRoot) ?? `>=${MIN_NODE_MAJOR}`;
  if (satisfiesEngines(nodeVersion, { node: engines }).ok === false) {
    add({
      id: "node-engines",
      status: "fail",
      message: `Node ${nodeVersion} is too old: Paddock ${PADDOCK_VERSION} needs Node ${engines}`,
      fix: `install Node ${engines} (nvm, fnm, Homebrew, nodejs.org), then run paddock with it`,
    });
  } else {
    add({ id: "node-engines", status: "pass", message: `Node ${nodeVersion} (Paddock needs ${engines})` });
  }

  const how = describeInstall(info, PADDOCK_PACKAGE);
  if (info.canUpdate) {
    add({
      id: "install-method",
      status: "pass",
      message: `Paddock ${PADDOCK_VERSION}, ${how}: \`paddock update\` can update it`,
    });
  } else {
    const cmd = updateCommand(info, { packageName: PADDOCK_PACKAGE, image: PADDOCK_IMAGE });
    add({
      id: "install-method",
      status: "warn",
      message: `Paddock ${PADDOCK_VERSION}, ${how}: \`paddock update\` can't update it`,
      fix: `${cmd.command}${cmd.note !== undefined ? `    (${cmd.note})` : ""}`,
    });
  }

  // ---- the unit: present, its Node and CLI still there, the same install as this CLI
  let backend: ServiceManager | undefined;
  let report: StatusReport | undefined;
  try {
    backend = serviceBackend(ctx);
    report = await buildStatus(ctx, backend);
  } catch (err) {
    add({
      id: "unit",
      status: "skip",
      message: `there's no service here: ${firstLine((err as Error).message)}`,
    });
  }
  if (report !== undefined && !report.installed) {
    add({
      id: "unit",
      status: "skip",
      message: "Paddock isn't installed as a service (`paddock service install` runs it from login)",
    });
  } else if (report !== undefined) {
    const before = checks.length;
    for (const gone of missingPaths([report.node ?? undefined, report.cli ?? undefined])) {
      add({
        id: "unit",
        status: "fail",
        message: `the service runs ${t(gone)}, which isn't there any more (a Node version removed with nvm, fnm or volta, or Paddock reinstalled elsewhere)`,
        fix: "paddock service install --refresh    (re-writes the unit for this Node and this install, keeping its port, host and data dir)",
      });
    }
    if (report.warnings.some((w) => w.includes("#872"))) {
      add({
        id: "unit",
        status: "warn",
        message: "the unit predates a fix (#872): a clean stop (sleep, logout, a stray kill) leaves Paddock down until it's started by hand",
        fix: "paddock service install --refresh",
      });
    }
    if (report.cli !== null && fs.existsSync(report.cli) && !samePath(report.cli, ctx.scriptPath)) {
      add({
        id: "unit",
        status: "warn",
        message: `the service runs a different Paddock install (${t(report.cli)}) from this one (${t(ctx.scriptPath)})`,
        fix: "run `paddock service install --refresh` from the install the service should run",
      });
    }
    if (!report.running) {
      add({
        id: "unit",
        status: "warn",
        message: `the service is installed (${report.manager}) but not running`,
        fix: "paddock service start    (and `paddock service logs` if it doesn't stay up)",
      });
    } else if (!report.answering) {
      add({
        id: "unit",
        status: "warn",
        message: `the service is running, but ${report.url ?? "its URL"} isn't answering`,
        fix: "paddock service logs",
      });
    }
    if (checks.length === before) {
      add({
        id: "unit",
        status: "pass",
        message: `the service is installed (${report.manager}), running and answering at ${report.url ?? "?"}: ${t(report.unit)}`,
      });
    }
  }

  // The instance this run is about: an explicit --data-dir, else the unit's,
  // else PADDOCK_DATA_DIR, else ~/.paddock. It's where `update-check.json` goes,
  // and where `service status` reads it back from.
  const home = path.resolve(
    i.dataDir ??
      (report?.installed === true && report.dataDir !== null ? report.dataDir : undefined) ??
      ctx.envDataDir ??
      defaultDataDir(ctx.homeDir),
  );

  // ---- the running version is the installed one: the service's, or a `serve` in a terminal
  const live = readLiveRuntimeFile(home);
  const running =
    report?.answering === true
      ? { version: report.runningVersion, where: report.url ?? "the service", installed: report.installedVersion, via: "service" as const }
      : live !== null
        ? { version: live.version, where: live.url, installed: PADDOCK_VERSION, via: "serve" as const }
        : undefined;
  if (running === undefined) {
    add({ id: "running-version", status: "skip", message: "Paddock isn't running" });
  } else if (running.version !== null && running.installed !== null && running.version !== running.installed) {
    add({
      id: "running-version",
      status: "fail",
      message: `${running.where} is running ${running.version}, but ${running.installed} is installed: it's still running the code it started with`,
      fix:
        running.via === "service"
          ? "paddock service restart"
          : "stop the `paddock serve` in its terminal (Ctrl-C) and start it again",
    });
  } else {
    add({
      id: "running-version",
      status: "pass",
      message: `${running.where} is running ${running.version ?? "an unknown version"}${running.via === "serve" ? " (in a terminal)" : ""}`,
    });
  }

  // ---- the port: free, or held by Paddock
  const port = Number(
    report?.installed === true && report.port !== null
      ? report.port
      : (live?.port ?? env.PORT ?? DEFAULT_PORT),
  );
  const host = loopbackFor(report?.installed === true && report.host !== null ? report.host : "127.0.0.1");
  const listening = await (i.isListening ?? isListening)(host, port);
  if (!listening) {
    add({ id: "port", status: "pass", message: `port ${port} is free` });
  } else {
    const who = await (i.identify ?? identify)(`http://${urlHost(host)}:${port}`);
    if (who?.paddock === true) {
      add({
        id: "port",
        status: "pass",
        message: `port ${port} is Paddock's${who.version !== undefined ? ` (${who.version})` : ""}`,
      });
    } else {
      add({
        id: "port",
        status: "fail",
        // Something answered /api/health but not /api/busy: another tool, or a
        // Paddock from before the busy check, which can't be told apart.
        message:
          who !== undefined
            ? `something that isn't Paddock (or is a Paddock older than 0.81) is listening on port ${port}`
            : `something that isn't Paddock is listening on port ${port}`,
        fix:
          report?.installed === true
            ? "stop it, or move the service: `paddock service install --port <n>`"
            : "stop it, or run Paddock on another port: `paddock --port <n>`",
      });
    }
  }

  // ---- linger, on Linux: without it the service stops when you log out
  let linger: LingerState | undefined;
  try {
    linger = backend?.linger();
  } catch {
    linger = undefined;
  }
  if (linger === undefined || !linger.applies) {
    add({ id: "linger", status: "skip", message: "linger only applies to Linux" });
  } else {
    const user = linger.user ?? "$USER";
    if (linger.enabled === true) {
      add({ id: "linger", status: "pass", message: `linger is on for ${user}: the service keeps running when you log out` });
    } else if (linger.enabled === false && report?.installed === true) {
      add({
        id: "linger",
        status: "warn",
        message: `linger is off for ${user}: the service stops when you log out, and starts only when you log in`,
        fix: `sudo loginctl enable-linger ${user}    (Paddock never runs sudo itself)`,
      });
    } else if (linger.enabled === false) {
      add({
        id: "linger",
        status: "pass",
        message: `linger is off for ${user}, which only matters once Paddock runs as a service`,
      });
    } else {
      add({ id: "linger", status: "skip", message: "couldn't ask loginctl about linger" });
    }
  }

  // ---- the data home is writable
  const writable = writableOrCreatable(home);
  if (writable === true) {
    add({ id: "data-home", status: "pass", message: `the data dir ${t(home)} is writable` });
  } else if (writable === "creatable") {
    add({
      id: "data-home",
      status: "pass",
      message: `the data dir ${t(home)} doesn't exist yet; Paddock makes it the first time it runs`,
    });
  } else {
    add({
      id: "data-home",
      status: "fail",
      message: `the data dir ${t(home)} isn't writable: ${writable}`,
      fix: `check the permissions of ${t(home)}: it holds your projects, chats and settings`,
    });
  }

  // ---- Paddock's own: the config loads, and what it resolves to
  let cfg: InstanceConfig | undefined;
  try {
    cfg = await (i.loadConfig ?? loadInstanceConfig)(home);
    add({ id: "config", status: "pass", message: "the config loads" });
  } catch (err) {
    add({
      id: "config",
      status: "fail",
      message: `the config doesn't load, so \`paddock serve\` would fail too: ${firstLine((err as Error).message)}`,
      fix: "fix what it names (`paddock config show` prints the same error)",
    });
  }

  if (cfg === undefined) {
    add({ id: "projects", status: "skip", message: "the config didn't load, so the projects folder is unknown" });
  } else {
    const projects = writableOrCreatable(cfg.projectsRoot);
    if (projects === true) {
      add({ id: "projects", status: "pass", message: `the projects folder ${t(cfg.projectsRoot)} is writable` });
    } else if (projects === "creatable") {
      add({
        id: "projects",
        status: "pass",
        message: `the projects folder ${t(cfg.projectsRoot)} doesn't exist yet; Paddock makes it the first time it runs`,
      });
    } else {
      add({
        id: "projects",
        status: "fail",
        message: `the projects folder ${t(cfg.projectsRoot)} isn't writable: ${projects}`,
        fix: "fix its permissions, or point PADDOCK_PROJECTS_DIR (or `projectsRoot:` in paddock.config.yaml) somewhere writable",
      });
    }
  }

  // ---- a Claude login it can use. Which KIND, never the value.
  if (cfg !== undefined) add(await loginCheck(cfg, env, i, t, report?.installed === true));
  else add({ id: "claude-login", status: "skip", message: "the config didn't load, so Paddock's Claude home is unknown" });

  // ---- a `claude` on PATH: the sweeper always shells out to it, and on
  //      driveMode: batch so do chats and triggers.
  const claude = which("claude", env.PATH ?? "");
  if (claude !== undefined) {
    add({ id: "claude-cli", status: "pass", message: `claude is on PATH (${t(claude)})` });
  } else {
    const batch = cfg?.driveMode === "batch";
    add({
      id: "claude-cli",
      status: batch ? "fail" : "warn",
      message: batch
        ? "there's no `claude` on PATH, and driveMode is batch: every chat turn and trigger runs it, so they'll all fail"
        : "there's no `claude` on PATH: chats work (they use the SDK's own), but the sweeper that keeps OVERVIEW.md and CHANGELOG.md current runs `claude` and will fail",
      fix: "npm install -g @anthropic-ai/claude-code    (then re-run `paddock service install --refresh` if it's a service, so the unit's PATH has it)",
    });
  }

  // ---- a newer version (SPEC §1). The only check that asks the network, and --offline skips it.
  if (i.offline === true) {
    add({ id: "update", status: "skip", message: "not asking the registry for a newer version (--offline)" });
  } else {
    try {
      const target = await resolveTarget({
        packageName: PADDOCK_PACKAGE,
        registry: i.registry ?? resolveRegistry(env, (k) => npmConfigGet(k, { env })),
        ...(i.registryFetch !== undefined ? { fetch: i.registryFetch } : {}),
      });
      const cmp = compareVersions(target.version, PADDOCK_VERSION);
      const available = cmp > 0 && !isPrerelease(target.version);
      const cmd = info.canUpdate
        ? { command: "paddock update" }
        : updateCommand(info, { packageName: PADDOCK_PACKAGE, target: target.version, image: PADDOCK_IMAGE });
      // Only into a data dir that's there. Making it here would make the instance:
      // `serve` prints its first-run welcome only when the data dir is new, and
      // `config show` stays out of it for the same reason.
      if (fs.existsSync(home)) writeUpdateCheck(home, {
        name: PADDOCK_PACKAGE,
        current: PADDOCK_VERSION,
        target: target.version,
        tag: target.tag,
        updateAvailable: available,
        installMethod: info.method,
        canUpdate: info.canUpdate,
        command: available ? cmd.command : null,
        engines: target.engines,
        nodeOk: satisfiesEngines(nodeVersion, target.engines !== null ? { node: target.engines } : undefined).ok !== false,
        changelog: paddockChangelogUrl(target.version),
        checkedAt: new Date().toISOString(),
      });
      if (available) {
        notice = updateNotice({
          name: PADDOCK_NAME,
          current: PADDOCK_VERSION,
          target: target.version,
          command: cmd.command,
          ...("note" in cmd && cmd.note !== undefined ? { note: cmd.note } : {}),
          changelog: paddockChangelogUrl(target.version),
        });
        add({
          id: "update",
          status: "warn",
          message: `Paddock ${target.version} is available (you have ${PADDOCK_VERSION})`,
          fix: cmd.command,
        });
      } else {
        add({
          id: "update",
          status: "pass",
          message:
            cmp < 0
              ? `${PADDOCK_VERSION} is newer than the registry's latest (${target.version})`
              : `${PADDOCK_VERSION} is the latest`,
        });
      }
    } catch (err) {
      add({
        id: "update",
        status: "warn",
        message: `couldn't ask the registry for a newer version: ${
          err instanceof RegistryError ? `${err.message} (${err.url})` : firstLine((err as Error).message)
        }`,
        fix: "check the network (or npm_config_registry), or skip this check with --offline",
      });
    }
  }

  return { checks, ...(notice !== undefined ? { notice } : {}) };
}

/** The `claude-login` check: what kind of login Paddock would find, never its value. */
async function loginCheck(
  cfg: InstanceConfig,
  env: NodeJS.ProcessEnv,
  i: DoctorInput,
  t: (p: string) => string,
  service: boolean,
): Promise<Check> {
  const tokenVar = TOKEN_ENV_VARS.find((v) => (env[v] ?? "").trim() !== "");
  if (tokenVar !== undefined) {
    return {
      id: "claude-login",
      status: "pass",
      message:
        `${tokenVar} is set in this shell` +
        (service ? " (the service doesn't inherit this shell's environment, so it needs a login of its own)" : ""),
    };
  }
  if (fs.existsSync(path.join(cfg.claudeHome, ".credentials.json"))) {
    return { id: "claude-login", status: "pass", message: `a Claude login is in Paddock's Claude home (${t(cfg.claudeHome)})` };
  }
  const userHome = i.userClaudeHome ?? path.join(os.homedir(), ".claude");
  if (cfg.credentials === "host") {
    if (fs.existsSync(path.join(userHome, ".credentials.json"))) {
      return {
        id: "claude-login",
        status: "pass",
        message: `Paddock shares this machine's Claude Code login (${t(userHome)}, claude.credentials: host)`,
      };
    }
    if (i.ctx.platform === "darwin") {
      const keychain = await (i.keychain ?? probeKeychain)();
      if (keychain === "found") {
        return {
          id: "claude-login",
          status: "pass",
          message: "Paddock shares this machine's Claude Code login, from the macOS Keychain (claude.credentials: host)",
        };
      }
    }
  }
  return {
    id: "claude-login",
    status: "warn",
    message:
      `no Claude login found for Paddock: none in its Claude home (${t(cfg.claudeHome)}), no ${TOKEN_ENV_VARS.join("/")} in the environment` +
      (cfg.credentials === "host" ? ", and none on this machine to share" : ", and claude.credentials: own shares none of this machine's") +
      ". Chats will fail with \"Not logged in\"",
    fix: `CLAUDE_CONFIG_DIR=${t(cfg.claudeHome)} claude login    (or \`claude setup-token\` and put the token in CLAUDE_CODE_OAUTH_TOKEN)`,
  };
}

/** The checklist, for a person. */
export function renderChecks(checks: readonly Check[]): string {
  return (
    checks
      .map(
        (c) =>
          `${MARK[c.status]} ${c.message}` +
          (c.fix !== undefined && (c.status === "fail" || c.status === "warn") ? `\n    fix: ${c.fix}` : ""),
      )
      .join("\n") + "\n"
  );
}

/** 1 if any check failed (SPEC §1); warnings don't change it. */
export function doctorExit(checks: readonly Check[]): number {
  return checks.some((c) => c.status === "fail") ? EXIT.FAILED : EXIT.OK;
}

/** `paddock doctor`: run the checks, print them, and hand back the exit code. */
export async function runDoctor(opts: CliOptions, ctx: ServiceContext): Promise<number> {
  const { checks, notice } = await diagnose({
    ctx,
    ...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
    ...(opts.offline === true ? { offline: true } : {}),
    entry: process.argv[1] ?? ctx.scriptPath,
  });
  const code = doctorExit(checks);
  if (opts.json === true) {
    process.stdout.write(
      `${JSON.stringify({ ok: code === EXIT.OK, version: PADDOCK_VERSION, checks }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(renderChecks(checks));
  }
  // The update notice goes to stderr (SPEC §3), with or without --json.
  if (notice !== undefined) process.stderr.write(`\n${notice}\n`);
  return code;
}

// ---- the real implementations of the injected seams

/** The package's `engines.node`, read from the package root §6's walk-up found. */
function enginesOf(packageRoot: string | undefined): string | undefined {
  if (packageRoot === undefined) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      engines?: { node?: unknown };
    };
    return typeof raw.engines?.node === "string" ? raw.engines.node : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load the instance's config the way `paddock serve` would, without creating
 * anything. `loadPaddockConfig` reads `PADDOCK_DATA_DIR`, so it's set for the
 * call and put back.
 */
async function loadInstanceConfig(dataDir: string): Promise<InstanceConfig> {
  const before = process.env.PADDOCK_DATA_DIR;
  process.env.PADDOCK_DATA_DIR = dataDir;
  try {
    const { loadPaddockConfig } = await import("../config.js");
    const cfg = loadPaddockConfig({ createDataDir: false });
    return {
      projectsRoot: cfg.projectsRoot,
      claudeHome: cfg.claudeHome,
      credentials: cfg.claude.credentials,
      driveMode: cfg.driveMode,
    };
  } finally {
    if (before === undefined) delete process.env.PADDOCK_DATA_DIR;
    else process.env.PADDOCK_DATA_DIR = before;
  }
}

async function probeKeychain(): Promise<"found" | "unknown"> {
  const { probeMacosKeychainLogin } = await import("../claude-home.js");
  return probeMacosKeychainLogin();
}

/** True if `dir` is writable; "creatable" if it doesn't exist but its nearest existing parent is; else why not. */
export function writableOrCreatable(dir: string): true | "creatable" | string {
  let probe = dir;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return "no part of it exists";
    probe = parent;
  }
  try {
    if (!fs.statSync(probe).isDirectory()) return `${probe} isn't a folder`;
    fs.accessSync(probe, fs.constants.W_OK);
    return probe === dir ? true : "creatable";
  } catch (err) {
    return (err as Error).message;
  }
}

function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/** A wildcard bind is reached on loopback. */
function loopbackFor(host: string): string {
  if (host === "0.0.0.0" || host === "") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "::1";
  return host;
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? s;
}

function isListening(host: string, port: number): Promise<boolean> {
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
 * Is this a Paddock? `/api/health`'s `{ ok, version }` is the contract's, so
 * every tool answers it; `/api/busy`'s `counts.chat` is Paddock's own.
 */
async function identify(url: string): Promise<{ paddock: boolean; version?: string } | undefined> {
  const health = await fetchHealth(url);
  if (health === undefined) return undefined;
  try {
    const res = await fetch(`${url}/api/busy`, { signal: AbortSignal.timeout(2_000) });
    const body = (await res.json()) as { counts?: Record<string, unknown> };
    const paddock = health.ok && typeof body.counts?.chat === "number" && "background" in (body.counts ?? {});
    return { paddock, ...(health.version !== undefined ? { version: health.version } : {}) };
  } catch {
    return { paddock: false, ...(health.version !== undefined ? { version: health.version } : {}) };
  }
}
