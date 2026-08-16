/**
 * Instance-level transcript-migration routes (#882) — the READ half.
 *
 *   GET /api/transcripts/migration        → the banner's probe. Cheap.
 *   GET /api/transcripts/migration/chats  → the modal's per-chat plan.
 *
 * The `POST` that executes the migration lands separately; see
 * `docs/DESIGN-transcripts-migration.md` §4 for its ordering (quiesce → move →
 * write config, with the config write as the deliberate commit point). Nothing
 * in this module writes, moves or deletes anything.
 *
 * ## Why two paths rather than one with `?summary=`
 *
 * The same reason `routes/discover.ts:9-18` gives for its own pair: paddock
 * publishes an OpenAPI 3 document generated from these Fastify route schemas,
 * and one path cannot describe two different 200 bodies there — it would have
 * to be `additionalProperties: true` with no shape at all, which is the defect
 * #822 was filed about. Cost confirms it independently: the probe is a readdir
 * per project, the plan can be a second of scanning, and they have different
 * call sites (every page load vs. when the modal opens).
 *
 * ## These schemas are deliberately NOT the house style
 *
 * Every other `response.200` in `packages/server/src/routes/` is
 * `additionalProperties: true` with the real shape in English in the
 * `description`. #822's stated preference is that shapes belong in the route
 * schemas so the published spec describes them, so these two are written out in
 * full: named fields, `required`, closed enums, `additionalProperties: false`.
 *
 * Treat the Fastify consequence as a feature: response serialization STRIPS
 * undeclared keys, so a field added to the DTO and forgotten here disappears at
 * runtime and the integration test catches it, rather than shipping
 * undocumented.
 *
 * ## This reads `~/.claude`, and that is a posture change
 *
 * Under `transcripts: own` nothing in the user's own Claude home was read at
 * all — `transcripts.ts` and `guides/what-paddock-touches.md` both promised
 * exactly that. Telling `new` from `fast-forward` is impossible without reading
 * it, so the plan endpoint does. It is behind its own route precisely so it is
 * something the SPA asks for rather than something a fleet poll does silently,
 * and both of those promises have been narrowed to match (design §8).
 */
import type { FastifyInstance } from "fastify";
import type { RouteCtx } from "../route-context.js";
import { instanceConfigPath, instanceConfigVersion } from "../instance-config.js";
import { ROOT_KEY } from "../project-paths.js";
import { sweeperWorkingDir } from "../herdctl-agent-config.js";
import {
  buildMigrationPlan,
  probeMigration,
  TRANSCRIPTS_ENV_VAR,
  type MigrationInput,
  type MigrationProjectRef,
} from "../transcripts-migration.js";

/** `MigrationState` — the three-state classification plus the budget escape. */
const stateSchema = {
  type: "string",
  enum: ["new", "fast-forward", "diverged", "unknown"],
  description:
    "new = no counterpart in the host store (default checked). fast-forward = a counterpart exists and one side is strictly ahead; lossless (default checked). diverged = both sides advanced independently (default UNCHECKED, requires an explicit choice). unknown = the divergence scan budget was exhausted before this row could be settled, or the host store could not be read; treated as diverged (default unchecked).",
} as const;

/** `MigrationSide` — one copy of a chat, for the diverged row's columns. */
const sideSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "sizeBytes", "mtime"],
  properties: {
    path: { type: "string", description: "Absolute path of this copy." },
    sizeBytes: { type: "integer", description: "Transcript size in bytes." },
    mtime: {
      type: "string",
      format: "date-time",
      description: "Filesystem mtime. Present always; NOT a proxy for activity (#863).",
    },
    messageCount: {
      type: "integer",
      description:
        "Conversation records in this copy — `user`/`assistant`, excluding meta and task-notification records, the same rule as last-activity.ts. Present ONLY on `diverged` rows, and only while the scan budget lasts: counting requires a full parse, so populating it on every row would mean reading every transcript on the instance to render a table whose other rows need no decision.",
    },
    lastMessageAt: {
      type: "string",
      format: "date-time",
      description:
        "ISO 8601 timestamp of the last real message. Present under the same rule as `messageCount`; absent when the transcript holds no datable conversation record, in which case the client falls back to `mtime`.",
    },
  },
} as const;

const chatRowSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "state", "defaultSelected", "own", "extras"],
  properties: {
    sessionId: { type: "string", description: "The chat id. Never rewritten by the migration." },
    name: {
      type: "string",
      description: "Display name: the chat's set name, else its auto-name. Absent when neither exists.",
    },
    preview: { type: "string", description: "First user message, truncated. Absent when unreadable." },
    state: stateSchema,
    defaultSelected: {
      type: "boolean",
      description: "How the checkbox starts: true for new and fast-forward, false for diverged and unknown.",
    },
    own: { ...sideSchema, description: "The copy in `.chats/`. Always present." },
    host: {
      ...sideSchema,
      description: "The copy in the host store. Absent if and only if state is `new` (or `unknown` because the store could not be read).",
    },
    ahead: {
      type: "string",
      enum: ["own", "host"],
      description: "For `fast-forward`, which side is the descendant and will therefore survive. Absent for other states.",
    },
    extras: {
      type: "array",
      description:
        "Sidecars that move with THIS chat: the contents of its `<id>/` directory (`subagents/`, `tool-results/`) and prefix-matched `.reverts/<id>-*.jsonl`. Listed so the completion summary can be specific about what moved.",
      items: { type: "string" },
    },
  },
} as const;

const projectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "name", "chatsDir", "hostStore", "preserveDir", "chats", "projectExtras"],
  properties: {
    slug: { type: "string", description: "Project slug; the empty string is the root workspace." },
    name: { type: "string", description: "Display name, for the group header." },
    chatsDir: { type: "string", description: "Absolute path of the source `<project.dir>/.chats/`." },
    hostStore: {
      type: "string",
      description:
        "Absolute destination `~/.claude/projects/<encoded-workingDir>/`. Keyed on workingDir, which for a repo-backed or linked project is the checkout, NOT the project dir.",
    },
    preserveDir: {
      type: "string",
      description:
        "Absolute path unchecked chats are moved to. A SIBLING of `.chats/`, not a child: a `pre-migration/` directory INSIDE `.chats/` would leave it non-empty, which makes `pointChatsDirAt` decline the redirect symlink and ships #708's own symptom. See DESIGN-transcripts-migration.md §5.1.",
    },
    chats: { type: "array", items: chatRowSchema },
    projectExtras: {
      type: "array",
      description:
        "Entries of `.chats/` that move with the PROJECT rather than with any one chat: `memory/`, flat `agent-<hex>.jsonl` sidechain transcripts, an orphaned `<id>/` with no transcript. They move because the postcondition is that `.chats/` ends up empty, and they are named so nothing moves unannounced.",
      items: { type: "string" },
    },
  },
} as const;

const warningSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message"],
  properties: {
    code: {
      type: "string",
      enum: [
        "host-store-unreadable",
        "chats-dir-unreadable",
        "env-shadowed",
        "memory-collision",
        "unexpected-entries",
      ],
      description:
        "`unexpected-entries` means `.chats/` holds entries that are neither transcripts nor known sidecars; they will still be moved (the postcondition is that `.chats/` ends up empty), but they are named so nothing moves unannounced. `memory-collision` means the host store already has an agent-memory file at the same relative path: Paddock's copy is set aside in the preserve dir rather than overwriting anything in your own ~/.claude.",
    },
    slug: { type: "string", description: "The project it applies to. Absent for instance-wide warnings." },
    message: { type: "string", description: "Human-readable detail, safe to render." },
    paths: {
      type: "array",
      items: { type: "string" },
      description: "Absolute paths the warning concerns. For `memory-collision` they are in source/destination pairs.",
    },
  },
} as const;

