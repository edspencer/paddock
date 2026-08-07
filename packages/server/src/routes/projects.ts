/**
 * Project routes: the projects CRUD surface (list/create/get/update/delete +
 * notebook→repo promote), the pin/unpin sibling-tab endpoints (#4), and the
 * read-only file/changelog/overview/commands surface (#2/#3/#103/#259). The
 * chat/trigger/git clusters live in their own sibling modules.
 */
import type { FastifyInstance } from "fastify";
import {
  ProjectError,
  ROOT_KEY,
  isRootKey,
  type Project,
  type CreateProjectInput,
  type UpdateProjectInput,
} from "../projects.js";
import { keeperAgentName } from "../herdctl.js";
import {
  isKnownModel,
  isKnownPermissionMode,
  isValidMaxTurns,
  isKnownDriveMode,
  resolveModels,
  MAX_TURNS_LIMIT,
} from "../models.js";
import { isValidMaxSpawnDepth, MAX_SPAWN_DEPTH_LIMIT } from "../spawn-capability.js";
import { sendProjectError } from "../route-errors.js";
import { buildProjectChats, makeTriggerResolver, makeParentResolver } from "../chat-dto.js";
import type { RouteCtx } from "../route-context.js";
import { quiesceProject, turnRunningError } from "../turn-interlock.js";

/** One entry of a workspace's compact `chatTurns` list (see {@link buildChatTurns}). */
export interface ChatTurnSummary {
  sessionId: string;
  lastTurnCompletedAt: string;
  lastSeen?: number;
  unread?: boolean;
}

/**
 * Build ONE workspace's compact `{ sessionId, lastTurnCompletedAt, lastSeen?,
 * unread? }` list — the sidebar's UNREAD-badge feed (#161), server-backed (#189).
 *
 * Extracted so the root workspace and every project are literally the same fold
 * (#553): the badge's semantics are "whatever this function returns", and there
 * is no second implementation for the root to drift from. The completed-turn
 * side comes from the cheap job-record scan (grouped by keeper agent), so this
 * costs no transcript parse; `live` adds one cached session listing per
 * workspace (see {@link liveSessionIds}).
 *
 * Two things are pruned OUT of the raw job-record fold, and the invariant they
 * add up to is: **the badge counts exactly what the Home Unread feed counts.**
 * A chat that no longer exists, and a chat the user archived. #488 made read
 * state server-authoritative so surfaces could not diverge; a badge counting
 * chats `/chats/attention` does not is that divergence one layer up.
 *
 * `key` is a WORKSPACE key, so `""` (the root) is a perfectly ordinary argument:
 * `turnsByProject` is already keyed that way (`lastTurnCompletedAtByProject`
 * compares `keeperSlugFromAgent(...) === null`, not falsiness) and
 * `keeperAgentName("")` encodes to `keeper-_root`. Nothing here may test `key`
 * for truthiness.
 */
async function buildChatTurns(
  key: string,
  turnsByProject: Map<string, Map<string, string>>,
  live: Set<string> | null,
  user: string | null,
  readState: RouteCtx["readState"],
  unread: RouteCtx["unread"],
  archive: RouteCtx["archive"],
): Promise<ChatTurnSummary[]> {
  const bySession = turnsByProject.get(key);
  if (!bySession) return [];
  const keeper = keeperAgentName(key);
  const rows = await Promise.all(
    [...bySession].map(async ([sessionId, lastTurnCompletedAt]) => {
      // #732, prune 1 — a chat that no longer exists. The job records this fold
      // reads are removed with the chat now, but that cannot heal a badge
      // already stuck, and a transcript can leave by routes that are not a
      // delete at all (an adoption undone, a JSONL removed by hand). `live` is
      // `null` when the listing FAILED, which is not the same as empty: an
      // unreadable chat store must leave the badge alone, not silently zero it.
      if (live && !live.has(sessionId)) return null;
      // #732, prune 2 — archiving is the user saying "stop bothering me about
      // this one", and `/chats/attention` has always honoured that. The badge
      // did not, so the sidebar could read 3 while the Home Unread feed showed
      // nothing. One rule, both surfaces: archived is silent. It is silenced,
      // not consumed — unarchiving brings the chat back to both.
      if (await archive.isArchived(keeper, sessionId).catch(() => false)) return null;
      const lastSeen = await readState.getLastSeen(user, keeper, sessionId).catch(() => 0);
      // Manual unread override (#458): carry it so the sidebar's workspace
      // unread badge counts a manually-flagged chat, staying in step with
      // the per-chat unread dot (which folds the same flag in).
      const isUnread = await unread.isUnread(user, keeper, sessionId).catch(() => false);
      return {
        sessionId,
        lastTurnCompletedAt,
        ...(lastSeen ? { lastSeen } : {}),
        ...(isUnread ? { unread: true } : {}),
      };
    }),
  );
  return rows.filter((r): r is ChatTurnSummary => r !== null);
}

