/**
 * `<tool> update` — the whole of CLI contract SPEC §5, once, for every tool.
 *
 * ## Why this file is generic
 *
 * Six tools have to do this identically, and the sequence is the part where
 * being almost right is worst: an update that stops the service and then fails
 * to install has to put the old one back, and a tool that gets that wrong
 * leaves a machine with nothing running and no explanation. So §5 lives here
 * once, as a state machine over injected hooks, and each product supplies the
 * four things that are genuinely its own — how to ask whether it is busy, how
 * to stop and refresh its service, how to ask its health endpoint, and what to
 * call itself. Wave C4 lifts this into `reference/update.ts`.
 *
 * ## The order, and why each step is where it is
 *
 * 1. the lock, so two updates cannot interleave;
 * 2. the install method, so an update that cannot work says so before it tries;
 * 3. the registry, for the target and its `engines`;
 * 4. the comparison — and `--check` stops here;
 * 5. the writability check, which turns "npm EACCES, half-installed" into a
 *    `sudo` line printed while everything is still running;
 * 6. the busy check, **before anything is stopped**;
 * 7. the question, which `--yes` answers and no TTY forbids;
 * 8. `npm cache add` for BOTH versions, so a network failure happens while the
 *    old version still serves and the rollback has its package to hand;
 * 9. stop — before installing, because npm moves the old package aside before
 *    unpacking and a running server then lazily loads files that are gone;
 * 10. install with the manager this install came from;
 * 11. hand over to the NEW CLI (`service install --refresh`), which re-renders
 *     the unit in its own format;
 * 12. poll health until the TARGET version answers, not merely until something
 *     answers;
 * 13. and on any failure from step 10 on, roll back and report 6 or 7.
 *
 * Node built-ins only. Nothing here imports the server.
 */
import path from "node:path";
import fsDefault from "node:fs";
import { createInterface } from "node:readline";
import { EXIT } from "../exit-codes.js";
import type { Output } from "../output.js";
import {
  detectInstall,
  describeInstall,
  updateCommand,
  type InstallInfo,
  type PackageManager,
} from "./install-method.js";
import { acquireLock, LockHeldError, type Lock } from "./lock.js";
import {
  RegistryError,
  resolveRegistry,
  resolveTarget,
  type ResolvedTarget,
} from "./registry.js";
import {
  cacheAdd,
  cliVersion,
  globalRootFor,
  installArgs,
  installPackage,
  isWritable,
  npmConfigGet,
  npmGlobalRoot,
  type RunResult,
  type Spawn,
} from "./package-manager.js";
import { compareVersions, isPrerelease, satisfiesEngines } from "./semver.js";
import {
  updateNotice,
  writeUpdateCheck,
  type UpdateCheck,
} from "./update-check.js";

/** SPEC §5 step 12: 30 seconds unless the tool sets its own. */
export const HEALTH_TIMEOUT_MS = 30_000;

/** How many log lines a failure prints (SPEC §5 step 13). */
export const LOG_LINES_ON_FAILURE = 20;

/** What `update` was asked to do. */
export interface UpdateOptions {
  /** Report and change nothing (SPEC §1). */
  check?: boolean;
  /** A version or a dist-tag. The only way to move to a lower version. */
  to?: string;
  /** Skip the question. Required without a TTY. */
  yes?: boolean;
  /** Skip the busy check, and nothing else. */
  force?: boolean;
  json?: boolean;
}

/** What the service looks like from `update`'s point of view. */
export interface ServiceSnapshot {
  installed: boolean;
  running: boolean;
  /** The URL the installed unit serves, when there is one. */
  url?: string;
  /** The log file the unit names, for the failure tail. */
  log?: string;
}

export interface UpdateServiceHooks {
  /** Is a unit installed, is it running, and where. */
  inspect(): ServiceSnapshot;
  /** Stop the service. Throws with the supervisor's own words on failure. */
  stop(): void;
  /**
   * `<cli> service install --refresh`, run through the NEW CLI (SPEC §5 step
   * 11). Returns the subprocess result so the caller can show what it said.
   */
  refresh(cliPath: string): RunResult;
  /** The last `lines` lines of the service log, or '' when there is no log. */
  tail(lines: number): string;
}

/** "Did the target answer?" — the three outcomes that matter (SPEC §5 step 12). */
export type HealthVerdict =
  | { state: "ok"; version: string }
  /** Something answers, but it is not the version we installed. */
  | { state: "wrong-version"; version: string }
  | { state: "no-answer" };

