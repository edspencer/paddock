/**
 * Instance-level Discovery routes (#745).
 *
 * Two GETs, both read-only:
 *
 *   GET /api/discover                  → ranked candidate directories + counts
 *   GET /api/discover/sessions?dir=…   → one directory's sessions, for expansion
 *
 * ## Why two paths rather than one with `?dir=`
 *
 * Issue #745 sketches this as a single `/api/discover` that changes shape when
 * `dir` is present. Paddock publishes an OpenAPI 3 document GENERATED from these
 * Fastify route schemas (`scripts/dump-openapi.mjs` → `openapi-site/`), and one
 * path cannot describe two different 200 bodies there — it would have to be
 * declared `additionalProperties: true` with no shape at all, and the published
 * contract would silently stop describing the endpoint. The two responses also
 * fail differently: the listing cannot 400, and the expansion must, on any path
 * outside the discovered set. Same handlers, same module, two honest paths.
 *
 * ## Containment
 *
 * `POST …/adopt-chats` refuses a `sourceCwd` its project does not offer,
 * deliberately, "rather than an invitation to scan arbitrary directories" — and
 * that rule is NOT relaxed here. These routes are a separate, instance-scoped
 * surface whose own containment is that the only paths they will read are ones
 * `<claudeHome>/projects/*` already records, filtered through the same path floor
 * a linked project has to clear (#718–#721). `?dir=` is a lookup into that
 * computed set, not a path parameter: an unrecognised value is a 400 and reads
 * nothing. See `discover.ts` for the rules themselves.
 *
 * ## Exposure
 *
 * The listing reveals which directories this machine's user has run Claude Code
 * in. That is new surface, though narrower than a file browser — it cannot
 * enumerate anything the user has not already opened a session in. On the
 * loopback + `auth: none` default it is the same posture as every other route
 * here; on a shared authenticated instance it is worth knowing about.
 */
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { RouteCtx } from "../route-context.js";
import {
  defaultTempRoots,
  discoverCandidates,
  discoverSessions,
  DiscoverPathError,
  withoutOwnTranscriptFolders,
  type DiscoverContext,
  type DiscoverOptions,
} from "../discover.js";
import { ROOT_KEY } from "../project-paths.js";

/** A `?flag=` that is present and not explicitly falsy. */
function flag(value: string | undefined): boolean {
  return value !== undefined && value !== "0" && value !== "false";
}