export function registerTranscriptsRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { cfg, projects, herdctl } = ctx;

  /** Everything the classifier needs, assembled per request. */
  async function input(slug?: string): Promise<MigrationInput> {
    const all = [await projects.get(ROOT_KEY), ...(await projects.list())];
    // `slug === ""` is the ROOT workspace and is falsy — `if (!slug)` would
    // silently drop the one workspace every instance has. The presence test is
    // against `undefined`, deliberately.
    const wanted =
      slug === undefined ? all : all.filter((p) => p.slug === slug);
    const refs: MigrationProjectRef[] = wanted.map((p) => ({
      slug: p.slug,
      name: p.name,
      dir: p.dir,
      workingDir: p.workingDir,
    }));
    const configPath = instanceConfigPath(cfg);
    return {
      mode: cfg.claude.transcripts,
      profile: cfg.profile,
      envShadowed: (process.env[TRANSCRIPTS_ENV_VAR] ?? "").trim().length > 0,
      projects: refs,
      // The user's own home, taken from the one place config resolves it, so
      // this can never disagree with the home `ensureProjectChats` writes into
      // under `host`.
      userHome: cfg.legacyClaudeHome,
      configPath,
      configVersion: instanceConfigVersion(configPath),
      sweeperDirs: new Map(refs.map((p) => [p.slug, sweeperWorkingDir(cfg, p.slug)])),
    };
  }

  app.get(
    "/api/transcripts/migration",
    {
      schema: {
        tags: ["System"],
        summary: "Whether this instance has transcripts to migrate from own to host",
        description:
          "The banner's probe (#882). Answers 'is there anything to migrate?' without classifying anything and without reading a transcript or the host store: it readdirs each project's `.chats/` and asks whether it is non-empty. That is the right question because of the migration's postcondition — the redirect symlink is only planted if `.chats/` ends up EMPTY, so every entry has to move, including a chat that is byte-identical on both sides. (An earlier draft short-circuited on the first chat absent from the host store, which is invisible to a user who adopted their CLI history and then worked on both sides: every id exists in both places, so there are zero such chats and the banner never appeared for the exact person the feature is for.) Memoised per project on `mtimeMs:size` of `.chats/` plus the config version, so it costs one stat per project when nothing has changed and is cheap enough for every page load. `eligible` is false with a `reason` when the instance is already on `host`, when PADDOCK_CLAUDE_TRANSCRIPTS shadows the config file (the write would be inert), when the posture profile is `paranoid` (which chose isolation deliberately — the migration stays reachable from the Config screen), or when nothing is pending. `pendingChats` counts transcripts and is contractually a LOWER BOUND; eligibility is about ENTRIES, so a `.chats/` holding only `memory/` is eligible with a count of 0. Key the banner off `eligible`, never off the count.",
        response: {
          200: {
            description: "Whether a migration is available, and roughly how much.",
            type: "object",
            additionalProperties: false,
            required: [
              "mode",
              "eligible",
              "pendingChats",
              "pendingProjects",
              "scannedProjects",
              "computedAt",
            ],
            properties: {
              mode: {
                type: "string",
                enum: ["own", "host"],
                description: "The transcripts mode this process resolved at boot.",
              },
              eligible: {
                type: "boolean",
                description: "True when a migration is available to offer. The banner shows if and only if this is true.",
              },
              reason: {
                type: "string",
                enum: [
                  "already-host",
                  "env-shadowed",
                  "profile-paranoid",
                  "nothing-pending",
                  "scan-failed",
                ],
                description:
                  "Why `eligible` is false; absent when it is true. Reported in that order of precedence, so a `paranoid` instance whose config write would also be inert reports `env-shadowed` — the blocking condition beats the posture one.",
              },
              envVar: {
                type: "string",
                description:
                  "The environment variable shadowing the config file. Present only with reason `env-shadowed`; always PADDOCK_CLAUDE_TRANSCRIPTS.",
              },
              pendingChats: {
                type: "integer",
                description: "Lower bound on chats that would migrate. See the endpoint description for the one case where it is 0 while `eligible` is true.",
              },
              pendingProjects: { type: "integer", description: "Projects with a non-empty `.chats/`." },
              scannedProjects: { type: "integer", description: "Projects examined." },
              computedAt: {
                type: "string",
                format: "date-time",
                description: "When this answer was computed. May predate the request when served from cache.",
              },
            },
          },
        },
      },
    },
    async () => probeMigration(await input()),
  );

  app.get<{ Querystring: { slug?: string } }>(
    "/api/transcripts/migration/chats",
    {
      schema: {
        tags: ["System"],
        summary: "Per-chat migration plan, grouped by project",
        description:
          "The checkbox table behind the #882 modal. Classifies every chat in every project's `.chats/` against its host store: `new` (no counterpart), `fast-forward` (a counterpart exists and one side is strictly ahead — lossless), `diverged` (both advanced independently). Chats identical on both sides are omitted entirely — there is no decision to make — but they are counted in `totals.identical`, and they still migrate, because the postcondition is about `.chats/` ending up empty rather than about what the user ticked. Classification is staged so cost tracks conflicts rather than chat count: a `new` chat is settled by two readdirs, and the fast-forward test is a bounded read at the byte offset an append-only ancestor's last record must end at, not a scan. Only a genuine divergence costs a full read of the longer file, and those draw from a shared 256 MB budget; rows past it come back `unknown`, default to unchecked, and set `scanBudgetExhausted`. A diverged row's `messageCount` / `lastMessageAt` comparison columns are read from the same budget and are absent when it will not stretch. Sweeper stores migrate silently with their project and appear only as a count. `configVersion` is the value to echo back as `expectedVersion` on the POST, and is read fresh for every response rather than cached.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            slug: {
              type: "string",
              description: "Optional. Restrict the plan to one project. The ROOT workspace is the EMPTY STRING, so `?slug=` is a real request for it and is not the same as omitting the parameter.",
            },
          },
        },
        response: {
          200: {
            description: "The full migration plan.",
            type: "object",
            additionalProperties: false,
            required: [
              "mode",
              "configPath",
              "configVersion",
              "projects",
              "sweepers",
              "totals",
              "scanBudgetExhausted",
              "warnings",
            ],
            properties: {
              mode: { type: "string", enum: ["own", "host"] },
              configPath: { type: "string", description: "Absolute path of the file the POST writes to." },
              configVersion: {
                type: ["string", "null"],
                description:
                  "Fingerprint of paddock.config.yaml as read for THIS response; null when the file does not exist yet. Echo as `expectedVersion` on the POST to make the write conditional.",
              },
              projects: {
                type: "array",
                description:
                  "One entry per project with at least one row or one project-level artifact. Projects whose chats are all identical on both sides, and projects with an empty `.chats/`, are omitted.",
                items: projectSchema,
              },
              sweepers: {
                type: "object",
                additionalProperties: false,
                required: ["stores", "chats"],
                description:
                  "Sweeper transcript stores under `<dataDir>/sweepers/<slug>/`. Migrated silently with their project, with no rows and no user choice (#882). Reported as counts only, so the completion summary can mention them.",
                properties: {
                  stores: { type: "integer", description: "Sweeper stores that will be migrated." },
                  chats: { type: "integer", description: "Sweeper transcripts inside them." },
                },
              },
              totals: {
                type: "object",
                additionalProperties: false,
                required: [
                  "chats",
                  "new",
                  "fastForward",
                  "diverged",
                  "unknown",
                  "identical",
                  "defaultSelected",
                ],
                properties: {
                  chats: { type: "integer", description: "Rows in `projects[].chats`." },
                  new: { type: "integer" },
                  fastForward: { type: "integer" },
                  diverged: { type: "integer" },
                  unknown: { type: "integer" },
                  identical: {
                    type: "integer",
                    description:
                      "Chats identical on both sides, omitted from the rows. Reported so a row count lower than the user's chat total always has an explanation.",
                  },
                  defaultSelected: {
                    type: "integer",
                    description: "Rows starting checked — the modal's initial 'N of M'.",
                  },
                },
              },
              scanBudgetExhausted: {
                type: "boolean",
                description:
                  "True when the divergence-scan budget ran out. Never silently true — `totals.unknown` counts the rows it cost, and a `diverged` row missing its `messageCount` is the other thing it costs.",
              },
              warnings: {
                type: "array",
                description: "Non-fatal conditions that do not stop the migration but that the modal should surface.",
                items: warningSchema,
              },
            },
          },
        },
      },
    },
    async (req) => {
      const slug = req.query.slug;
      const built = await input(slug);
      // Names and previews come from the same listing the chat list renders
      // from (memoised inside herdctl + `last-activity`), rather than from a
      // second reader that could disagree with it about what a chat is called.
      // Best-effort: an unreadable store must degrade to an unnamed row, not to
      // a failed plan.
      const names = new Map<string, { name?: string; preview?: string }>();
      const wanted = slug === undefined ? undefined : slug;
      for (const p of [await projects.get(ROOT_KEY), ...(await projects.list())]) {
        if (wanted !== undefined && p.slug !== wanted) continue;
        for (const s of await herdctl.listSessions(p).catch(() => [])) {
          names.set(s.sessionId, {
            ...(s.customName ?? s.autoName ? { name: s.customName ?? s.autoName } : {}),
            ...(s.preview ? { preview: s.preview } : {}),
          });
        }
      }
      return buildMigrationPlan({ ...built, names });
    },
  );
}