export interface UpdateProduct {
  /** `Paddock`. */
  name: string;
  /** `paddock` — the bin, for `<tool>: <message>` and printed commands. */
  tool: string;
  /** `@edspencer/paddock`. */
  packageName: string;
  /** `PADDOCK` — gives `PADDOCK_IN_DOCKER` and `PADDOCK_UPDATE_HINT`. */
  envPrefix: string;
  /** The data home: `<home>/update.lock` and `<home>/update-check.json`. */
  home: string;
  /** This CLI's own version, from its `package.json`. */
  currentVersion: string;
  /**
   * `process.argv[1]` — NOT realpath'd.
   *
   * Both forms are needed and for different reasons. The unresolved path is a
   * bin shim, and re-resolving it AFTER the install is what finds the new CLI
   * under a package manager whose realpath carries the version in it (pnpm).
   * The realpath is what SPEC §6's table walks up from.
   */
  entry: string;
  /** Where the CLI sits inside the package: `packages/server/dist/cli/paddock.js`. */
  binSubpath: string;
  /** The container image, for the Docker notice: `ghcr.io/edspencer/paddock`. */
  image?: string;
  /**
   * The synopsis printed after `update`'s own usage error (SPEC §2: the usage
   * follows the message).
   *
   * `update` has exactly one — "there is no terminal to ask, so `--yes` is
   * required" — and it is the command's own usage rather than the tool's,
   * because the reader's problem is one flag on the command they just typed.
   */
  usage?: string;
  /** The release notes for a version. */
  changelogUrl(version: string): string;
  healthTimeoutMs?: number;

  /** The busy check (SPEC §5 step 6): null to go ahead, or 75 having printed why. */
  guardBusy(o: { force: boolean; home: string }): Promise<number | null>;
  service: UpdateServiceHooks;
  /** Poll `<url>/api/health` until it reports `version`, or the budget runs out. */
  waitForVersion(o: { url: string; version: string; timeoutMs: number }): Promise<HealthVerdict>;
}

/** Everything that touches the world, injected so the sequence is testable. */
export interface UpdateEnvironment {
  out: Output;
  env?: NodeJS.ProcessEnv;
  spawn?: Spawn;
  execPath?: string;
  platform?: NodeJS.Platform;
  fetch?: typeof globalThis.fetch;
  fs?: Pick<typeof fsDefault, "existsSync" | "readFileSync" | "realpathSync">;
  /** Is there a person at a keyboard? (SPEC §3.) */
  isTTY?: boolean;
  /**
   * The Node to test the target's `engines.node` against.
   *
   * Injected so the "the target needs a newer Node" path can be proven, which
   * it otherwise cannot be: a test runs on whatever Node CI has, and the only
   * Nodes that fail a real `engines` range are ones the suite cannot run on.
   */
  nodeVersion?: string;
  /** Ask the question. Only called when {@link isTTY} and `--yes` was not given. */
  confirm?: (question: string) => Promise<boolean>;
  /** Injected for tests: `isWritable`. */
  writable?: (dir: string) => boolean;
}

/** One JSON document, built up as the sequence proceeds and emitted exactly once. */
interface UpdateDoc extends Partial<UpdateCheck> {
  outcome:
    | "up-to-date"
    | "ahead"
    | "available"
    | "updated"
    | "cannot-self-update"
    | "not-writable"
    | "busy"
    | "declined"
    | "needs-yes"
    | "node-too-old"
    | "rolled-back"
    | "needs-human"
    | "restart-required"
    | "failed";
  message?: string;
  url?: string;
}

/**
 * Run `update`, and return the exit code (SPEC §2: the caller assigns
 * `process.exitCode`; nothing here calls `process.exit`).
 */