export function registerDiscoverRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { herdctl, projects, cfg } = ctx;

  /**
   * Assemble everything the heuristic needs. Rebuilt per request rather than
   * memoised: projects come and go (which is the whole point of the screen —
   * importing one must remove its row from the next scan), and the expensive
   * half is already cached inside `AdoptableIndex`.
   */
  async function context(): Promise<DiscoverContext> {
    const existing = [...(await projects.list()), await projects.get(ROOT_KEY)];
    return {
      // Paddock's own `.chats` bridges are removed BEFORE the scan sees them, so
      // they are not counted in `scanned` either (#865). A pristine instance has
      // two of them and nothing else, and counting those was what made
      // `scanned === 0` — "no history on this machine" — unreachable.
      folders: withoutOwnTranscriptFolders(await herdctl.transcriptFolders(), {
        ownRoots: [cfg.projectsRoot, cfg.dataDir],
        claudeHomes: [cfg.claudeHome, cfg.legacyClaudeHome],
      }),
      claudeHome: cfg.claudeHome,
      // The user's own home, taken from the one place config already resolves it
      // (`legacyClaudeHome` is `os.homedir()/.claude`, with no override) so this
      // can never disagree with the home adoption reads from.
      homeDir: path.dirname(cfg.legacyClaudeHome),
      // Exactly what `ProjectStore.validatePath` refuses to link inside, plus
      // both Claude homes — a transcript folder is not a project.
      reservedRoots: [cfg.projectsRoot, cfg.dataDir, cfg.claudeHome, cfg.legacyClaudeHome],
      tempRoots: defaultTempRoots(),
      managedDirs: existing.map((p) => p.workingDir),
      takenSlugs: existing.map((p) => p.slug),
      listSessions: (engineCwd) => herdctl.listAdoptableIn(engineCwd),
    };
  }

  app.get<{ Querystring: { includeNonGit?: string; includeOutsideHome?: string } }>(
    "/api/discover",
    {
      schema: {
        tags: ["System"],
        summary: "Directories on this machine that could become projects",
        description:
          "Scans `<claudeHome>/projects/*` for directories with existing Claude Code history and returns the ones worth importing, ranked by how many non-noise sessions each holds. Never walks the filesystem: the only directories it can name are ones a transcript already records, and each is put through the same path floor a linked project must clear (no system directories, no temp roots, nothing inside Paddock's own data dir, nothing overlapping an existing project). Two rules are relaxable: `includeNonGit=1` offers directories that are not git checkouts, `includeOutsideHome=1` offers directories outside `$HOME`. Note the two counts are in DIFFERENT units and do not reconcile by subtraction: `scanned` counts transcript FOLDERS, while `excluded` reports how many DIRECTORIES each rule ate — one directory routinely has two transcript folders (the user's own and Paddock's copy), so a rule that ate one directory may account for two scanned folders. The single exception is `no-recorded-cwd`, which is necessarily per-folder: a folder with no recorded cwd has no directory to be counted under. A machine with no Claude Code history reports `scanned: 0`, which is what distinguishes 'no history' from 'all of it was filtered'. Paddock's own `.chats` bridge folders are excluded before that count is taken — they exist on an instance nobody has used yet, and counting them made `scanned: 0` unreachable. Response: `{ claudeHome, homeDir, scanned, candidates, excluded }`.",
        querystring: {
          type: "object",
          properties: {
            includeNonGit: {
              type: "string",
              description: "Set to `1` to also offer directories with no `.git`.",
            },
            includeOutsideHome: {
              type: "string",
              description: "Set to `1` to also offer directories outside `$HOME`.",
            },
          },
        },
        response: {
          200: {
            description: "Ranked candidate directories plus the exclusion tally.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req) => {
      const opts: DiscoverOptions = {
        includeNonGit: flag(req.query.includeNonGit),
        includeOutsideHome: flag(req.query.includeOutsideHome),
      };
      return discoverCandidates(await context(), opts);
    },
  );

  app.get<{ Querystring: { dir?: string } }>(
    "/api/discover/sessions",
    {
      schema: {
        tags: ["System"],
        summary: "One discovered directory's importable sessions",
        description:
          "Lists the Claude Code sessions a directory reported by GET /api/discover would import, so a client can expand a row lazily and tick sessions individually. `dir` must be one of that scan's directories — matched on either its resolved path or the cwd its transcripts record — and anything else is a 400 rather than an invitation to read arbitrary paths. The soft `includeNonGit` / `includeOutsideHome` preferences do not apply here: a client can only have learnt a path from a listing that already applied them. Response: `{ path, sessions, filtered }`, where `filtered` carries the noise filter's reason per withheld session (`too-small`, `slash-command-only`, `sweeper-run`) — the same vocabulary as GET …/adoptable-chats, and `sessions[].sessionId` is what `POST …/adopt-chats` takes as `sessionIds`.",
        querystring: {
          type: "object",
          properties: {
            dir: { type: "string", description: "A directory from GET /api/discover." },
          },
          required: ["dir"],
        },
        response: {
          200: {
            description: "Object `{ path, sessions, filtered }` for that directory.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      const dir = req.query.dir;
      if (dir === undefined || dir.trim() === "") {
        return reply.code(400).send({ error: "dir is required", code: "invalid" });
      }
      try {
        return await discoverSessions(await context(), dir);
      } catch (err) {
        if (err instanceof DiscoverPathError) {
          return reply.code(400).send({ error: err.message, code: "invalid" });
        }
        throw err;
      }
    },
  );
}