/**
 * The session ids a workspace actually still has, for {@link buildChatTurns}'s
 * prune — or `null` if we could not find out.
 *
 * That distinction is the whole point: a failed listing must NOT be read as "no
 * chats", or a transient discovery error would empty the badge instead of
 * leaving it alone. `listSessions` is a superset of the keeper chats the fold
 * covers (it also returns hook-agent chats), which is the safe direction — it
 * can only fail to prune, never over-prune.
 *
 * This costs one session listing per workspace on `GET /api/projects`, which
 * #529 was careful to keep off this route. It is affordable because it is not
 * the expensive half: the listing is a cached directory read (core's discovery
 * cache is mtime-keyed with a TTL), whereas the 61%-of-CPU problem #529 fixed
 * was YAML-parsing every job record. `/chats/attention` already does exactly
 * this listing across the whole fleet on the Home tab.
 */
async function liveSessionIds(
  herdctl: RouteCtx["herdctl"],
  project: Project | null,
): Promise<Set<string> | null> {
  if (!project) return null;
  try {
    return new Set((await herdctl.listSessions(project)).map((s) => s.sessionId));
  } catch {
    return null;
  }
}

export function registerProjectRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const { projects, herdctl, git, readState, unread, archive, readStateUser } = ctx;

  app.get(
    "/api/projects",
    {
      schema: {
        tags: ["Projects"],
        summary: "List projects",
        description:
          "Returns `{ projects, root }`. `projects` is an array of the root workspace's CHILDREN; each entry carries the project metadata plus a compact `chatTurns` array (per-chat `{ sessionId, lastTurnCompletedAt, lastSeen? }` for the sidebar UNREAD count) and a `dirty` uncommitted-file count. `chatTurns` covers only chats that still EXIST and are not ARCHIVED, so the badge cannot outlive its chats (#732) and agrees with `/chats/attention` on archived ones. `root` is the ROOT workspace itself, carrying the same `chatTurns` field so the sidebar's Home entry gets the identical badge; it is `null` only if the root record could not be read.",
        response: {
          200: {
            description:
              "Object with a `projects` array (each item a project enriched with `chatTurns` and `dirty`) and a `root` workspace object enriched with `chatTurns`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req) => {
    // Fold a compact per-workspace list of `{ sessionId, lastTurnCompletedAt,
    // lastSeen }` into the payload so the sidebar can compute each workspace's
    // UNREAD count (#161) server-backed (#189) — see `buildChatTurns`.
    //
    // The ROOT workspace rides along here rather than on its own endpoint (#553).
    // `GET /api/projects` enumerates the root's CHILDREN, so the root can't be an
    // array member without turning up in the grid and the sidebar project list —
    // but it IS the sidebar's other badge-bearing row, and `lastTurnCompletedAtByProject`
    // already grouped its chats under the `""` key. Putting it in the same response,
    // through the same fold, is what keeps Home and a project row on one code path.
    const [list, root, turnsByProject, dirty] = await Promise.all([
      projects.list(),
      // The root always exists; tolerate a read failure rather than 500 the
      // whole list, exactly as the client's separate fetch used to.
      projects.get(ROOT_KEY).catch(() => null),
      herdctl.lastTurnCompletedAtByProject().catch(() => new Map<string, Map<string, string>>()),
      // Uncommitted-file count per project subtree — one cheap `git status` over
      // the whole store, drives the projects-grid "N uncommitted" chip (#258).
      git.dirtyCounts().catch(() => ({}) as Record<string, number>),
    ]);
    const user = readStateUser(req);
    const projectsOut = await Promise.all(
      list.map(async (p) => ({
        ...p,
        chatTurns: await buildChatTurns(
          p.slug,
          turnsByProject,
          await liveSessionIds(herdctl, p),
          user,
          readState,
          unread,
          archive,
        ),
        // The cheap store-wide sweep above buckets by path segment under
        // `projectsRoot`, so it can only speak for projects whose working dir is
        // the metadata dir. For one pointing somewhere else (a linked checkout,
        // issue #206) ask its own repo directly — a subprocess, but only for the
        // projects the sweep structurally cannot cover, and only for as many of
        // those as actually exist.
        dirty:
          p.workingDir === p.dir
            ? (dirty[p.slug] ?? 0)
            : await git.dirtyCountAt(p.workingDir).catch(() => 0),
      })),
    );
    // No `dirty` for the root: `dirtyCounts()` buckets by first path segment, so
    // a file directly in the projects root has no bucket at all. Reporting 0
    // would be a fabricated clean; the field is optional, so it stays absent.
    const rootOut = root
      ? {
          ...root,
          chatTurns: await buildChatTurns(
            ROOT_KEY,
            turnsByProject,
            await liveSessionIds(herdctl, root),
            user,
            readState,
            unread,
            archive,
          ),
        }
      : null;
    return { projects: projectsOut, root: rootOut };
  });


  app.post<{ Body: CreateProjectInput }>(
    "/api/projects",
    {
      schema: {
        tags: ["Projects"],
        summary: "Create a project",
        description:
          "Creates a project from `CreateProjectInput` and registers its agent and its sweeper. Set `repo` to create a repo-backed project (the cloned checkout becomes the agent's working directory), or `path` to LINK an existing on-box git checkout used in place with no copy (that directory becomes the working directory and Paddock writes nothing into it); omit both for a notebook project. Responds 201 with `{ project }`.",
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            name: { description: "Human-readable project name." },
            slug: { description: "URL slug (derived from name if omitted)." },
            status: { description: "Project status." },
            domain: {
              description: "Domain tags for the project.",
            },
            group: { description: "Group the project belongs to." },
            visibility: { description: "Project visibility." },
            summary: { description: "Short project summary." },
            links: {
              description: "Related links for the project.",
            },
            repo: {
              description: "External git repo URL to back this project (repo-backed if set).",
            },
            path: {
              description:
                "Absolute path to the directory this project's content lives in (issue #206). For an unmanaged project this LINKS an existing on-box checkout, used in place with no copy. If it does not exist, Paddock clones `repo` into it when one is given, or creates it for a managed project. Must lie outside the projects root, the data dir, and every other project's working directory. No git repository is required. Immutable once set.",
            },
            managed: {
              description:
                "Whether Paddock curates this project's own CLAUDE.md/OVERVIEW.md/CHANGELOG.md (issue #206). Omit to derive it: a create naming `repo` or `path` is unmanaged, a plain one is managed. `managed: true` together with `repo` is rejected.",
            },
          },
          required: [],
        },
        response: {
          201: {
            description: "Object with the created `project`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
    try {
      const project = await projects.create(req.body ?? ({} as CreateProjectInput));
      // Register the keeper + sweeper agents at runtime (fleet.addAgent).
      try {
        await herdctl.ensureProjectAgent(project);
      } catch (err) {
        req.log.warn({ err }, "keeper-agent registration failed (project still created)");
      }
      return reply.code(201).send({ project });
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });
}

/**
 * The workspace-scoped project routes — everything addressed to ONE workspace.
 *
 * Registered twice by the composition root (see `workspace-mount.ts`): once at
 * `/api/root` for the root workspace and once at `/api/projects/:slug` for a
 * project. Paths here are relative to the workspace; handlers still read
 * `req.params.slug`, which the root mount injects as `""`.
 */
export function registerProjectWorkspaceRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const {
    projects,
    herdctl,
    archive,
    star,
    readState,
    unread,
    parentDetach,
    runProvenance,
    messageProvenance,
    readStateUser,
    cfg,
  } = ctx;

  app.get<{ Params: { slug: string } }>(
    "/",
    {
      schema: {
        tags: ["Projects"],
        summary: "Get a project",
        description:
          "Returns `{ project, changelog, overview, chats }` — the project metadata, its raw CHANGELOG.md and OVERVIEW.md text (empty strings when absent), and its chats (sessions) enriched with archived/starred/last-seen/provenance/trigger flags. Per-chat usage rings are filled separately by the client.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
        response: {
          200: {
            description:
              "Object with `project`, `changelog` text, `overview` text, and a `chats` array.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
    try {
      const project = await projects.get(req.params.slug);
      // Enrich with changelog text + the project's chats (sessions).
      const [changelog, overview, sessions, lastTurnAt] = await Promise.all([
        projects.readFile(project.slug, "CHANGELOG.md").catch(() => ""),
        // OVERVIEW.md rides along with CHANGELOG.md (#599): Home renders both as
        // sibling collapsible cards, so fetching them together is one request
        // instead of two and they can never render a beat apart. `""` when the
        // workspace has no overview yet — the same "absent reads as empty"
        // contract the changelog above has always had.
        projects.readOverview(project.slug).catch(() => ""),
        herdctl.listSessions(project).catch(() => []),
        herdctl.lastTurnCompletedAt().catch(() => new Map<string, string>()),
      ]);
      const keeper = keeperAgentName(project.slug);
      const archivedOf = (s: import("@herdctl/core").DiscoveredSession) =>
        archive.isArchived(keeper, s.sessionId);
      const starredOf = (s: import("@herdctl/core").DiscoveredSession) =>
        star.isStarred(keeper, s.sessionId);
      const user = readStateUser(req);
      const lastSeenOf = (s: import("@herdctl/core").DiscoveredSession) =>
        readState.getLastSeen(user, keeper, s.sessionId);
      // Manual unread override (#458): the per-user "mark unread" flag, resolved
      // inline like the read-state above (a cheap in-memory sidecar read).
      const unreadOf = (s: import("@herdctl/core").DiscoveredSession) =>
        unread.isUnread(user, keeper, s.sessionId);
      // Provenance badge (#267): how each chat was created — human / scheduled /
      // spawned (A1's #261 marker). A cheap in-memory map read, so unlike the
      // usage ring (#116) it's fine to resolve inline for the initial payload.
      const provenanceOf = (s: import("@herdctl/core").DiscoveredSession) =>
        runProvenance.get(s.sessionId);
      // Trigger capability descriptor for trigger chats (Epic T / T4) — truthful from
      // the registered trigger agent config. A no-op for the keeper chats that dominate.
      const triggerOf = makeTriggerResolver(project);
      // Parent edge for the nested chat list: an explicit detach (#508) wins, else
      // the recorded RunProvenance edge, else a backfill from who injected the
      // kickoff prompt. All three are in-memory sidecar reads.
      const parentOf = makeParentResolver(runProvenance, messageProvenance, project.slug, (id) =>
        parentDetach.isDetached(keeper, id),
      );
      // Deliberately NO usage resolver here (issue #116): the per-chat context
      // ring requires streaming+parsing each session's full transcript, which is
      // O(chats × transcript size) and blocked the whole ProjectView from
      // rendering (2–3s on chat-heavy projects). Chats come back immediately from
      // cached name/preview/mtime; the client fills rings in afterwards via the
      // separate GET .../chats/usage endpoint below.
      return {
        project,
        changelog,
        overview,
        chats: await buildProjectChats(
          project.dir,
          sessions,
          undefined,
          archivedOf,
          lastTurnAt,
          lastSeenOf,
          provenanceOf,
          triggerOf,
          starredOf,
          unreadOf,
          parentOf,
        ),
      };
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  app.patch<{ Params: { slug: string }; Body: UpdateProjectInput }>(
    "/",
    {
      schema: {
        tags: ["Projects"],
        summary: "Update a project",
        description:
          "Applies an `UpdateProjectInput` partial and re-registers the project's agent. Agent overrides (`model`, `permissionMode`, `maxTurns`, `docker`, `driveMode`, `maxSpawnDepth`, `hooksMcpEnabled`) are validated at runtime — an invalid value returns 400. Tri-state override fields accept `null` to clear the override. Responds with `{ project }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            name: { description: "Human-readable project name." },
            status: { description: "Project status." },
            domain: {
              description: "Domain tags.",
            },
            group: { description: "Group the project belongs to." },
            visibility: { description: "Project visibility." },
            summary: { description: "Short project summary." },
            links: {
              description: "Related links.",
            },
            model: { description: "Agent model override (validated at runtime)." },
            permissionMode: {
              description: "Agent permission mode override (validated at runtime).",
            },
            maxTurns: {
              description: "Agent max-turns override (validated at runtime).",
            },
            docker: { description: "Whether the agent runs in Docker." },
            driveMode: {
              description: "Drive-mode override; `null` clears it.",
            },
            maxSpawnDepth: {
              description: "Max spawn-depth override; `null` clears it.",
            },
            hooksMcpEnabled: {
              description: "Hook-management MCP override; `null` clears it.",
            },
            recovery: {
              description: "Chat-recovery override object; `null` clears it.",
            },
            attachments: {
              description: "Inbound-attachment override object; `null` clears it.",
            },
            curation: {
              description: "Sweeper-curation budget override object; `null` clears it.",
            },
          },
          required: [],
        },
        response: {
          200: {
            description: "Object with the updated `project`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const body = req.body ?? {};
        // Validate explicit keeper-agent overrides before touching disk (400 if
        // bad) — these re-register the keeper, so a bad value must not persist.
        if (body.model !== undefined && !isKnownModel(body.model)) {
          return reply.code(400).send({ error: `Unknown model: ${body.model}`, code: "invalid" });
        }
        // Offered-models allow-list (issue #457 Step 2). `null` / an empty array is
        // valid — it clears the per-project override (offer the instance list). A
        // non-empty array must be a subset of the instance allow-list: each id must
        // be a known catalog model AND currently offered by the instance (an
        // operator can't offer a project a model the instance itself hides).
        if (body.models !== undefined && body.models !== null) {
          if (!Array.isArray(body.models)) {
            return reply.code(400).send({ error: "models must be an array of ids", code: "invalid" });
          }
          const offered = new Set(resolveModels(cfg.models).map((m) => m.id));
          for (const id of body.models) {
            if (typeof id !== "string" || !isKnownModel(id)) {
              return reply.code(400).send({ error: `Unknown model: ${String(id)}`, code: "invalid" });
            }
            if (!offered.has(id)) {
              return reply.code(400).send({
                error: `Model not offered by this instance: ${id}`,
                code: "invalid",
              });
            }
          }
        }
        if (body.permissionMode !== undefined && !isKnownPermissionMode(body.permissionMode)) {
          return reply
            .code(400)
            .send({ error: `Unknown permission mode: ${body.permissionMode}`, code: "invalid" });
        }
        if (body.maxTurns !== undefined && !isValidMaxTurns(body.maxTurns)) {
          return reply
            .code(400)
            .send({ error: `max_turns must be an integer 1–${MAX_TURNS_LIMIT}`, code: "invalid" });
        }
        if (body.docker !== undefined && typeof body.docker !== "boolean") {
          return reply.code(400).send({ error: "docker must be a boolean", code: "invalid" });
        }
        // `null` is valid — it clears the per-project override (inherit the
        // global default, issue #122). Only a non-null, unknown string is a 400.
        if (
          body.driveMode !== undefined &&
          body.driveMode !== null &&
          !isKnownDriveMode(body.driveMode)
        ) {
          return reply
            .code(400)
            .send({ error: `Unknown drive mode: ${body.driveMode}`, code: "invalid" });
        }
        // `null` is valid — it clears the per-project override (inherit the
        // instance default, #262). Only a non-null, out-of-range value is a 400.
        if (
          body.maxSpawnDepth !== undefined &&
          body.maxSpawnDepth !== null &&
          !isValidMaxSpawnDepth(body.maxSpawnDepth)
        ) {
          return reply.code(400).send({
            error: `max_spawn_depth must be an integer 0–${MAX_SPAWN_DEPTH_LIMIT}`,
            code: "invalid",
          });
        }
        // `null` clears the per-project hook-MCP override (inherit the instance
        // default, G5). Only a non-null, non-boolean value is a 400.
        if (
          body.hooksMcpEnabled !== undefined &&
          body.hooksMcpEnabled !== null &&
          typeof body.hooksMcpEnabled !== "boolean"
        ) {
          return reply
            .code(400)
            .send({ error: "hooks_mcp_enabled must be a boolean", code: "invalid" });
        }
        const project = await projects.update(req.params.slug, body);
        // Re-register the keeper so the new model takes effect (the keeper is a
        // long-lived in-memory agent; addAgent replace:true updates its config).
        try {
          await herdctl.ensureProjectAgent(project);
        } catch (err) {
          req.log.warn({ err }, "keeper-agent re-registration failed after update");
        }
        return { project };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Delete a project: remove its directory and unregister its keeper + sweeper
  // agents at runtime (fleet.removeAgent) — the inverse of the create flow.
  app.delete<{ Params: { slug: string } }>(
    "/",
    {
      schema: {
        tags: ["Projects"],
        summary: "Delete a project",
        description:
          "Removes the project directory and unregisters its agent and its sweeper (the inverse of create). Responds with `{ ok: true, slug }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
        response: {
          200: {
            description: "Object with `ok: true` and the deleted project `slug`.",
            type: "object",
            additionalProperties: true,
          },
          409: {
            description:
              "`{ code: 'turn_running', sessionIds }` — one or more of the project's chats has a turn that could not be stopped, so nothing was deleted (#731).",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
    try {
      // #731: a project delete takes every chat in it, so it races the same live
      // writers a chat delete does — and the orphaned `claude` was observed
      // running on with a cwd of `…/<slug> (deleted)`. Stop them all first, and
      // refuse rather than remove the directory out from under one.
      //
      // `remove()` refuses the ROOT workspace, and a refusal must not have killed
      // the root's live turns on the way to saying no — so that one check comes
      // first, mirroring the guard in `remove()` rather than duplicating its
      // error.
      if (!isRootKey(req.params.slug)) {
        const stuck = await quiesceProject(
          { hub: ctx.managementOpsContext?.hub, herdctl },
          req.params.slug,
        );
        if (stuck.length > 0) return reply.code(409).send(turnRunningError(stuck));
      }
      const project = await projects.remove(req.params.slug); // throws not_found / refuses root
      try {
        await herdctl.removeProjectAgent(
          project.slug,
          Object.keys(project.hooks ?? {}),
          Object.keys(project.triggers ?? {}),
        );
      } catch (err) {
        req.log.warn({ err }, "keeper-agent unregister failed (project dir already removed)");
      }
      // #734: and its herdctl JOB RECORDS, which `remove()` cannot reach — they
      // live in the shared fleet-wide jobs dir, not under the project. They are
      // keyed by agent name, which is derived from the slug, which is derived
      // from the NAME: leaving them behind means a project created later with
      // the same name inherits this one's run history — prompt text and reply
      // summaries — plus a phantom unread badge over zero chats.
      await herdctl
        .purgeProjectJobs(
          project.slug,
          Object.keys(project.hooks ?? {}),
          Object.keys(project.triggers ?? {}),
        )
        .catch((err: unknown) => {
          req.log.warn({ err }, "job-record purge failed (project is still deleted)");
        });
      return reply.code(200).send({ ok: true, slug: project.slug });
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  // Promote a NOTEBOOK project into a REPO-BACKED one in place (issue #213):
  // clone the given repo into the nested checkout, flip the keeper's cwd to it,
  // and re-register the keeper (which re-symlinks the new cwd's transcript path at
  // the project's existing `.chats/` store, so every chat stays listed + resumable).
  // The project's chats + sidecar metadata (OVERVIEW/CHANGELOG/settings) are kept.
  // On clone failure the notebook is left wholly intact (rollback in `promote()`).
  app.post<{ Params: { slug: string }; Body: { repo?: string } }>(
    "/promote",
    {
      schema: {
        tags: ["Projects"],
        summary: "Promote a notebook project to repo-backed",
        description:
          "Clones `repo` into the project's nested checkout, flips the agent's working directory to it, and re-registers the agent (keeping existing chats + metadata). A missing/blank `repo` returns 400; clone failure rolls back to the intact notebook. Responds with `{ project }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            repo: {
              description: "Git repo URL to clone and back the project with.",
            },
          },
          required: [],
        },
        response: {
          200: {
            description: "Object with the promoted `project`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const repo = req.body?.repo;
        if (typeof repo !== "string" || !repo.trim()) {
          return reply.code(400).send({ error: "A repo URL is required", code: "invalid" });
        }
        const project = await projects.promote(req.params.slug, repo);
        // Re-register the keeper at the NEW working dir (the checkout) and re-symlink
        // its transcript path at the project's `.chats/` — this is what keeps the
        // existing chats listed + resumable under the new cwd (issue #213 #1).
        try {
          await herdctl.ensureProjectAgent(project);
        } catch (err) {
          req.log.warn({ err }, "promote: keeper re-registration failed (project still promoted)");
        }
        return reply.code(200).send({ project });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // One level of a project's file tree (issue #259). `?path=<subpath>` descends
  // into a subdirectory ("" / omitted = the project root). The response is a
  // discriminated union on `kind`: a directory returns its `entries` (each with
  // its own file|dir kind, dirs sorted first) so the Files tab can navigate into
  // folders; a path that names a FILE returns `{ kind: "file", entries: [] }`
  // (200, not an error — so the client can drop straight into the viewer without
  // a noisy 409). Path-traversal guarded by ProjectStore.resolveInProject.
  app.get<{ Params: { slug: string }; Querystring: { path?: string } }>(
    "/files",
    {
      schema: {
        tags: ["Projects"],
        summary: "List one level of a project's file tree",
        description:
          "Lists a single directory level. `?path=<subpath>` descends into a subdirectory (omitted/empty = project root). Returns `{ path, kind, entries }`: a directory yields `kind: \"dir\"` with `entries` (dirs first); a path naming a file yields `kind: \"file\"` with empty `entries` (200, not an error).",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
        querystring: {
          type: "object",
          additionalProperties: true,
          properties: {
            path: {
              type: "string",
              description: "Subpath to descend into; omitted/empty = project root.",
            },
          },
        },
        response: {
          200: {
            description: "Object with `path`, `kind` (\"dir\" | \"file\"), and an `entries` array.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        await projects.get(req.params.slug);
        const subpath = req.query.path ?? "";
        try {
          const entries = await projects.listFiles(req.params.slug, subpath);
          return { path: subpath, kind: "dir", entries };
        } catch (err) {
          // `subpath` is a file, not a directory — a valid target, just rendered
          // by the single-file viewer rather than listed.
          if (err instanceof ProjectError && err.code === "not_directory") {
            return { path: subpath, kind: "file", entries: [] };
          }
          throw err;
        }
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/changelog",
    {
      schema: {
        tags: ["Projects"],
        summary: "Get a project's CHANGELOG.md",
        description:
          "Returns the raw CHANGELOG.md text with content-type `text/markdown; charset=utf-8` (empty string if none). No response schema — the body is raw markdown text, not JSON.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
      },
    },
    async (req, reply) => {
    try {
      await projects.get(req.params.slug);
      const content = await projects.readFile(req.params.slug, "CHANGELOG.md").catch(() => "");
      reply.header("content-type", "text/markdown; charset=utf-8");
      return content;
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  // Raw OVERVIEW.md (the sweep-curated current-state context). Returns "" if
  // the project has no overview yet (issue #2).
  app.get<{ Params: { slug: string } }>(
    "/overview",
    {
      schema: {
        tags: ["Projects"],
        summary: "Get a project's OVERVIEW.md",
        description:
          "Returns the raw OVERVIEW.md text (sweep-curated current-state context) with content-type `text/markdown; charset=utf-8`; empty string if the project has no overview yet. No response schema — the body is raw markdown text, not JSON.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
      },
    },
    async (req, reply) => {
    try {
      await projects.get(req.params.slug); // 404s for unknown slug
      const content = await projects.readOverview(req.params.slug);
      reply.header("content-type", "text/markdown; charset=utf-8");
      return content;
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  // Slash commands available to a project's keeper agent, for the composer's
  // autocomplete menu (issue #103). Built-ins (`/compact`, `/clear`, …) plus the
  // project's `.claude/commands` and any MCP-provided commands. NOT per-session —
  // a dedicated endpoint mirroring GET /api/models, not part of toChatDto. The
  // underlying listAgentCommands spawns a short-lived `claude` subprocess, so the
  // service memoizes the result per agent (see HerdctlService.listCommands).
  app.get<{ Params: { slug: string } }>(
    "/commands",
    {
      schema: {
        tags: ["Projects"],
        summary: "List a project's slash commands",
        description:
          "Returns `{ commands }` — the slash commands available to the project's agent (built-ins plus the project's `.claude/commands` and MCP-provided commands) for composer autocomplete. Result is memoized per agent.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
        response: {
          200: {
            description: "Object with a `commands` array.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
    try {
      await projects.get(req.params.slug); // 404s for unknown slug
      const commands = await herdctl.listCommands(keeperAgentName(req.params.slug));
      return { commands };
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  // Single file content + a render-kind hint (markdown | html | text | image),
  // derived from the extension. Path-traversal guarded by ProjectStore. Feeds the
  // UI's markdown/Mermaid + sandboxed-iframe renderers (issue #3).
  //
  // With `?raw=1` it instead streams the file's RAW BYTES with the correct
  // Content-Type (issue #61) — how the image viewer loads an <img>, so binary
  // bytes are no longer mangled by UTF-8 decoding. Byte responses are locked
  // down (CSP sandbox + nosniff + inline disposition) so a directly-opened SVG
  // or HTML file can't execute script in the app's origin.
  app.get<{ Params: { slug: string; name: string }; Querystring: { raw?: string } }>(
    "/files/:name",
    {
      schema: {
        tags: ["Projects"],
        summary: "Get a single project file",
        description:
          "Dual-mode. By default returns JSON with the file content plus a render-kind hint (markdown | html | text | image). With `?raw=1` it instead STREAMS the file's raw bytes with the correct Content-Type (locked down: sandbox CSP + nosniff + inline disposition) — how the image viewer loads an `<img>`. No response schema is declared so the raw byte stream is never corrupted.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            name: { type: "string", description: "URL-encoded file name." },
          },
          required: ["slug", "name"],
        },
        querystring: {
          type: "object",
          additionalProperties: true,
          properties: {
            raw: {
              type: "string",
              description: "Set to a truthy value (e.g. `1`) to stream raw bytes instead of JSON.",
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        await projects.get(req.params.slug); // 404s for unknown slug
        const name = decodeURIComponent(req.params.name);
        if (req.query.raw !== undefined && req.query.raw !== "0" && req.query.raw !== "false") {
          const { bytes, mime } = await projects.readFileBytes(req.params.slug, name);
          return reply
            .header("content-type", mime)
            .header("content-disposition", "inline")
            .header("x-content-type-options", "nosniff")
            .header("content-security-policy", "sandbox; default-src 'none'")
            .header("cache-control", "private, max-age=60")
            .send(bytes);
        }
        return await projects.readFileWithKind(req.params.slug, name);
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Pin a file as a sibling tab (issue #4). Validates the file exists + dedupes.
  app.put<{ Params: { slug: string }; Body: { file?: string } }>(
    "/pins",
    {
      schema: {
        tags: ["Projects"],
        summary: "Pin a file as a sibling tab",
        description:
          "Pins `file` as a sibling tab (validates the file exists + dedupes). Responds with `{ project }` reflecting the updated pins.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            file: { description: "Path of the file to pin." },
          },
          required: [],
        },
        response: {
          200: {
            description: "Object with the updated `project`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await projects.pinFile(req.params.slug, req.body?.file ?? "");
        return { project };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Unpin a file (URL-encoded name) (issue #4).
  app.delete<{ Params: { slug: string; file: string } }>(
    "/pins/:file",
    {
      schema: {
        tags: ["Projects"],
        summary: "Unpin a file",
        description:
          "Removes the pin for the given URL-encoded file `name`. Responds with `{ project }` reflecting the updated pins.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            file: { type: "string", description: "URL-encoded name of the pinned file to remove." },
          },
          required: ["slug", "file"],
        },
        response: {
          200: {
            description: "Object with the updated `project`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await projects.unpinFile(
          req.params.slug,
          decodeURIComponent(req.params.file),
        );
        return { project };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );
}