export async function runUpdate(
  product: UpdateProduct,
  opts: UpdateOptions,
  envp: UpdateEnvironment,
): Promise<number> {
  const out = envp.out;
  const env = envp.env ?? process.env;
  const fs = envp.fs ?? fsDefault;
  let emitted = false;
  /** `out.result` promises exactly one document, so guard it here rather than at ten call sites. */
  const emit = (doc: UpdateDoc): void => {
    if (emitted) return;
    emitted = true;
    out.result(doc);
  };

  // ---- 1. the lock -------------------------------------------------------
  let lock: Lock;
  try {
    lock = acquireLock({
      home: product.home,
      command: `${product.tool} update${opts.to !== undefined ? ` --to ${opts.to}` : ""}`,
    });
  } catch (err) {
    if (err instanceof LockHeldError) {
      emit({ outcome: "failed", message: err.message });
      return out.error(err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    emit({ outcome: "failed", message });
    return out.error(`could not take the update lock: ${message}`);
  }

  try {
    return await sequence();
  } finally {
    lock.release();
  }

  async function sequence(): Promise<number> {
    const spawnCtx = {
      ...(envp.spawn !== undefined ? { spawn: envp.spawn } : {}),
      ...(envp.execPath !== undefined ? { execPath: envp.execPath } : {}),
      ...(envp.platform !== undefined ? { platform: envp.platform } : {}),
      env,
    };

    // ---- 2. how was it installed? (SPEC §6) ------------------------------
    //
    // Detected now, reported now, but NOT acted on yet: the notice an install
    // that cannot update itself needs (`docker compose pull … (image …:0.81.0)`)
    // names the target version, so the exit-5 refusal waits until step 4 has
    // one. An install that is already up to date exits 0 instead, which is the
    // right answer in a container too.
    const info = detectInstall({
      packageName: product.packageName,
      envPrefix: product.envPrefix,
      entry: product.entry,
      env,
      npmGlobalRoot: () => npmGlobalRoot(spawnCtx),
      fs,
    });

    // ---- 3. the registry -------------------------------------------------
    const registry = resolveRegistry(env, (key) => npmConfigGet(key, spawnCtx));
    let target: ResolvedTarget;
    try {
      target = await resolveTarget({
        packageName: product.packageName,
        registry,
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        ...(envp.fetch !== undefined ? { fetch: envp.fetch } : {}),
      });
    } catch (err) {
      const message =
        err instanceof RegistryError ? `${err.message}\n         ${err.url}` : String(err);
      emit({ outcome: "failed", message });
      return out.error(message);
    }

    // ---- 4. compare ------------------------------------------------------
    const cmp = compareVersions(target.version, product.currentVersion);
    const nodeVersion = envp.nodeVersion ?? process.versions.node;
    const engines = satisfiesEngines(nodeVersion, {
      ...(target.engines !== null ? { node: target.engines } : {}),
    });
    const command = commandFor(product, info, target.version);
    const check: UpdateCheck = {
      name: product.packageName,
      current: product.currentVersion,
      target: target.version,
      tag: target.tag,
      updateAvailable: cmp > 0,
      installMethod: info.method,
      canUpdate: info.canUpdate,
      command: info.canUpdate ? `${product.tool} update` : command.command,
      engines: target.engines,
      // `undefined` from the parser means "this range could not be read", and
      // SPEC's field is a boolean — report the permissive answer, which is also
      // the one the code acts on. The range itself is in `engines` either way.
      nodeOk: engines.ok !== false,
      changelog: product.changelogUrl(target.version),
      checkedAt: new Date().toISOString(),
    };

    // Written whatever the outcome below, because the cache's whole job is to
    // let `service status` repeat the last answer (SPEC §3) — including "you
    // are up to date", which is the answer that stops it nagging.
    writeUpdateCheck(product.home, check);

    // A prerelease only counts when `--to` names it (SPEC §5 step 4). `latest`
    // pointing at one is a mis-tagged release, and silently installing it would
    // be worse than saying nothing happened.
    if (opts.to === undefined && isPrerelease(target.version)) {
      const message =
        `the registry's \`latest\` is a prerelease (${target.version}); not installing it.\n` +
        `         To go there deliberately: ${product.tool} update --to ${target.version}`;
      emit({ ...check, outcome: "ahead", message });
      out.say(message);
      return EXIT.ok;
    }

    if (cmp === 0) {
      const message = `${product.name} ${product.currentVersion} is up to date.`;
      emit({ ...check, outcome: "up-to-date", message });
      out.say(message);
      return EXIT.ok;
    }

    // A lower version needs `--to` (SPEC §5 step 4). Without it this is the
    // ordinary "you are on a prerelease or a hand-built version" case, and
    // there is nothing to do.
    if (cmp < 0 && opts.to === undefined) {
      const message =
        `${product.name} ${product.currentVersion} is newer than the registry's ` +
        `${target.tag ?? "latest"} (${target.version}). Nothing to do.\n` +
        `         To go back deliberately: ${product.tool} update --to ${target.version}`;
      emit({ ...check, outcome: "ahead", message });
      out.say(message);
      return EXIT.ok;
    }

    const direction = cmp < 0 ? "Downgrade" : "Update";
    const arrow = `${product.currentVersion} → ${target.version}`;

    if (opts.check === true) {
      // Report, change nothing, exit 0 whether or not there is an update
      // (SPEC §2). Scripts read `updateAvailable` from `--json`.
      emit({ ...check, outcome: "available" });
      out.say(
        updateNotice({
          name: product.name,
          current: product.currentVersion,
          target: target.version,
          command: check.command ?? `${product.tool} update`,
          ...(command.note !== undefined && !info.canUpdate ? { note: command.note } : {}),
          changelog: check.changelog,
        }),
      );
      if (engines.ok === false) {
        out.warn(
          `  Note: ${target.version} needs Node ${target.engines ?? "?"}; this is Node ${nodeVersion}.`,
        );
      }
      return EXIT.ok;
    }

    // Now that there IS a target, an install that cannot replace itself prints
    // the right command and exits 5 (SPEC §5 step 2, §6).
    if (!info.canUpdate) {
      out.say(
        updateNotice({
          name: product.name,
          current: product.currentVersion,
          target: target.version,
          command: command.command,
          ...(command.note !== undefined ? { note: command.note } : {}),
          changelog: check.changelog,
        }),
      );
      const message = `this install cannot update itself — it is ${describeInstall(info, product.packageName)}.`;
      emit({ ...check, outcome: "cannot-self-update", message });
      return out.error(message, EXIT.cannotSelfUpdate);
    }
    const manager: PackageManager = info.manager ?? "npm";

    if (engines.ok === false) {
      const message =
        `${target.version} needs Node ${target.engines ?? "?"}, and this is Node ${nodeVersion}.\n` +
        `         Upgrade Node first, then re-run \`${product.tool} update\`.`;
      emit({ ...check, outcome: "node-too-old", message });
      return out.error(message);
    }

    // ---- 5. can we write there? (SPEC §5 step 5) -------------------------
    const globalRoot = globalRootFor(manager, spawnCtx);
    const writable = envp.writable ?? isWritable;
    if (globalRoot !== undefined && !writable(globalRoot)) {
      const sudo = updateCommand(info, {
        packageName: product.packageName,
        target: target.version,
        sudo: true,
      });
      out.say(
        updateNotice({
          name: product.name,
          current: product.currentVersion,
          target: target.version,
          command: sudo.command,
          note: sudo.note ?? "the global folder isn't writable",
          changelog: check.changelog,
        }),
      );
      const message = `${globalRoot} is not writable by this user, so the install would fail half-way.`;
      emit({ ...check, outcome: "not-writable", message, command: sudo.command });
      // Never run sudo ourselves (SPEC §5 step 5).
      return out.error(message, EXIT.cannotSelfUpdate);
    }

    // ---- 6. busy? (SPEC §5 step 6) --------------------------------------
    //
    // Before ANYTHING is stopped, and before the question is asked: being told
    // "it is busy" after answering yes to "the service will restart" is the
    // wrong order to learn it in.
    const refused = await product.guardBusy({ force: opts.force === true, home: product.home });
    if (refused !== null) {
      emit({ ...check, outcome: "busy" });
      return refused;
    }

    const service = product.service.inspect();

    // ---- 7. ask (SPEC §5 step 7) ----------------------------------------
    const question =
      `${direction} ${product.name} ${arrow}?` +
      (service.installed ? " The service will restart." : "");
    if (opts.yes !== true) {
      const tty = envp.isTTY ?? (process.stdin.isTTY === true && process.stderr.isTTY === true);
      if (!tty) {
        const message =
          "there is no terminal to ask, so `--yes` is required.\n" +
          `         ${product.tool} update --yes`;
        emit({ ...check, outcome: "needs-yes", message });
        // Exit 2, as SPEC §3 requires of a command that would have asked, with
        // the usage after the message, as SPEC §2 requires of exit 2.
        const code = out.error(message, EXIT.usage);
        if (product.usage !== undefined) out.warn(`\n${product.usage}`);
        return code;
      }
      out.say(`${question}\n  Changes: ${check.changelog ?? ""}`);
      const ok = await (envp.confirm ?? askOnTty)(`  Continue? [y/N] `);
      if (!ok) {
        const message = "nothing was changed.";
        emit({ ...check, outcome: "declined", message });
        out.say(message);
        return EXIT.ok;
      }
    }

    // ---- 8. fetch first (SPEC §5 step 8) --------------------------------
    //
    // Both versions, and the CURRENT one matters most: it is what the rollback
    // reinstalls, and a rollback that has to reach the network to find the
    // version that was working ten seconds ago is the rollback that fails.
    out.warn(`  Fetching ${product.packageName}@${target.version}…`);
    const fetched = cacheAdd(product.packageName, target.version, spawnCtx);
    if (fetched.status !== 0) {
      const message =
        `could not fetch ${product.packageName}@${target.version}:\n` +
        indent(fetched.stderr.trim() || fetched.stdout.trim());
      emit({ ...check, outcome: "failed", message });
      // Nothing has been stopped or changed, so this is a plain failure.
      return out.error(message);
    }
    const cachedCurrent = cacheAdd(product.packageName, product.currentVersion, spawnCtx);
    if (cachedCurrent.status !== 0) {
      out.warn(
        `  Note: ${product.packageName}@${product.currentVersion} is not in the npm cache, so a ` +
          "rollback would need the network.",
      );
    }

    // ---- 9. stop (SPEC §5 step 9) ---------------------------------------
    if (service.installed) {
      out.warn(`  Stopping the ${product.name} service…`);
      try {
        product.service.stop();
      } catch (err) {
        const message = `could not stop the service: ${err instanceof Error ? err.message : String(err)}`;
        emit({ ...check, outcome: "failed", message });
        return out.error(message);
      }
    } else if (service.running && service.url !== undefined) {
      // A foreground `serve`. We cannot stop somebody's terminal for them, and
      // installing under a running server is the failure mode step 9 exists to
      // avoid — so say so and stop (SPEC §5 step 9).
      const verdict = await product.waitForVersion({
        url: service.url,
        version: product.currentVersion,
        timeoutMs: 2_000,
      });
      if (verdict.state !== "no-answer") {
        const message =
          `something is serving ${product.name} at ${service.url} and there is no service to stop.\n` +
          "         Stop it (Ctrl-C in its terminal), then run this again.";
        emit({ ...check, outcome: "failed", message });
        return out.error(message, EXIT.notRunning);
      }
    }

    // ---- 10. install (SPEC §5 step 10) ----------------------------------
    out.warn(`  Installing ${product.packageName}@${target.version} with ${manager}…`);
    const installed = installPackage({
      manager,
      packageName: product.packageName,
      version: target.version,
      ...spawnCtx,
    });
    if (installed.status !== 0) {
      // npm has already put the old package back. Start the old one again and
      // report 6 (SPEC §5 step 10).
      out.warn(indent(installed.stderr.trim() || installed.stdout.trim()));
      return await rollback({
        why: `installing ${target.version} failed`,
        check,
        emit,
        product,
        envp,
        spawnCtx,
        manager,
        service,
        alreadyRestored: true,
      });
    }

    // Prove the install took, by asking the CLI on disk what it is. See
    // `cliVersion` for why this is not read out of a manifest.
    const newCli = findCli(product, info, target.version, { ...spawnCtx, fs });
    if (newCli === undefined) {
      return await rollback({
        why: `${target.version} was installed, but no CLI on disk reports that version`,
        check,
        emit,
        product,
        envp,
        spawnCtx,
        manager,
        service,
      });
    }

    // ---- Without a service: steps 1–8 and 10 only (SPEC §5) -------------
    if (!service.installed) {
      noteInstalled(product.home, check);
      const message =
        `Updated ${product.name} ${arrow}.` +
        (service.running ? `\n  Restart ${product.name} to use ${target.version}.` : "");
      emit({ ...check, outcome: service.running ? "restart-required" : "updated", message });
      out.say(message);
      return EXIT.ok;
    }

    // ---- 11. hand over to the new version (SPEC §5 step 11) -------------
    out.warn("  Refreshing the service unit with the new version…");
    const refreshed = product.service.refresh(newCli);
    if (refreshed.status !== 0) {
      out.warn(indent(refreshed.stderr.trim() || refreshed.stdout.trim()));
      return await rollback({
        why: `${target.version} could not refresh the service unit`,
        check,
        emit,
        product,
        envp,
        spawnCtx,
        manager,
        service,
      });
    }

    // ---- 12. health (SPEC §5 step 12) -----------------------------------
    const url = product.service.inspect().url ?? service.url;
    if (url === undefined) {
      // Nothing to poll. `refresh` waited for health itself, so treat its
      // success as the answer rather than inventing a URL to ask.
      noteInstalled(product.home, check);
      const message = `Updated ${product.name} ${arrow}.`;
      emit({ ...check, outcome: "updated", message });
      out.say(message);
      return EXIT.ok;
    }
    out.warn(`  Waiting for ${target.version} to answer at ${url}…`);
    const verdict = await product.waitForVersion({
      url,
      version: target.version,
      timeoutMs: product.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
    });
    if (verdict.state !== "ok") {
      const detail =
        verdict.state === "wrong-version"
          ? `${url} answers with ${verdict.version}, not ${target.version}`
          : `${url} did not answer within ${(product.healthTimeoutMs ?? HEALTH_TIMEOUT_MS) / 1000} seconds`;
      return await rollback({
        why: detail,
        check,
        emit,
        product,
        envp,
        spawnCtx,
        manager,
        service,
        showLog: true,
      });
    }

    // ---- 15. done --------------------------------------------------------
    noteInstalled(product.home, check);
    const message = `Updated ${product.name} ${arrow}. Running at ${url}`;
    emit({ ...check, outcome: "updated", message, url });
    out.say(message);
    return EXIT.ok;
  }
}

/**
 * Rewrite the cache now that the target IS the installed version (SPEC §3).
 *
 * Step 4 wrote a cache saying an update was available, which was true then and
 * is a lie the moment the install succeeds. `service status` reads that file
 * and would go on advertising a version the machine is already running — the
 * one piece of nagging nobody could act on, because the action had already been
 * taken.
 */
function noteInstalled(home: string, check: UpdateCheck): void {
  writeUpdateCheck(home, {
    ...check,
    current: check.target,
    updateAvailable: false,
    command: null,
    checkedAt: new Date().toISOString(),
  });
}

/** Ask on the terminal. Reads stdin; writes the prompt to stderr, per SPEC §3. */
async function askOnTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

interface RollbackInput {
  why: string;
  check: UpdateCheck;
  emit: (doc: UpdateDoc) => void;
  product: UpdateProduct;
  envp: UpdateEnvironment;
  spawnCtx: { spawn?: Spawn; execPath?: string; platform?: NodeJS.Platform; env: NodeJS.ProcessEnv };
  manager: PackageManager;
  service: ServiceSnapshot;
  /** npm already restored the old package (a failed install), so skip reinstalling it. */
  alreadyRestored?: boolean;
  /** Print the service log's tail first (SPEC §5 step 13). */
  showLog?: boolean;
}

/**
 * SPEC §5 step 13: put the old version back and say which of 6 or 7 happened.
 *
 * The distinction is the whole value of the code. **6** means a human has
 * nothing to do: the old version is installed and answering, and the only cost
 * was a minute of downtime. **7** means the machine is not serving and no
 * further automation will fix it, so the output has to be the commands to run
 * by hand. Collapsing the two into "the update failed" is what makes an
 * operator read logs to find out whether their service is up.
 */
async function rollback(o: RollbackInput): Promise<number> {
  const { product, envp, check } = o;
  const out = envp.out;
  const arrow = `${product.currentVersion} → ${check.target}`;

  out.error(`${o.why}.`);
  if (o.showLog === true) {
    const tail = product.service.tail(LOG_LINES_ON_FAILURE);
    if (tail.trim() !== "") {
      out.warn(`\n  The last ${LOG_LINES_ON_FAILURE} lines of ${product.service.inspect().log ?? "the log"}:`);
      out.warn(indent(tail));
    }
  }
  out.warn(`\n  Rolling back to ${product.currentVersion}…`);

  const back = installArgs(o.manager, `${product.packageName}@${product.currentVersion}`);
  const manual = [
    `  ${back.cmd} ${back.args.join(" ")}`,
    `  ${product.tool} service install --refresh`,
    `  ${product.tool} service status`,
  ].join("\n");

  if (o.alreadyRestored !== true) {
    const reinstalled = installPackage({
      manager: o.manager,
      packageName: product.packageName,
      version: product.currentVersion,
      ...o.spawnCtx,
    });
    if (reinstalled.status !== 0) {
      out.warn(indent(reinstalled.stderr.trim() || reinstalled.stdout.trim()));
      const message =
        `${check.target} did not start, and ${product.currentVersion} could not be reinstalled.\n` +
        `         Run these by hand:\n${manual}`;
      o.emit({ ...check, outcome: "needs-human", message });
      return out.error(message, EXIT.needsHuman);
    }
  }

  // The unit has to be refreshed by the OLD CLI: step 11's hand-over wrote a
  // unit in the NEW version's format, which the old one may not understand.
  if (o.service.installed) {
    const oldCli = findCli(product, undefined, product.currentVersion, {
      ...o.spawnCtx,
      ...(envp.fs !== undefined ? { fs: envp.fs } : {}),
    });
    if (oldCli === undefined) {
      const message =
        `${check.target} did not start, and ${product.currentVersion}'s CLI could not be found ` +
        `to restore the service unit.\n         Run these by hand:\n${manual}`;
      o.emit({ ...check, outcome: "needs-human", message });
      return out.error(message, EXIT.needsHuman);
    }
    const restored = product.service.refresh(oldCli);
    if (restored.status !== 0) {
      out.warn(indent(restored.stderr.trim() || restored.stdout.trim()));
      const message =
        `${check.target} did not start, and the service could not be restarted on ` +
        `${product.currentVersion}.\n         Run these by hand:\n${manual}`;
      o.emit({ ...check, outcome: "needs-human", message });
      return out.error(message, EXIT.needsHuman);
    }

    const url = product.service.inspect().url ?? o.service.url;
    if (url !== undefined) {
      const verdict = await product.waitForVersion({
        url,
        version: product.currentVersion,
        timeoutMs: product.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
      });
      if (verdict.state !== "ok") {
        const message =
          `${check.target} did not start, and ${product.currentVersion} is not answering at ${url} ` +
          "either.\n         Run these by hand:\n" +
          manual;
        o.emit({ ...check, outcome: "needs-human", message });
        return out.error(message, EXIT.needsHuman);
      }
    }
  }

  const message = `${check.target} didn't start; ${product.currentVersion} is running again.`;
  o.emit({ ...check, outcome: "rolled-back", message, ...(arrow !== "" ? {} : {}) });
  return out.error(message, EXIT.rolledBack);
}

/**
 * Find the CLI on disk that reports `wanted`, trying the places it can be.
 *
 * Three candidates, in the order that copes with the most layouts:
 *
 * 1. **`realpath(argv[1])`, resolved NOW.** The bin shim is a symlink, and a
 *    package manager that puts the version in the package's real path (pnpm's
 *    store) repoints that symlink on install. Re-resolving it after the install
 *    is the only candidate that follows.
 * 2. `<npm root -g>/<name>/<binSubpath>` — the npm-global layout, asked of npm
 *    rather than assumed.
 * 3. The package root §6 found, plus the same subpath — right for every layout
 *    whose path does not move.
 *
 * Each is run (`node <cli> --version`) and the first that reports `wanted`
 * wins. That is deliberately stricter than "the file exists": the thing this
 * guards against is handing `service install --refresh` to a CLI that is still
 * the old version, which would produce a green update that changed nothing.
 */
export function findCli(
  product: UpdateProduct,
  info: InstallInfo | undefined,
  wanted: string,
  ctx: {
    spawn?: Spawn;
    execPath?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    fs?: Pick<typeof fsDefault, "existsSync" | "readFileSync" | "realpathSync">;
  },
): string | undefined {
  const fs = ctx.fs ?? fsDefault;
  const candidates: string[] = [];
  try {
    candidates.push(fs.realpathSync(product.entry));
  } catch {
    candidates.push(product.entry);
  }
  const globalRoot = npmGlobalRoot(ctx);
  if (globalRoot !== undefined) {
    candidates.push(path.join(globalRoot, product.packageName, product.binSubpath));
  }
  if (info?.packageRoot !== undefined) {
    candidates.push(path.join(info.packageRoot, product.binSubpath));
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!fs.existsSync(candidate)) continue;
    if (cliVersion(candidate, ctx) === wanted) return candidate;
  }
  return undefined;
}

/** The command SPEC §3's notice prints for this install, with the product's own details filled in. */
function commandFor(
  product: UpdateProduct,
  info: InstallInfo,
  target: string,
): { command: string; note?: string } {
  return updateCommand(info, {
    packageName: product.packageName,
    target,
    ...(product.image !== undefined ? { image: product.image } : {}),
  });
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => (l === "" ? l : `    ${l}`))
    .join("\n");
}
