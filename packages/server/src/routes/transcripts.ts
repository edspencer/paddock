/**
 * Instance-level transcript-migration routes (#882).
 *
 *   GET  /api/transcripts/migration        → the banner's probe. Cheap.
 *   GET  /api/transcripts/migration/chats  → the modal's per-chat plan.
 *   POST /api/transcripts/migration        → execute: quiesce, move, commit.
 *
 * ## Steps 1–3 of §4.1 are here, and that is deliberate
 *
 * The execute ordering is
 * `single-flight → expectedVersion → quiesce → re-enumerate → move → write
 * config`, and the first three are refusals: when any of them fires, NOTHING
 * may have moved. The cleanest way to guarantee that is for them to run in the
 * route, before `executeMigration` — which owns the mover — is entered at all.
 * The config write is handed to it as a callback for the mirror-image reason:
 * it is the COMMIT POINT and must be last, so the module that decides whether
 * every project reached the postcondition is the module that gets to call it.
 *
 * The reverse order (config first) was rejected in the design: a crash between
 * a config saying `host` and files still in `.chats/` is a genuine #708 split,
 * where a crash the other way is the transient blank list #882 already tells
 * the user to expect, and which re-running reconciles.
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
import {
  instanceConfigPath,
  instanceConfigVersion,
  pendingTranscriptsMode,
  writeInstanceConfig,
} from "../instance-config.js";
import { ROOT_KEY } from "../project-paths.js";
import { sweeperWorkingDir } from "../herdctl-agent-config.js";
import { quiesceProject, turnRunningError } from "../turn-interlock.js";
import {
  buildMigrationPlan,
  probeMigration,
  resetMigrationProbeCache,
  TRANSCRIPTS_ENV_VAR,
  type MigrationInput,
  type MigrationProjectRef,
} from "../transcripts-migration.js";
import { executeMigration } from "../transcripts-migration-execute.js";

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

/* -------------------------------------------------------------------------- */
/* POST schemas                                                                */
/* -------------------------------------------------------------------------- */

const preservedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "slug", "side", "path", "reason"],
  properties: {
    sessionId: {
      type: "string",
      description:
        "The chat id — or, for an agent-memory file set aside by the `memory/` merge, its path relative to the store (`memory/MEMORY.md`). A memory file is not a chat and is in this array anyway: this is the one place the completion screen renders as the recovery path, and a recovery path with a hole in it is worse than a slightly loose field name.",
    },
    slug: { type: "string" },
    side: {
      type: "string",
      enum: ["own", "host"],
      description:
        "Which store the preserved copy came OUT of. `own` is Paddock's copy; `host` is the user's own, moved aside so Paddock's could supersede it. Not in the design's schema, and needed: a completion screen that told a user their terminal transcript was 'not ticked' would be both false and alarming.",
    },
    path: { type: "string", description: "Absolute path of the preserved transcript, as actually written." },
    reason: {
      type: "string",
      enum: ["unchecked", "unplanned-diverged", "identical", "already-ahead", "superseded"],
      description:
        "`unchecked` = the user did not tick it. `unplanned-diverged` = it appeared after the plan was built and classified diverged, so its own default was applied. `identical` = byte-identical on both sides, so no choice was ever offered and Paddock's redundant copy was set aside. `already-ahead` = a fast-forward with the HOST side ahead: the user's copy is the descendant and survives. `superseded` = the user's copy was moved out of ~/.claude BEFORE Paddock's landed on top. The last three are additions: replacing the design's skip-if-present rule (see the endpoint description) made them reachable.",
    },
  },
} as const;

const failedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "slug", "reason"],
  properties: {
    sessionId: { type: "string" },
    slug: { type: "string" },
    reason: {
      type: "string",
      enum: ["destination-exists", "unreadable", "move-failed", "preserve-failed", "unknown"],
      description:
        "Open vocabulary in practice: a client must render an unrecognised value verbatim rather than swallow it, as discoverImport.ts already does for adoption reasons.",
    },
    message: { type: "string" },
    path: {
      type: "string",
      description:
        "The path the failure is about. Present because a project and its sweeper store share a slug, so the slug alone cannot say which one failed.",
    },
  },
} as const;

const projectResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "outcome", "migrated", "preserved", "chatsDirEmpty"],
  properties: {
    slug: { type: "string" },
    outcome: {
      type: "string",
      enum: ["migrated", "nothing-to-do", "skipped-busy", "failed"],
      description:
        "`skipped-busy` means a turn woke up between the quiesce and this project's moves and it was abandoned UNTOUCHED (#731). A skipped project is never counted as migrated.",
    },
    migrated: { type: "integer", description: "Chats moved into the host store." },
    preserved: { type: "integer", description: "Chat copies moved to the preserve dir, from either side." },
    chatsDirEmpty: {
      type: "boolean",
      description:
        "Whether `<project.dir>/.chats/` is empty afterwards. FALSE IS A FAILURE — a non-empty `.chats/` means `pointChatsDirAt` declines the redirect symlink on restart and the project is half-blind (#708). The config is not written while any project reports false.",
    },
    error: { type: "string", description: "Present only when the outcome is `failed` or `skipped-busy`." },
  },
} as const;

/**
 * §4.3 — one execute at a time, instance-wide.
 *
 * The client-side `if (busy) return` guard is not enough: it does not survive a
 * reload and does not exist in a second tab. In-memory and restart-forgetting,
 * which is correct here for the same reason the undo map is
 * (`herdctl.ts:973-987`) — and doubly so, since this flow ENDS in a restart.
 *
 * Armed synchronously, before the handler's first `await`, which is what makes
 * it airtight on a single-threaded event loop.
 */
let migrationInFlight: Promise<void> | null = null;

/** Drop the single-flight latch. For tests, and for a process that somehow
 *  leaked one — a stuck latch would refuse every future migration. */
export function resetMigrationSingleFlight(): void {
  migrationInFlight = null;
}

