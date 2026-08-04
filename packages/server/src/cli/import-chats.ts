/**
 * One-shot importer for native Claude Code chats (#588) — the headless twin of
 * `POST …/adopt-chats`.
 *
 * ## Why it lives here and not in `scripts/`
 *
 * It needs `loadPaddockConfig`, `ProjectStore` and `HerdctlService`, which are
 * TypeScript modules in this package. `scripts/` is pinned to CommonJS by its
 * own `package.json` (for the extensionless `pm` wrapper) and holds only plain
 * `.mjs`, so a script there could not import them without a build step or a
 * duplicated config parser — and a duplicated parser is exactly how the CLI and
 * the server would come to disagree about which data dir or Claude home they are
 * working on. Here it inherits this package's `"type": "module"`, its tsconfig
 * and its `tsx`, and runs the SAME code the server runs.
 *
 * ## Deployment note
 *
 * The import needs READ access to the user's own transcripts, which live in
 * `~/.claude` — a read-only source paddock reads out of and never writes to
 * (#620). In a container that usually means running this on the HOST against
 * the data dir (`--data-dir`), or bind-mounting the user's `~/.claude` in at the
 * same path. Detection silently finds nothing if the transcripts are not
 * visible — which is why `--dry-run` prints the sources it found rather than
 * only a count.
 *
 * ## Usage
 *
 *   npm run import-chats -w @paddock/server -- --project <slug> [options]
 *
 *   --project <slug>   Workspace to import into. Required. Use "" (or --root)
 *                      for the ROOT workspace, whose key IS the empty string.
 *   --root             Sugar for `--project ""`.
 *   --from <dir>       Import only this source working directory. Default: every
 *                      source detection offers.
 *   --move             Move transcripts instead of copying them. DESTRUCTIVE:
 *                      the sessions disappear from the user's own history.
 *   --dry-run          Report what would happen and write nothing at all.
 *   --data-dir <dir>   Paddock data dir (same meaning as PADDOCK_DATA_DIR).
 *                      Applied to the environment BEFORE the config is read.
 *   --json             Emit the raw result as JSON instead of prose.
 */
import { pathToFileURL } from "node:url";
import { loadPaddockConfig } from "../config.js";
import { ProjectStore, ROOT_KEY } from "../projects.js";
import { HerdctlService } from "../herdctl.js";
import { RunProvenanceStore, ADOPTED_ROOT } from "../run-provenance.js";

interface Args {
  project?: string;
  from?: string;
  move: boolean;
  dryRun: boolean;
  dataDir?: string;
  json: boolean;
  help: boolean;
}

/**
 * Parse argv. Hand-rolled because this is the repo's FIRST script taking flags
 * (`pm` parses its own, in CommonJS) — there is no convention to follow and no
 * argument parser in the dependency tree, and adding one for six flags would be
 * the larger change.
 *
 * `--project ""` must survive: the root workspace's key is the empty string, so
 * a "missing value" check written as truthiness would reject the one workspace
 * that always exists.
 */
export function parseArgs(argv: string[]): Args {
  const args: Args = { move: false, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        throw new Error(`${arg} needs a value`);
      }
      i++;
      return next;
    };
    switch (arg) {
      case "--project":
        args.project = value();
        break;
      case "--root":
        args.project = ROOT_KEY;
        break;
      case "--from":
        args.from = value();
        break;
      case "--move":
        args.move = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--data-dir":
        args.dataDir = value();
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const USAGE = `Import existing Claude Code CLI chats into a Paddock workspace.

  npm run import-chats -w @paddock/server -- --project <slug> [options]

  --project <slug>   Workspace to import into (required). "" = the root workspace.
  --root             Sugar for --project ""
  --from <dir>       Import only this source working directory
  --move             Move transcripts instead of copying (DESTRUCTIVE)
  --dry-run          Report what would happen; write nothing
  --data-dir <dir>   Paddock data dir (same as PADDOCK_DATA_DIR)
  --json             Emit raw JSON
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  // `=== undefined`, not falsiness: "" is the root workspace, a real target.
  if (args.project === undefined) {
    process.stderr.write("--project is required (use --root for the root workspace)\n\n" + USAGE);
    return 2;
  }
  // Must land in the environment BEFORE the config is read — every other path
  // (projects root, state dir, herdctl config) is derived from it.
  if (args.dataDir !== undefined) process.env.PADDOCK_DATA_DIR = args.dataDir;

  const cfg = loadPaddockConfig();
  const projects = new ProjectStore(cfg.projectsRoot);
  const herdctl = new HerdctlService(cfg);
  const project = await projects.get(args.project);

  // Register the keepers so the agent this imports INTO exists and its `.chats/`
  // symlink is in place. `init` is the same call the server makes at boot; the
  // scheduler is never started, so nothing fires while we run.
  const rootWorkspace = await projects.get(ROOT_KEY);
  await herdctl.init([...(await projects.list()), rootWorkspace]);

  try {
    const summary = await herdctl.listAdoptable(project);
    if (summary.count === 0 && summary.filtered.length === 0) {
      process.stdout.write(
        args.json
          ? JSON.stringify({ adopted: [], skipped: [] }) + "\n"
          : `Nothing to import for "${project.slug || "(root)"}".\n` +
              `Working directory: ${project.workingDir}\n` +
              `Claude home:       ${cfg.claudeHome}\n` +
              `Importing from:    ${cfg.legacyClaudeHome}\n` +
              `If you expected chats here, check that this process can READ the transcripts\n` +
              `under that source home (a container only sees what is mounted).\n`,
      );
      return 0;
    }

    const result = await herdctl.adoptChats(project, {
      sourceCwd: args.from,
      mode: args.move ? "move" : "copy",
      dryRun: args.dryRun,
    });

    // Provenance is a server-side sidecar, so the CLI must stamp it too or a
    // chat imported headlessly would badge differently from one imported in the
    // UI. Skipped under --dry-run: it is a write.
    if (!args.dryRun) {
      const runProvenance = new RunProvenanceStore(cfg.dataDir);
      for (const sessionId of result.adopted) {
        await runProvenance.stampIfAbsent(sessionId, ADOPTED_ROOT).catch(() => undefined);
      }
    }

    if (args.json) {
      process.stdout.write(JSON.stringify({ ...result, sources: summary.sources }, null, 2) + "\n");
      return 0;
    }

    const verb = args.dryRun ? "Would import" : "Imported";
    const lines: string[] = [];
    lines.push(`${verb} ${result.adopted.length} chat(s) into "${project.slug || "(root)"}".`);
    for (const source of summary.sources) {
      lines.push(`  from ${source.sourceCwd} (${source.sessionIds.length} offered)`);
    }
    if (summary.filtered.length > 0) {
      lines.push(`  withheld as noise: ${summary.filtered.length}`);
      for (const f of summary.filtered) lines.push(`    ${f.sessionId}  ${f.reason}`);
    }
    if (result.skipped.length > 0) {
      lines.push(`  skipped: ${result.skipped.length}`);
      for (const s of result.skipped) lines.push(`    ${s.sessionId}  ${s.reason}`);
    }
    if (args.dryRun) lines.push("Dry run — nothing was written.");
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    await herdctl.stop().catch(() => undefined);
  }
}

// Only run when invoked directly, so the arg parser stays unit-testable.
// `pathToFileURL`, not `"file://" + argv[1]`: the naive concatenation leaves any
// space or non-ASCII character in the path un-encoded, so the comparison fails
// and the script silently does nothing when run from such a directory — the same
// percent-encoding trap as #636.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).message ?? err}\n`);
      process.exit(1);
    });
}