/** Same guard as `readFirstUserText`: a session id must stay inside `.chats/`. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

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

  app.post<{
    Body: {
      sessionIds?: string[];
      plannedSessionIds?: string[];
      expectedVersion?: string | null;
      dryRun?: boolean;
    } | null;
  }>(
    "/api/transcripts/migration",
    {
      schema: {
        tags: ["System"],
        summary: "Execute the own → host transcript migration",
        description:
          "Runs the migration (#882): quiesce every project, re-enumerate `.chats/` from disk, move, and — only if EVERY project ends with an empty `.chats/` — write `claude.transcripts: host`. That write is the COMMIT POINT and is deliberately last: until it lands the running server still resolves `own` and a partly-emptied `.chats/` is the transient blank-list state the modal already warns about, which re-running reconciles. The reverse order was rejected because a crash between a `host` config and files still in `.chats/` is a genuine #708 split. " +
          "`sessionIds` are the chats the user TICKED; everything else in `.chats/` is preserved rather than migrated, and an empty array is a legal choice meaning 'migrate nothing, preserve everything, flip the lever'. " +
          "NOTHING IS EVER DELETED and nothing in your own `~/.claude` is overwritten in place. Where a chat exists on both sides, the copy that does not survive is MOVED to `<project.dir>/.chats-pre-migration/` — a SIBLING of `.chats/`, because a `pre-migration/` child would leave `.chats/` non-empty and make the redirect symlink be declined, shipping #708's own symptom. When Paddock's copy supersedes the user's (a fast-forward Paddock is ahead on, or a diverged chat the user ticked), the user's copy is moved aside FIRST and the replacement lands on an empty destination. " +
          "This replaces the design's skip-if-present move rule, which deadlocked against the empty-`.chats/` postcondition for every chat present on both sides — on an instance where the user adopted their CLI history and then worked in both places, that is every chat, and the migration could not succeed at all. " +
          "`memory/` is merged at FILE granularity for the same reason: `memory/MEMORY.md` is a single well-known path, so a collision is the common case, and a colliding file is set aside with a `memory-collision` warning rather than overwriting a hand-curated index. " +
          "Sweeper stores migrate silently with their project and are reported as counts. Returns 409 (nothing moved) for `turn_running`, `config_conflict` and `migration_in_progress`, and 400 for `env_shadowed` (the write would be inert) or a malformed session id.",
        body: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            sessionIds: {
              type: "array",
              items: { type: "string" },
              minItems: 0,
              maxItems: 5000,
              description:
                "The chat ids the user TICKED. Omitted or empty means 'migrate nothing, preserve everything, and flip the lever' — a real choice, so it is not a 400. Ids not currently in any `.chats/` are ignored and named back in `ignoredSessionIds`.",
            },
            plannedSessionIds: {
              type: "array",
              items: { type: "string" },
              minItems: 0,
              maxItems: 5000,
              description:
                "Every id the plan this selection was made against contained — i.e. `projects[].chats[].sessionId` from GET /chats. Optional, and load-bearing when present: without it a chat CREATED between preview and submit is indistinguishable from one the user deliberately unticked (both are 'on disk, absent from sessionIds'), so §4.6's rule — apply the new chat's own classification default and report it — cannot be implemented. Omit and every untricked chat is treated as a deliberate choice, and `unplanned` comes back empty.",
            },
            expectedVersion: {
              type: ["string", "null"],
              description:
                "The `configVersion` from the plan this selection was made against. When the property is present the config write is conditional: 409 `config_conflict` if paddock.config.yaml changed underneath you. Omit the property entirely to write unconditionally.",
            },
            dryRun: {
              type: "boolean",
              description:
                "Default false. Skips the quiesce, moves nothing and writes nothing; the response reports exactly what WOULD happen, decided by the same code the real run uses rather than by a parallel description of it.",
            },
          },
        },
        response: {
          200: {
            description:
              "The migration ran. A 200 with a non-empty `failed`, or any project reporting `chatsDirEmpty: false`, is a PARTIAL migration and the config was NOT written; re-running is safe and skips what already moved.",
            type: "object",
            additionalProperties: false,
            required: [
              "ok",
              "alreadyMigrated",
              "dryRun",
              "projects",
              "migrated",
              "preserved",
              "unplanned",
              "ignoredSessionIds",
              "failed",
              "sweepers",
              "warnings",
              "configWritten",
              "configPath",
              "restartRequired",
            ],
            properties: {
              ok: {
                type: "boolean",
                description:
                  "True when every project reached the postcondition AND the config now says host (either this call wrote it, or it already did). On a `dryRun` it is the PREDICTION — 'this would succeed' — because a dry run can never write the config, and reporting false for an entirely healthy plan would tell a confirm step the opposite of the truth.",
              },
              alreadyMigrated: {
                type: "boolean",
                description:
                  "Nothing to do: the stores were already migrated and the config FILE already said host. Judged against the file rather than this process's boot-frozen mode, because the two disagree for the whole window between a successful migration and the restart it asks for — which is exactly when a repeat POST arrives.",
              },
              dryRun: { type: "boolean" },
              projects: {
                type: "array",
                description: "Per-project outcome, in the order they were processed.",
                items: projectResultSchema,
              },
              migrated: {
                type: "array",
                items: { type: "string" },
                description: "Session ids whose Paddock copy is now in a host store.",
              },
              preserved: {
                type: "array",
                description:
                  "Copies deliberately set aside, with where they went. NOTHING IS EVER DELETED; this array is the recovery path and the completion screen must render it in full.",
                items: preservedSchema,
              },
              unplanned: {
                type: "array",
                description:
                  "Chats present at execute time that were in neither the plan nor `sessionIds` — created between preview and submit. Each was handled by its own classification's default (§4.6) and is reported so the summary stays honest. Always empty unless `plannedSessionIds` was sent.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["sessionId", "slug", "state", "action"],
                  properties: {
                    sessionId: { type: "string" },
                    slug: { type: "string" },
                    state: stateSchema,
                    action: { type: "string", enum: ["migrated", "preserved"] },
                  },
                },
              },
              ignoredSessionIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "Ids in `sessionIds` that are not in any `.chats/`. Ignored, and named rather than silently dropped — the design says they are 'reported under unknown' and then gives the 200 body nowhere to report them.",
              },
              failed: {
                type: "array",
                description:
                  "Per-chat failures. A non-empty array means the config was NOT written and the instance is still on `own`.",
                items: failedSchema,
              },
              sweepers: {
                type: "object",
                additionalProperties: false,
                required: ["stores", "chats"],
                properties: {
                  stores: { type: "integer" },
                  chats: { type: "integer", description: "Sweeper transcripts migrated silently (#882)." },
                },
              },
              warnings: {
                type: "array",
                description:
                  "Carried through from the re-enumeration. `memory-collision` in particular is REQUIRED by the design's §10.2 and had nowhere to live in its 200 body.",
                items: warningSchema,
              },
              configWritten: {
                type: "boolean",
                description:
                  "Whether `claude.transcripts: host` was written. THE COMMIT POINT: false means nothing semantically happened and the instance is still resolving `own`.",
              },
              configPath: { type: "string" },
              configVersion: {
                type: "string",
                description: "Fingerprint after the write. Present only when `configWritten`.",
              },
              restartRequired: {
                type: "boolean",
                description:
                  "Whether a restart is still needed for the on-disk state to take effect. Config is frozen at boot (app.ts:128), and until the restart the chat list stays BLANK because the running process is still resolving `own` against a `.chats/` this call just emptied — the completion screen must say so. TRUE for a repeat POST that wrote nothing but whose earlier write has not been restarted into yet; the design's 'always true when configWritten' would have reported false there.",
              },
            },
          },
          400: {
            description:
              "`env_shadowed` when PADDOCK_CLAUDE_TRANSCRIPTS is set — env beats the config file, so the write would be inert and the flip would never happen. `invalid` for a malformed session id. Nothing was moved.",
            type: "object",
            additionalProperties: false,
            required: ["error", "code"],
            properties: {
              error: { type: "string" },
              code: { type: "string", enum: ["env_shadowed", "invalid"] },
              envVar: { type: "string" },
            },
          },
          409: {
            description:
              "Nothing was moved and no config was written. `turn_running` — a turn could not be stopped on some chat, so the WHOLE migration refused: a chat left behind leaves `.chats/` non-empty and breaks the flip for its entire project, so this is not a per-item failure. `config_conflict` — `expectedVersion` no longer matches. `migration_in_progress` — another execute is already running.",
            type: "object",
            additionalProperties: false,
            required: ["error", "code"],
            properties: {
              error: { type: "string" },
              code: {
                type: "string",
                enum: ["turn_running", "config_conflict", "migration_in_progress"],
              },
              sessionIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "For `turn_running`: the chats that would not stop. Matches `turnRunningError` exactly, so a client can reuse whatever it already does with that body.",
              },
              configVersion: {
                type: ["string", "null"],
                description: "For `config_conflict`: the fingerprint the file actually has now.",
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      // STEP 1 — single-flight. Checked and armed with no `await` between, so
      // two simultaneous requests cannot both pass.
      if (migrationInFlight !== null) {
        return reply.code(409).send({
          error:
            "A transcript migration is already running on this instance. Wait for it to finish — it is a single operation and re-running it while it works could interleave two sets of moves.",
          code: "migration_in_progress",
        });
      }
      let release!: () => void;
      migrationInFlight = new Promise<void>((r) => {
        release = r;
      });
      try {
        const body = req.body ?? {};
        const sessionIds = body.sessionIds ?? [];
        const bad = sessionIds.filter((id) => typeof id !== "string" || !SAFE_SESSION_ID.test(id));
        if (bad.length > 0) {
          return reply.code(400).send({
            error: `Not a valid session id: ${JSON.stringify(bad[0])}. Nothing was moved.`,
            code: "invalid",
          });
        }

        // An env var shadowing `claude.transcripts` beats the config file, so the
        // commit would be inert: the files would move and the instance would come
        // back on `own` with an empty `.chats/`. Refuse before anything moves.
        if ((process.env[TRANSCRIPTS_ENV_VAR] ?? "").trim().length > 0) {
          return reply.code(400).send({
            error: `${TRANSCRIPTS_ENV_VAR} is set in the environment, which overrides the config file. Unset it and try again — writing claude.transcripts: host would have no effect, and the transcripts would be moved for nothing.`,
            code: "env_shadowed",
            envVar: TRANSCRIPTS_ENV_VAR,
          });
        }

        // STEP 2 — optimistic concurrency, same opt-in shape as the config PUT
        // (#722): a client that sends no `expectedVersion` writes unconditionally.
        const configPath = instanceConfigPath(cfg);
        if (Object.prototype.hasOwnProperty.call(body, "expectedVersion")) {
          const current = instanceConfigVersion(configPath);
          if (current !== (body.expectedVersion ?? null)) {
            return reply.code(409).send({
              error:
                "The config file changed on disk since the migration plan was built. Nothing was moved — reload the plan and try again.",
              code: "config_conflict",
              configVersion: current,
            });
          }
        }

        const built = await input();
        const dryRun = body.dryRun === true;
        const interlock = { hub: ctx.managementOpsContext?.hub, herdctl };

        // STEP 3 — quiesce, concurrently, BEFORE anything moves. A project that
        // will not stop refuses the WHOLE migration rather than going into a
        // `failed` bucket: a chat left behind leaves `.chats/` non-empty, which
        // breaks the flip for its entire project (§4.4). Skipped on a dry run,
        // which by definition mutates nothing.
        if (!dryRun) {
          const stuck = (
            await Promise.all(built.projects.map((p) => quiesceProject(interlock, p.slug)))
          ).flat();
          if (stuck.length > 0) return reply.code(409).send(turnRunningError(stuck));
        }

        // STEPS 4–6.
        const result = await executeMigration({
          ...built,
          sessionIds,
          ...(body.plannedSessionIds ? { plannedSessionIds: body.plannedSessionIds } : {}),
          dryRun,
          pendingMode: pendingTranscriptsMode(cfg),
          // §4.5: `quiesceSession` stops what is running, it does not take a
          // lock, so a turn can start between step 3 and a project's own moves.
          // Re-checked immediately before them, which narrows the window to
          // microseconds without inventing a fleet-wide turn lock (§10.3).
          busySessions: (slug) =>
            (interlock.hub?.runningSessions() ?? [])
              .filter((i) => i.projectSlug === slug)
              .map((i) => i.sessionId),
          commitConfig: async () => {
            // Written straight through `writeInstanceConfig` rather than via
            // `validatePatch`, because `claude.transcripts` is `editable: false`
            // — deliberately, so the lever can only move through this guided
            // flow and never through a raw config PUT that would strand every
            // existing chat. This route IS the sanctioned path.
            writeInstanceConfig(configPath, [{ key: "claude.transcripts", value: "host" }]);
            return instanceConfigVersion(configPath);
          },
        });
        // The probe memoises on `.chats/`'s dirKey plus the config version, both
        // of which this just changed. The key would notice on its own; dropping
        // it explicitly means the banner cannot linger for even one request.
        if (!dryRun) resetMigrationProbeCache();
        return result;
      } finally {
        release();
        migrationInFlight = null;
      }
    },
  );
}
