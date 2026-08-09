/**
 * Chat (session) routes: the project-chat cluster (list / runs / usage / create /
 * messages / subagents / context / delete / rename / fork / archive / star / seen /
 * unread / promote). Chat SENDING happens over WS; these are the REST reads +
 * lifecycle mutations.
 *
 * Every route here is workspace-scoped and mounted twice (`/api/root` and
 * `/api/projects/:slug`), so the root — whose key is `""` — is served by these
 * same handlers with no special-casing.
 */
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { PathTraversalError, type DiscoveredSession } from "@herdctl/core";
import { keeperAgentName } from "../herdctl.js";
import { ROOT_KEY } from "../projects.js";
import { applyMessageProvenance } from "../message-provenance.js";
import { buildProjectRuns } from "../runs.js";
import { DEFAULT_MODEL } from "../models.js";
import { projectChatsDir } from "../transcripts.js";
import { readSubagentMessages, readSessionTokenUsageWithSubagents } from "../subagents.js";
import { readContextSeries } from "../usage.js";
import { enrichWithToolDetails } from "../tooldetails.js";
import { scanTranscriptNotice } from "../turn-notice.js";
import { type RunProvenance, childOf, HUMAN_ROOT, ADOPTED_ROOT } from "../run-provenance.js";
import { sendProjectError } from "../route-errors.js";
import { mapWithConcurrency, FILE_FANOUT_CONCURRENCY } from "../concurrency.js";
import {
  type ChatUsage,
  type ChatUsageScope,
  CHAT_USAGE_SCOPES,
  SAFE_SESSION_ID,
  RUNS_SEEN_SESSION,
  clampRunsLimit,
  toChatUsage,
  buildProjectChats,
  makeTriggerResolver,
  makeParentResolver,
  normalizeBatchSessionIds,
  BATCH_SESSIONS_MAX,
} from "../chat-dto.js";
import type { RouteCtx } from "../route-context.js";
import { quiesceSession, turnRunningError } from "../turn-interlock.js";

/**
 * Workspace-scoped chat routes: paths are declared RELATIVE to the workspace
 * (e.g. `/chats/:sessionId`), and this plugin is mounted TWICE — once at
 * `/api/root` and once at `/api/projects/:slug` (see `workspace-mount.ts`).
 *
 * Handlers still read `req.params.slug`; the root mount injects `slug: ""` in an
 * `onRequest` hook, which runs before params validation, so the `required:
 * ["slug"]` schemas below keep validating unchanged on both mounts.
 */
export function registerChatWorkspaceRoutes(app: FastifyInstance, ctx: RouteCtx): void {
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
    events,
    readStateUser,
    agentForSlug,
    projectDirForSlug,
    cleanupAttachments,
    chatUsageResolver,
  } = ctx;

  /**
   * The single 400 for a batch route whose `sessionIds` body is unusable —
   * missing, empty, over the cap, or holding an id that isn't path-safe. Batch
   * validation is all-or-nothing (see {@link normalizeBatchSessionIds}), so this
   * is the only failure shape those routes have.
   */
  const sendBadBatch = (reply: FastifyReply) =>
    reply.code(400).send({
      error: `sessionIds must be an array of 1-${BATCH_SESSIONS_MAX} valid session ids`,
      code: "bad_request",
    });

  /**
   * Does this session have a live turn right now? The session hub is the only
   * thing that knows (a running turn is in-memory state, not something any
   * sidecar or job record has yet), and REST reaches it through the same
   * context the MCP surface's `list_chats` uses.
   *
   * The context is optional in the dep bag, so a server built without the WS
   * layer reports "nothing is running" rather than throwing — the attention
   * feed then degrades to its unread half instead of 500ing.
   */
  const isRunning = (sessionId: string): boolean =>
    ctx.managementOpsContext?.hub.isRunning(sessionId) ?? false;

  /**
   * The interlock every DESTRUCTIVE chat route runs first (issue #731).
   *
   * `claude` writes the transcript itself, so unlinking or rewriting it while a
   * turn is live does not remove the chat — the surviving process re-creates the
   * file from its own tail and the chat comes back with its history gone. These
   * routes therefore stop the turn and WAIT for it to be dead before touching a
   * byte; `stuck` means we could not confirm that, and the only safe answer then
   * is to refuse.
   */
  const interlock = { hub: ctx.managementOpsContext?.hub, herdctl };

  // --- chats (sessions) --------------------------------------------------

  app.get<{ Params: { slug: string } }>(
    "/chats",
    {
      schema: {
        tags: ["Chats"],
        summary: "List a project's chats",
        description:
          "Returns the project's chats (sessions) with per-chat metadata (name, last-turn time, archived/starred flags, last-seen watermark, run provenance, trigger info). Usage rings are fetched separately (see GET /api/projects/:slug/chats/usage). Response: an object `{ chats: [...] }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
        response: {
          200: {
            description: "Object `{ chats }` where `chats` is an array of chat DTOs.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
    try {
      const project = await projects.get(req.params.slug);
      const [sessions, lastTurnAt] = await Promise.all([
        herdctl.listSessions(project).catch(() => []),
        herdctl.lastTurnCompletedAt().catch(() => new Map<string, string>()),
      ]);
      const keeper = keeperAgentName(project.slug);
      const archivedOf = (s: DiscoveredSession) => archive.isArchived(keeper, s.sessionId);
      const starredOf = (s: DiscoveredSession) => star.isStarred(keeper, s.sessionId);
      const user = readStateUser(req);
      const lastSeenOf = (s: DiscoveredSession) =>
        readState.getLastSeen(user, keeper, s.sessionId);
      const unreadOf = (s: DiscoveredSession) => unread.isUnread(user, keeper, s.sessionId);
      const provenanceOf = (s: DiscoveredSession) => runProvenance.get(s.sessionId);
      const triggerOf = makeTriggerResolver(project);
      // Parent edge for the nested chat list: an explicit detach (#508) wins, else
      // the recorded RunProvenance edge, else a backfill from who injected the
      // kickoff prompt. All three are in-memory sidecar reads.
      const parentOf = makeParentResolver(runProvenance, messageProvenance, project.slug, (id) =>
        parentDetach.isDetached(keeper, id),
      );
      // No usage resolver — see the GET /api/projects/:slug route (issue #116).
      // Usage rings are fetched separately so a list refresh stays cheap.
      return {
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

  // --- the Home tab's attention feed (#599) ----------------------------------

  /**
   * The chats in this workspace's SUBTREE that want the user's attention right
   * now: the ones with a live turn, and the ones holding an unread reply.
   *
   * Subtree, not workspace, is what makes root Home fleet-wide and a project's
   * Home project-scoped through ONE handler. A workspace's key is its path
   * relative to `projectsRoot`, so its descendants are exactly the workspaces
   * whose key it prefixes — and the root's key is `""`, which prefixes every
   * key there is. The root therefore sweeps the whole fleet and a (leaf)
   * project sweeps only itself, with no branch on the key and no second
   * implementation for the root to drift from. Nesting, when it lands, makes an
   * intermediate workspace work for free.
   *
   * `running` is authoritative (the live hub), not inferred from timestamps.
   * `unread` reuses the sidebar badge's derivation — the manual override (#458)
   * or a completed turn newer than the read watermark (#189) — INCLUDING the
   * archived exclusion below.
   *
   * That last part used to be this route's alone: the badge never consulted
   * `ArchiveStore`, so an archived unread chat counted toward the sidebar while
   * being absent from this feed, and the two surfaces disagreed by exactly that
   * set. #732 settled it the way this route already read it — archiving is the
   * user filing a chat away, so it silences both — and `buildChatTurns` now
   * applies the same rule. Keep the two in step: read state was made
   * server-authoritative (#488) so surfaces could not diverge, and a rule that
   * lives in only one of them is that divergence again.
   */
  app.get<{ Params: { slug: string } }>(
    "/chats/attention",
    {
      schema: {
        tags: ["Chats"],
        summary: "List the chats in this workspace's subtree that are running or unread",
        description:
          "Returns `{ running, unread }` — the chats in this workspace AND its descendants that currently have a live turn (`running`) or hold an unread reply (`unread`). Each row is a chat DTO plus the `projectSlug`/`projectName` it belongs to, so a fleet-wide list stays attributable. On the root mount (`/api/root/chats/attention`) the subtree is the whole instance, because the root workspace's key (`\"\"`) prefixes every workspace key; on a project mount it is that project alone. A chat is never in both lists: a live turn hasn't landed a reply yet, so running wins. `running` rows additionally carry resolved `contextTokens`/`contextLimit` so a caller can show a context gauge for live work; `unread` rows do not, because resolving usage streams a transcript per chat and only the running set is bounded by how many turns can be in flight at once.",
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
              "Object `{ running, unread }`, each an array of chat DTOs enriched with `projectSlug` and `projectName`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const self = await projects.get(req.params.slug);
        // Descendants = every workspace this one's key prefixes. The root's key
        // is `""`, so its prefix is `""` and the filter admits everything; a
        // project's prefix is `"<slug>/"`. The `=== ROOT_KEY` test is explicit
        // on purpose — `self.slug ? ... : ...` would take the root down the
        // project branch and silently return an empty fleet.
        const prefix = self.slug === ROOT_KEY ? "" : `${self.slug}/`;
        const all = await projects.list().catch(() => []);
        const subtree = [self, ...all.filter((p) => p.slug !== self.slug && p.slug.startsWith(prefix))];

        const user = readStateUser(req);
        // One shared job-record scan for the whole subtree rather than one per
        // workspace: `lastTurnCompletedAt()` is the cached jobs-dir index, and
        // re-reading it per project is what made the old N-request client
        // fan-out expensive.
        const lastTurnAt = await herdctl.lastTurnCompletedAt().catch(() => new Map<string, string>());

        const running: unknown[] = [];
        const unreadRows: unknown[] = [];
        for (const p of subtree) {
          const sessions = await herdctl.listSessions(p).catch(() => []);
          if (sessions.length === 0) continue;
          const keeper = keeperAgentName(p.slug);
          const archivedOf = (s: DiscoveredSession) => archive.isArchived(keeper, s.sessionId);
          const starredOf = (s: DiscoveredSession) => star.isStarred(keeper, s.sessionId);
          const lastSeenOf = (s: DiscoveredSession) =>
            readState.getLastSeen(user, keeper, s.sessionId);
          const unreadOf = (s: DiscoveredSession) => unread.isUnread(user, keeper, s.sessionId);
          const provenanceOf = (s: DiscoveredSession) => runProvenance.get(s.sessionId);
          const triggerOf = makeTriggerResolver(p);
          const parentOf = makeParentResolver(runProvenance, messageProvenance, p.slug, (id) =>
            parentDetach.isDetached(keeper, id),
          );
          // Usage is deliberately NOT resolved for the whole subtree: it streams
          // a transcript per chat, and this route refetches on every turn
          // boundary across the fleet. A RUNNING chat is the one exception — a
          // caller that shows a context gauge for live work needs its fill, and
          // the running set is bounded by how many turns can be in flight at
          // once (a handful), not by how many chats the instance holds. So the
          // cost stays proportional to live work rather than to history.
          const usageOf = chatUsageResolver(p.dir, p.model ?? DEFAULT_MODEL);
          const usageIfRunning = async (s: DiscoveredSession) =>
            isRunning(s.sessionId) ? usageOf(s) : null;
          const chats = await buildProjectChats(
            p.dir,
            sessions,
            usageIfRunning,
            archivedOf,
            lastTurnAt,
            lastSeenOf,
            provenanceOf,
            triggerOf,
            starredOf,
            unreadOf,
            parentOf,
          );
          for (const c of chats) {
            const row = { ...c, projectSlug: p.slug, projectName: p.name };
            if (isRunning(c.sessionId)) {
              running.push(row);
              continue;
            }
            // Archived chats are filed away on purpose; they stay out of the
            // unread feed so archiving is a real way to silence a chat. A
            // RUNNING archived chat still shows — it is live work either way.
            if (c.archived) continue;
            const completed = c.lastTurnCompletedAt ? Date.parse(c.lastTurnCompletedAt) : NaN;
            const seen = c.lastSeen ?? 0;
            if (c.unread || (Number.isFinite(completed) && completed > seen)) unreadRows.push(row);
          }
        }
        return { running, unread: unreadRows };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // --- run history: "while you were away" (E3 / #268 / DD-6) ------------------
  // A project-level view of what ran unattended (scheduled + spawned) plus human
  // runs, sourced from herdctl job records (listProjectRuns) joined with the A1
  // provenance marker (#261) for true origin/depth. Cost is a P3 seam (null).
  //
  // The since-last-visit digest reuses the read-state watermark (#189): a per-
  // user "runs last seen" epoch keyed under the keeper agent with the reserved
  // sentinel session id below (a plain UUID can't contain "__", so it can never
  // alias a real chat's read-state).
  app.get<{ Params: { slug: string }; Querystring: { limit?: string } }>(
    "/runs",
    {
      schema: {
        tags: ["Chats"],
        summary: "List a project's run history",
        description:
          "Returns the project's 'while you were away' run history (scheduled + spawned + human runs) sourced from herdctl job records joined with provenance markers, plus the per-user since-last-visit watermark. Response: an object describing runs and the last-seen digest state.",
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
            limit: { type: "string", description: "Max number of runs to return (clamped server-side)." },
          },
        },
        response: {
          200: {
            description: "Object with the project's runs and since-last-visit digest state.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const keeper = keeperAgentName(project.slug);
        const limit = clampRunsLimit(req.query.limit);
        const [jobs, lastSeen] = await Promise.all([
          herdctl.listProjectRuns(project, limit).catch(() => []),
          readState
            .getLastSeen(readStateUser(req), keeper, RUNS_SEEN_SESSION)
            .catch(() => 0),
        ]);
        // Resolve provenance for each DISTINCT session referenced by a run — a
        // cheap in-memory map read per id (RunProvenanceStore is lazy-loaded once).
        const sessionIds = [
          ...new Set(jobs.map((j) => j.session_id).filter((s): s is string => !!s)),
        ];
        const provBySession = new Map<string, RunProvenance>();
        await Promise.all(
          sessionIds.map(async (sid) => {
            const p = await runProvenance.get(sid).catch(() => undefined);
            if (p) provBySession.set(sid, p);
          }),
        );
        return buildProjectRuns(jobs, provBySession, lastSeen);
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Advance the per-user "runs last seen" watermark (clears the since-last-visit
  // digest). Mirrors the chat-seen endpoint: optional `{ when }`, defaults to now,
  // monotonic in the store (an older `when` is a no-op).
  app.post<{ Params: { slug: string }; Body: { when?: number } }>(
    "/runs/seen",
    {
      schema: {
        tags: ["Chats"],
        summary: "Mark a project's runs as seen",
        description:
          "Advances the per-user 'runs last seen' watermark (clears the since-last-visit digest). Optional body `{ when }` (epoch-ms) defaults to now; monotonic in the store (an older `when` is a no-op). Response: `{ ok, lastSeen }`.",
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
            when: { description: "Epoch-ms timestamp to record as last seen; defaults to now." },
          },
          required: [],
        },
        response: {
          200: {
            description: "Object `{ ok, lastSeen }` with the recorded watermark.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const keeper = await agentForSlug(req.params.slug);
        const when =
          typeof req.body?.when === "number" && Number.isFinite(req.body.when)
            ? req.body.when
            : Date.now();
        await readState.setLastSeen(readStateUser(req), keeper, RUNS_SEEN_SESSION, when);
        return reply.code(200).send({ ok: true, lastSeen: when });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Bulk context-window usage for ALL of a project's chats, keyed by session id
  // (issue #116). This is the expensive part the chat list needs for its per-chat
  // usage rings (issue #77) — each session's fill is read by streaming its
  // transcript (memoized on transcript mtime). Split out of the project-detail
  // and chat-list payloads so the ProjectView renders immediately and the client
  // fills rings in progressively. Sessions with no usage data are omitted.
  //
  // Scoped by archived state (issue #537). There is no stored counter: usage is
  // derived by streaming each transcript end to end, so the cost is proportional
  // to transcript bytes, not chat count. The sidebar collapses the Archived group
  // by default, so computing archived rings on every project open is work whose
  // result is never rendered — on a live-scale project that was 72% of the bytes
  // streamed. `scope` therefore defaults to `active`; the client asks for
  // `archived` only once that group is actually expanded.
  app.get<{ Params: { slug: string }; Querystring: { scope?: ChatUsageScope } }>(
    "/chats/usage",
    {
      schema: {
        tags: ["Chats"],
        summary: "Bulk context-window usage for a project's chats",
        description:
          "Returns per-chat context-window usage keyed by session id — the expensive data the chat list needs for its usage rings. Scoped by `scope`, which defaults to `active` (non-archived chats only): usage is derived by streaming each transcript, and archived rings are hidden behind a collapsed group, so computing them by default is wasted work (issue #537). Pass `scope=archived` when that group is expanded, or `scope=all` for the whole project. Sessions with no usage data are omitted. Response: `{ usage: { <sessionId>: <usage> } }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
        querystring: {
          type: "object",
          properties: {
            scope: {
              type: "string",
              enum: [...CHAT_USAGE_SCOPES],
              default: "active",
              description:
                "Which chats to compute usage for: `active` (non-archived, the default), `archived`, or `all`.",
            },
          },
        },
        response: {
          200: {
            description: "Object `{ usage }` mapping session id to its context-window usage.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const sessions = await herdctl.listSessions(project).catch(() => []);
        const scope = req.query.scope ?? "active";
        const keeper = keeperAgentName(project.slug);
        const usageOf = chatUsageResolver(project.dir, project.model ?? DEFAULT_MODEL);
        // Bounded, NOT `Promise.all` (#544): one transcript read per chat, so an
        // unbounded map opens 1,515 concurrent streams on a real project and
        // peaks at 706 MB for no speed — 16 measured faster AND 4× smaller.
        const entries = await mapWithConcurrency(
          sessions,
          FILE_FANOUT_CONCURRENCY,
          async (s) => {
            // `all` skips the archive lookup entirely; the other two split on it.
            // The lookup is an in-memory sidecar read, so it is free next to the
            // transcript stream it is deciding whether to skip.
            if (
              scope !== "all" &&
              (await archive.isArchived(keeper, s.sessionId)) !== (scope === "archived")
            ) {
              return null;
            }
            const u = await usageOf(s).catch(() => null);
            return u ? ([s.sessionId, u] as const) : null;
          },
        );
        const usage: Record<string, ChatUsage> = {};
        for (const e of entries) if (e) usage[e[0]] = e[1];
        return { usage };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  app.post<{ Params: { slug: string } }>(
    "/chats",
    {
      schema: {
        tags: ["Chats"],
        summary: "Get the WS target for a new project chat",
        description:
          "Thin endpoint: validates the project and returns the WebSocket target for opening a new chat. It does NOT create the chat or send a message — a new chat is minted lazily by the first WS `chat:send` (with no sessionId), and the session id arrives in `chat:complete`. Responds 201 with `{ projectSlug, sessionId: null, ws: \"/ws\", note }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
          },
          required: ["slug"],
        },
        response: {
          201: {
            description: "Object `{ projectSlug, sessionId, ws, note }` giving the WS target `/ws`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
    // A "new chat" is created lazily by the first WS chat:send with no
    // sessionId (the SDK mints the session id, returned in chat:complete).
    // This endpoint just validates the project and returns the WS target so
    // the client can open a socket. TODO: persist a custom chat name up-front
    // via @herdctl/core SessionMetadataStore once we have a session id.
    try {
      const project = await projects.get(req.params.slug);
      return reply.code(201).send({
        projectSlug: project.slug,
        sessionId: null,
        ws: "/ws",
        note: "Open /ws and send chat:send with this projectSlug; session id arrives in chat:complete.",
      });
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

  // Messages of a specific chat (session) within a project.
  app.get<{ Params: { slug: string; sessionId: string } }>(
    "/chats/:sessionId/messages",
    {
      schema: {
        tags: ["Chats"],
        summary: "Read a project chat's messages",
        description:
          "READ-ONLY: returns the messages of a project chat, enriched with tool details and per-message provenance, plus a synthetic trailing notice if the chat dead-ended at a usage/subscription limit. Sending a message is WebSocket-only (a `chat:send` frame on GET /ws) — there is no HTTP send-message endpoint. Response: `{ messages: [...] }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            sessionId: { type: "string", description: "Chat (session) id." },
          },
          required: ["slug", "sessionId"],
        },
        response: {
          200: {
            description: "Object `{ messages }` with the chat's message array.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        const projectDir = await projectDirForSlug(req.params.slug);
        const messages = await herdctl
          .sessionMessages(agent, req.params.sessionId)
          .catch(() => []);
        const enriched = await enrichWithToolDetails(projectDir, req.params.sessionId, messages);
        // Per-message provenance (issue #290): attribute machine-injected turns to
        // their sender (chat / schedule) by joining the ordered injection markers.
        // Human-typed turns match no marker and stay unlabelled (the default).
        const markers = await messageProvenance.list(req.params.sessionId).catch(() => []);
        const withProvenance = applyMessageProvenance(enriched, markers);
        // Per-message context fill (issue #451): join the uuid→contextTokens
        // series (assistant turns only) and forward-fill it across the user/tool
        // messages between turns, so every message answers "how full was the
        // window as of here". Rides the mtime-cached series; open-chat path only.
        const series = SAFE_SESSION_ID.test(req.params.sessionId)
          ? await readContextSeries(projectDir, req.params.sessionId).catch(() => new Map())
          : new Map<string, number>();
        if (series.size > 0) {
          let lastCtx: number | undefined;
          for (const m of withProvenance) {
            if (m.uuid && series.has(m.uuid)) lastCtx = series.get(m.uuid);
            if (lastCtx !== undefined) m.contextTokens = lastCtx;
          }
        }
        // #329: `@herdctl/core` drops synthetic messages when it parses the
        // transcript, so a turn that dead-ended at a subscription/usage limit
        // leaves no visible trace on reload. Re-scan the raw JSONL for a TRAILING
        // usage-limit dead-end and append it as a synthetic notice turn so the
        // reason the chat stopped survives a refresh (a later real reply clears it).
        const notice = SAFE_SESSION_ID.test(req.params.sessionId)
          ? await scanTranscriptNotice(
              path.join(projectChatsDir(projectDir), `${req.params.sessionId}.jsonl`),
            )
          : null;
        if (notice) {
          const last = withProvenance[withProvenance.length - 1];
          withProvenance.push({
            role: "assistant",
            content: "",
            timestamp: last?.timestamp ?? new Date().toISOString(),
            uuid: `notice-${req.params.sessionId}`,
            notice,
          });
        }
        return { messages: withProvenance };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Step-by-step transcript of a sub-agent launched from a Task/Agent tool block
  // within a project chat (issue #37). `toolUseId` is the parent tool_use id
  // carried on the enriched tool call; it resolves to the sub-agent's own
  // transcript under `.chats/<sessionId>/subagents/`.
  app.get<{ Params: { slug: string; sessionId: string; toolUseId: string } }>(
    "/chats/:sessionId/subagents/:toolUseId/messages",
    {
      schema: {
        tags: ["Chats"],
        summary: "Read a sub-agent's transcript within a project chat",
        description:
          "Returns the step-by-step transcript of a sub-agent launched from a Task/Agent tool block within a project chat. `toolUseId` is the parent tool_use id carried on the enriched tool call. Response: `{ messages: [...] }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            sessionId: { type: "string", description: "Chat (session) id." },
            toolUseId: { type: "string", description: "Parent tool_use id of the sub-agent launch." },
          },
          required: ["slug", "sessionId", "toolUseId"],
        },
        response: {
          200: {
            description: "Object `{ messages }` with the sub-agent's message array.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const projectDir = await projectDirForSlug(req.params.slug);
        const messages = await readSubagentMessages(
          projectDir,
          req.params.sessionId,
          req.params.toolUseId,
        );
        return { messages };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Context-window usage for a project chat, read from the transcript's most
  // recent turn. Lets the UI show "context used" for a chat opened from history,
  // before any new turn streams a fresh usage value. `usage` is null when the
  // transcript has no usage data.
  app.get<{ Params: { slug: string; sessionId: string } }>(
    "/chats/:sessionId/context",
    {
      schema: {
        tags: ["Chats"],
        summary: "Context-window usage for a project chat",
        description:
          "Returns the context-window usage for a project chat, read from the transcript's most recent turn — lets the UI show 'context used' before a new turn streams a fresh value. Response: `{ usage }`, where `usage` is null when the transcript has no usage data.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            sessionId: { type: "string", description: "Chat (session) id." },
          },
          required: ["slug", "sessionId"],
        },
        response: {
          200: {
            description: "Object `{ usage }` (null when the transcript has no usage data).",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const projectDir = await projectDirForSlug(req.params.slug);
        // Every key here addresses a workspace, so the per-workspace model
        // override always applies.
        const p = await projects.get(req.params.slug).catch(() => null);
        const model = p?.model ?? DEFAULT_MODEL;
        const u = await readSessionTokenUsageWithSubagents(projectDir, req.params.sessionId).catch(
          () => null,
        );
        return { usage: u ? toChatUsage(u, model) : null };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Delete a chat (session) within a project: removes its transcript JSONL.
  app.delete<{ Params: { slug: string; sessionId: string } }>(
    "/chats/:sessionId",
    {
      schema: {
        tags: ["Chats"],
        summary: "Delete a project chat",
        description:
          "Deletes a project chat (session) and clears any archived/starred flag so a future session id can't inherit it. Responds 200 with `{ ok, removed, retained }`. In a Claude home Paddock owns, the transcript JSONL is unlinked (`removed: true`). In a home it does NOT own the transcript is the user's own terminal `claude` history — Paddock plants no symlink there (#682), so there is no copy to delete — and the session is RELEASED instead: it leaves the chat list, the file stays on disk, and `retained` is true (#689).",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            sessionId: { type: "string", description: "Chat (session) id." },
          },
          required: ["slug", "sessionId"],
        },
        response: {
          200: {
            description:
              "Object `{ ok, removed, retained, cancelledTurn }` — whether the transcript was removed, and whether a live turn had to be stopped first (#731).",
            type: "object",
            additionalProperties: true,
          },
          409: {
            description:
              "`{ code: 'turn_running' }` — a turn is still running on this chat and could not be stopped, so nothing was deleted (#731).",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        // #731: stop any in-flight turn FIRST. A delete is an unambiguous "this
        // chat is going away", so we cancel rather than refuse — refusing would
        // strand the user behind a turn that may never end (a hung turn was
        // exactly how this was found). If the turn will not die we refuse, since
        // deleting under a live writer is what resurrected the chat.
        const quiesced = await quiesceSession(interlock, req.params.sessionId);
        if (quiesced === "stuck") {
          return reply.code(409).send(turnRunningError([req.params.sessionId]));
        }
        await cleanupAttachments(agent, req.params.sessionId);
        const { removed, retained } = await herdctl.deleteSession(agent, req.params.sessionId);
        // #732: and the chat's herdctl job records, which are what feeds the
        // sidebar unread badge. Left behind, they kept the badge counting a chat
        // there was nothing left to open to clear. Only when the transcript was
        // actually REMOVED — see `purgeSessionJobs` for why a `retained`
        // (released) chat keeps its records.
        if (removed) await herdctl.purgeSessionJobs([req.params.sessionId]);
        // Drop any archived/starred/unread/detached flag so a future session id
        // can't inherit it. (Read-state watermarks, other users' unread overrides,
        // provenance and any queued message are deliberately NOT swept here — that
        // predates #508 and is a wider cleanup than a chat delete should attempt.)
        await archive.setArchived(agent, req.params.sessionId, false).catch(() => undefined);
        await star.setStarred(agent, req.params.sessionId, false).catch(() => undefined);
        await unread
          .setUnread(readStateUser(req), agent, req.params.sessionId, false)
          .catch(() => undefined);
        // #508: the detach override is per-chat state like the three above, so it
        // has to be cleared on the same path — otherwise a recycled session id
        // silently starts life detached from a parent it never had.
        await parentDetach.setDetached(agent, req.params.sessionId, false).catch(() => undefined);
        return reply
          .code(200)
          .send({ ok: true, removed, retained, cancelledTurn: quiesced === "stopped" });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Rename a chat (session): set or clear its custom display name. Now unblocked
  // by @herdctl/core's fleet.setSessionName (issue #10). A null/empty name
  // clears any custom name.
  app.patch<{ Params: { slug: string; sessionId: string }; Body: { name?: string | null } }>(
    "/chats/:sessionId",
    {
      schema: {
        tags: ["Chats"],
        summary: "Rename a project chat",
        description:
          "Sets or clears a project chat's custom display name. A null/empty `name` in the body clears any custom name. Responds 200 with `{ ok }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            sessionId: { type: "string", description: "Chat (session) id." },
          },
          required: ["slug", "sessionId"],
        },
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            name: { description: "New display name; null/empty clears the custom name." },
          },
          required: [],
        },
        response: {
          200: {
            description: "Object `{ ok }`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        const name = req.body?.name ?? null;
        await herdctl.renameSession(agent, req.params.sessionId, name);
        return reply.code(200).send({ ok: true });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Fork a project chat: eagerly duplicate its transcript into a NEW session in
  // the same project (leaving the source untouched) so the fork exists right
  // away — a real, resumable chat with the parent's full history — rather than
  // being created lazily on a first message. Optional `name` sets its title
  // (e.g. "Fork of <parent>"). Returns the new session id.
  app.post<{
    Params: { slug: string; sessionId: string };
    Body: { name?: string; fromUuid?: string };
  }>(
    "/chats/:sessionId/fork",
    {
      schema: {
        tags: ["Chats"],
        summary: "Fork a project chat",
        description:
          "Eagerly duplicates a project chat's transcript into a NEW session in the same project (leaving the source untouched), so the fork exists immediately as a real, resumable chat with the parent's history. Optional body `{ name }` sets the fork's title; optional `{ fromUuid }` branches at an earlier message so the fork inherits only the prefix up to that turn (issue #451). Responds 201 with `{ sessionId }` (the new session id).",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            sessionId: { type: "string", description: "Source chat (session) id to fork." },
          },
          required: ["slug", "sessionId"],
        },
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            name: { description: "Title for the new forked chat." },
            fromUuid: {
              description:
                "Message uuid to branch at; the fork inherits only the history up to that turn. Omitted ⇒ the full transcript.",
            },
          },
        },
        response: {
          201: {
            description: "Object `{ sessionId }` with the new forked session id.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        // `fromUuid` (issue #451): branch at an earlier message instead of copying
        // the whole history — the fork inherits only the prefix up to that turn.
        const newId = await herdctl.forkSession(
          project,
          req.params.sessionId,
          req.body?.name,
          req.body?.fromUuid,
        );
        // Record the lineage. A UI fork previously stamped NO provenance at all,
        // so a hand-forked chat was indistinguishable from a human root — and its
        // only parent link lived in the forking browser's localStorage. Inherit
        // depth from the source so the fork-bomb bound (#262) still holds.
        const src = await runProvenance.get(req.params.sessionId).catch(() => undefined);
        await runProvenance
          .stamp(
            newId,
            childOf(src ?? HUMAN_ROOT, { project: project.slug, sessionId: req.params.sessionId }),
          )
          .catch(() => undefined);
        return reply.code(201).send({ sessionId: newId });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Revert a project chat back to an earlier message (issue #451): truncate this
  // session's transcript at `uuid`, in place (same session id), so the chat
  // continues as if the later turns never happened. The dropped tail is backed
  // up (recoverable). Rolls back the CONVERSATION only — real side-effects of the
  // reverted turns are NOT undone (the UI warns). Returns the count dropped.
  app.post<{ Params: { slug: string; sessionId: string }; Body: { uuid?: string } }>(
    "/chats/:sessionId/revert",
    {
      schema: {
        tags: ["Chats"],
        summary: "Revert a project chat to an earlier message",
        description:
          "Truncates the chat's transcript at `uuid`, in place (same session id), so the conversation continues as if the later turns never happened. The dropped tail is backed up and recoverable. Rolls back the CONVERSATION only — real side-effects of the reverted turns are NOT undone. Requires body `{ uuid }` (400 without it). Returns an object with the count of removed messages.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            sessionId: { type: "string", description: "Chat (session) id to revert." },
          },
          required: ["slug", "sessionId"],
        },
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            uuid: { description: "Message uuid to truncate at (required; 400 when missing)." },
          },
        },
        response: {
          200: {
            description:
              "Object reporting how many messages were removed, and whether a live turn had to be stopped first (`cancelledTurn`, #731).",
            type: "object",
            additionalProperties: true,
          },
          409: {
            description:
              "`{ code: 'turn_running' }` — a turn is still running on this chat and could not be stopped, so nothing was truncated (#731).",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const uuid = req.body?.uuid;
        if (!uuid) return reply.code(400).send({ error: "uuid is required" });
        const project = await projects.get(req.params.slug);
        // #731: revert truncates the LIVE transcript in place — the same file a
        // running turn is appending to — so mid-turn it left an orphan
        // `tool_result` whose `tool_use` had just been truncated away. Cancel
        // rather than refuse: an in-flight turn is by definition part of the tail
        // the user just asked to throw away.
        const quiesced = await quiesceSession(interlock, req.params.sessionId);
        if (quiesced === "stuck") {
          return reply.code(409).send(turnRunningError([req.params.sessionId]));
        }
        const { removed } = await herdctl.revertSession(project, req.params.sessionId, uuid);
        return reply
          .code(200)
          .send({ ok: true, removed, cancelledTurn: quiesced === "stopped" });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Archive (or unarchive) a project chat (#95). A non-destructive toggle on a
  // persisted per-chat flag — the transcript is untouched and the chat stays
  // openable/resumable/forkable; it just moves into the Archived section.
  app.post<{ Params: { slug: string; sessionId: string }; Body: { archived?: boolean } }>(
    "/chats/:sessionId/archive",
    {
      schema: {
        tags: ["Chats"],
        summary: "Archive or unarchive a project chat",
        description:
          "Non-destructive toggle of a project chat's persisted archived flag — the transcript is untouched and the chat stays openable/resumable/forkable. Body `{ archived }` defaults to true; a real transition into archived fires the project's onArchive hooks. Responds 200 with `{ ok, archived }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            sessionId: { type: "string", description: "Chat (session) id." },
          },
          required: ["slug", "sessionId"],
        },
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            archived: { description: "Target archived state; defaults to true when omitted." },
          },
          required: [],
        },
        response: {
          200: {
            description: "Object `{ ok, archived }` with the resulting archived state.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        const archived = req.body?.archived !== false; // default true
        const changed = await archive.setArchived(agent, req.params.sessionId, archived);
        // Epic G / G1: after the archive COMMITS, emit `onArchive` (only on a real
        // transition into archived) so the hook dispatcher fires the project's enabled
        // onArchive hooks. Fire-and-forget — never blocks/fails the archive response.
        if (changed && archived) {
          events?.emit("onArchive", { slug: req.params.slug, sessionId: req.params.sessionId });
        }
        return reply.code(200).send({ ok: true, archived });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Star (or unstar) a project chat (#373). A non-destructive toggle on a
  // persisted per-chat flag — orthogonal to archiving; a starred chat just sorts
  // to the top of its population (active or Archived). Fires no lifecycle event.
  app.post<{ Params: { slug: string; sessionId: string }; Body: { starred?: boolean } }>(
    "/chats/:sessionId/star",
    {
      schema: {
        tags: ["Chats"],
        summary: "Star or unstar a project chat",
        description:
          "Non-destructive toggle of a project chat's persisted starred flag (orthogonal to archiving; a starred chat sorts to the top of its population). Body `{ starred }` defaults to true. Responds 200 with `{ ok, starred }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            sessionId: { type: "string", description: "Chat (session) id." },
          },
          required: ["slug", "sessionId"],
        },
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            starred: { description: "Target starred state; defaults to true when omitted." },
          },
          required: [],
        },
        response: {
          200: {
            description: "Object `{ ok, starred }` with the resulting starred state.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        const starred = req.body?.starred !== false; // default true
        await star.setStarred(agent, req.params.sessionId, starred);
        return reply.code(200).send({ ok: true, starred });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Mark a project chat SEEN (#189): persist the user's last-viewed moment for
  // this chat server-side (keyed by user when present, else a shared bucket), so
  // the unread affordance (#160/#161) follows the user across devices. Body's
  // optional `when` (epoch-ms) lets the client pass its own timestamp; defaults
  // to now. Mirrors the archive toggle's shape/validation. Monotonic in the
  // store (an older `when` is a no-op), so it never resurrects a stale unread.
  //
  // `keepUnread: true` marks the seen as INFERRED rather than intentional (#608):
  // the watermark still advances, but an explicit "mark unread" override is left
  // alone. The web client uses it when a turn happens to land while the chat is
  // focused — "you were watching" must not silently spend a flag the user (or an
  // API caller) set seconds earlier. The response reports the resulting flag so a
  // caller can see what its request did.
  app.post<{
    Params: { slug: string; sessionId: string };
    Body: { when?: number; keepUnread?: boolean };
  }>(
    "/chats/:sessionId/seen",
    {
      schema: {
        tags: ["Chats"],
        summary: "Mark a project chat as seen",
        description:
          "Persists the user's last-viewed moment for a project chat server-side, driving the cross-device unread affordance. Optional body `{ when }` (epoch-ms) defaults to now; monotonic in the store (an older `when` is a no-op). Clears the chat's MANUAL unread override (see the `/unread` route) unless `keepUnread` is true, which marks the request as an INFERRED seen and leaves an explicit flag intact. Responds 200 with `{ ok, lastSeen, unread }`, `unread` being the override's state afterwards.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            sessionId: { type: "string", description: "Chat (session) id." },
          },
          required: ["slug", "sessionId"],
        },
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            when: { description: "Epoch-ms timestamp to record as last seen; defaults to now." },
            keepUnread: {
              description:
                "When true, advance the watermark WITHOUT clearing the manual unread override — for a seen that was inferred rather than intended. Defaults to false.",
            },
          },
          required: [],
        },
        response: {
          200: {
            description:
              "Object `{ ok, lastSeen, unread }` with the recorded watermark and the manual unread override's state afterwards.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        const when =
          typeof req.body?.when === "number" && Number.isFinite(req.body.when)
            ? req.body.when
            : Date.now();
        const user = readStateUser(req);
        await readState.setLastSeen(user, agent, req.params.sessionId, when);
        // Marking a chat seen also clears any MANUAL unread override (#458): once
        // the user has viewed it, the "look at it again later" flag is spent —
        // UNLESS the caller flagged this as an inferred seen (#608), in which case
        // the explicit intent outranks it and the flag stands.
        let stillUnread = false;
        if (req.body?.keepUnread === true) {
          stillUnread = await unread.isUnread(user, agent, req.params.sessionId);
        } else {
          await unread.setUnread(user, agent, req.params.sessionId, false).catch(() => undefined);
        }
        return reply.code(200).send({ ok: true, lastSeen: when, unread: stillUnread });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Mark a project chat UNREAD (#458): set (or clear) the per-user MANUAL unread
  // override, so a chat resurfaces its unread cue even after its last turn was
  // seen — the email "mark as unread" pattern. Mirrors the archive/star toggles'
  // shape (`{ unread?: boolean }`, defaults true). Clearing it is equivalent to
  // marking seen; the client's toggle uses `/seen` for read and this for unread.
  app.post<{ Params: { slug: string; sessionId: string }; Body: { unread?: boolean } }>(
    "/chats/:sessionId/unread",
    {
      schema: {
        tags: ["Chats"],
        summary: "Mark a project chat unread",
        description:
          "Sets (or clears) the per-user MANUAL unread override so a chat resurfaces its unread cue even after its last turn was seen — the email \"mark as unread\" pattern. Body `{ unread }` defaults to true; clearing it is equivalent to marking seen (see the `/seen` route). Returns `{ ok, unread }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            sessionId: { type: "string", description: "Chat (session) id." },
          },
          required: ["slug", "sessionId"],
        },
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            unread: { description: "Whether to flag the chat unread. Defaults to true." },
          },
        },
        response: {
          200: {
            description: "Object `{ ok, unread }` reflecting the stored flag.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        const flag = req.body?.unread !== false; // default true
        await unread.setUnread(readStateUser(req), agent, req.params.sessionId, flag);
        return reply.code(200).send({ ok: true, unread: flag });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Detach a project chat from its parent (#508): promote it — with its own
  // subtree intact — to the top level of the nested chat list, so a family can be
  // archived/deleted "except this one".
  //
  // This is an OVERRIDE, not an edit: most live parent edges are INFERRED from
  // who injected the kickoff prompt rather than recorded, so clearing an edge
  // would simply be re-derived on the next list load. The flag is checked ahead of
  // both resolver tiers (see `makeParentResolver`). Nothing is destroyed, so
  // `{ detached: false }` re-attaches for free.
  app.post<{ Params: { slug: string; sessionId: string }; Body: { detached?: boolean } }>(
    "/chats/:sessionId/detach",
    {
      schema: {
        tags: ["Chats"],
        summary: "Detach a project chat from its parent",
        description:
          "Promotes a nested chat to the top level of the chat tree, keeping its own descendants under it. Persisted as an explicit override that is checked AHEAD of both parent-resolution tiers (the recorded `RunProvenance.parentSessionId` and the inferred kickoff-message edge), so it survives a reload. Body `{ detached }` defaults to true; `false` re-attaches (the underlying edge was never destroyed). Responds 200 with `{ ok, detached }`.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Project slug." },
            sessionId: { type: "string", description: "Chat (session) id." },
          },
          required: ["slug", "sessionId"],
        },
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            detached: {
              description:
                "Whether the chat should render as a root regardless of its parent edge. Defaults to true.",
            },
          },
          required: [],
        },
        response: {
          200: {
            description: "Object `{ ok, detached }` with the resulting detached state.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        const detached = req.body?.detached !== false; // default true
        await parentDetach.setDetached(agent, req.params.sessionId, detached);
        return reply.code(200).send({ ok: true, detached });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // --- batch (subtree) chat actions (#508) -------------------------------
  //
  // Shift-clicking a parent row applies archive / mark-read-unread / delete to
  // that chat AND every descendant. Looping the single-chat routes client-side
  // over 21 chats is 21 round trips that can half-succeed, leaving a torn family
  // (parent archived, some children not) with no single thing to roll back. These
  // routes take the whole id set, so the flag sidecars commit in ONE write and the
  // client has one call to roll back.
  //
  // They sit under the literal `/chats/batch/` prefix; a real session id is a UUID,
  // so it can never collide with the `/chats/:sessionId/...` routes.

  app.post<{ Params: { slug: string }; Body: { sessionIds?: unknown; archived?: boolean } }>(
    "/chats/batch/archive",
    {
      schema: {
        tags: ["Chats"],
        summary: "Archive or unarchive many project chats",
        description:
          "Applies a project chat's archived flag to a whole SET of chats (the nested chat list's shift-click subtree action, #508) in a single atomic sidecar write, so a parent and its descendants can't end up in different states. Body `{ sessionIds, archived }`; `archived` defaults to true. Each real transition into archived fires the project's onArchive triggers, exactly like the single-chat route. Responds 200 with `{ ok, archived, changed }` where `changed` lists the ids whose flag actually moved.",
        params: {
          type: "object",
          properties: { slug: { type: "string", description: "Project slug." } },
          required: ["slug"],
        },
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            sessionIds: {
              type: "array",
              items: { type: "string" },
              description: "Chat (session) ids to apply the flag to. 1–500 entries.",
            },
            archived: { description: "Target archived state; defaults to true when omitted." },
          },
          required: ["sessionIds"],
        },
        response: {
          200: {
            description: "Object `{ ok, archived, changed }`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const sessionIds = normalizeBatchSessionIds(req.body?.sessionIds);
        if (!sessionIds) return sendBadBatch(reply);
        const agent = await agentForSlug(req.params.slug);
        const archived = req.body?.archived !== false; // default true
        const changed = await archive.setManyArchived(agent, sessionIds, archived);
        // One `onArchive` per REAL transition into archived — the same contract the
        // single-chat route keeps, so a subtree archive fires the project's triggers
        // for each newly-archived chat and for none of the already-archived ones.
        //
        // Note the FAN-OUT this implies: shift-archiving a 21-chat family emits 21
        // events, and a project with an enabled onArchive trigger will start 21
        // agent turns from one click. That is the contract working as specified
        // (the trigger asked to fire per archived chat), and coalescing here would
        // silently drop events a subscriber is entitled to — but it is a real cost,
        // and the first person to enable an onArchive trigger will meet it.
        // Rate-limiting belongs in the dispatcher, not in this route.
        if (archived) {
          for (const sessionId of changed) {
            events?.emit("onArchive", { slug: req.params.slug, sessionId });
          }
        }
        return reply.code(200).send({ ok: true, archived, changed });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Mark many project chats read or unread (#508). `unread: false` is the "mark
  // read" half and does BOTH halves of what reading a chat means — clears the
  // manual override AND advances each chat's last-seen watermark — because the
  // derived unread signal (#160) would otherwise re-raise the cue the instant the
  // manual flag was cleared.
  app.post<{ Params: { slug: string }; Body: { sessionIds?: unknown; unread?: boolean } }>(
    "/chats/batch/unread",
    {
      schema: {
        tags: ["Chats"],
        summary: "Mark many project chats read or unread",
        description:
          "Applies the read/unread action to a whole SET of chats (the nested chat list's shift-click subtree action, #508) in a single atomic sidecar write. Body `{ sessionIds, unread }`; `unread` defaults to true. `unread: false` means \"mark read\": it clears each chat's manual unread override AND advances its last-seen watermark (the derived unread signal would otherwise immediately re-raise the cue). Responds 200 with `{ ok, unread, changed }`.",
        params: {
          type: "object",
          properties: { slug: { type: "string", description: "Project slug." } },
          required: ["slug"],
        },
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            sessionIds: {
              type: "array",
              items: { type: "string" },
              description: "Chat (session) ids to apply the flag to. 1–500 entries.",
            },
            unread: { description: "Whether to flag the chats unread. Defaults to true." },
          },
          required: ["sessionIds"],
        },
        response: {
          200: {
            description: "Object `{ ok, unread, changed }`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const sessionIds = normalizeBatchSessionIds(req.body?.sessionIds);
        if (!sessionIds) return sendBadBatch(reply);
        const agent = await agentForSlug(req.params.slug);
        const user = readStateUser(req);
        const flag = req.body?.unread !== false; // default true
        const changed = await unread.setManyUnread(user, agent, sessionIds, flag);
        // Marking read also advances read-state, mirroring the single-chat client
        // flow (which calls `/seen`, and `/seen` clears the manual flag).
        if (!flag) {
          await readState
            .setManyLastSeen(user, agent, sessionIds, Date.now())
            .catch(() => undefined);
        }
        return reply.code(200).send({ ok: true, unread: flag, changed });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Delete many project chats (#508) — the shift-click subtree delete, behind a
  // count-aware confirmation in the UI.
  //
  // Unlike the flag routes this can NOT be atomic: each delete unlinks a transcript
  // file, and the filesystem offers no transaction. So it is best-effort per chat
  // and honest about it — every id is attempted (one failure never abandons the
  // rest) and the response names which ones failed, so the client can surface a
  // partial failure instead of pretending the family is gone.
  app.post<{ Params: { slug: string }; Body: { sessionIds?: unknown } }>(
    "/chats/batch/delete",
    {
      schema: {
        tags: ["Chats"],
        summary: "Delete many project chats",
        description:
          "Deletes a SET of project chats (the nested chat list's shift-click subtree delete, #508): removes each transcript JSONL and clears its archived/starred/unread/detached flags. Body `{ sessionIds }`. Filesystem deletes cannot be atomic, so this is best-effort per chat: every id is attempted and the response reports `{ ok, removed, failed }` — `removed` lists the ids whose transcript was deleted, `failed` the ids that errored.",
        params: {
          type: "object",
          properties: { slug: { type: "string", description: "Project slug." } },
          required: ["slug"],
        },
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            sessionIds: {
              type: "array",
              items: { type: "string" },
              description: "Chat (session) ids to delete. 1–500 entries.",
            },
          },
          required: ["sessionIds"],
        },
        response: {
          200: {
            description: "Object `{ ok, removed, failed }`.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const sessionIds = normalizeBatchSessionIds(req.body?.sessionIds);
        if (!sessionIds) return sendBadBatch(reply);
        const agent = await agentForSlug(req.params.slug);
        const user = readStateUser(req);
        const removed: string[] = [];
        const failed: string[] = [];
        // The subset whose transcript was genuinely deleted — the ids whose job
        // records may be purged (#732). Narrower than `removed`, which also
        // holds RELEASED chats: those are still listed, so their records stay.
        const deleted: string[] = [];
        for (const sessionId of sessionIds) {
          try {
            // #731: same interlock as the single delete, per id. A chat whose
            // turn refuses to die lands in `failed` rather than aborting the
            // batch — the route is already best-effort-and-honest per chat, and
            // "still running" is exactly the kind of partial failure it reports.
            if ((await quiesceSession(interlock, sessionId)) === "stuck") {
              failed.push(sessionId);
              continue;
            }
            await cleanupAttachments(agent, sessionId);
            const gone = await herdctl.deleteSession(agent, sessionId);
            // `retained` counts as success here, and the distinction matters for
            // the flag-clearing below. These two buckets are "no longer in the
            // chat list" vs "still in it": a RELEASED chat (#689) left the list
            // even though its transcript survives on disk, so its flags must be
            // cleared like any other departure. Only a genuine failure — nothing
            // on disk to act on — belongs in `failed`.
            if (gone.removed || gone.retained) removed.push(sessionId);
            else failed.push(sessionId);
            if (gone.removed) deleted.push(sessionId);
          } catch {
            failed.push(sessionId);
          }
        }
        // ONE jobs-dir pass for the whole batch (#732) — purging per chat would
        // re-scan the shared directory once per id, up to 500 times.
        await herdctl.purgeSessionJobs(deleted);
        // Drop the archived/starred/unread/detached flags of the chats that were
        // ACTUALLY removed, so a recycled session id can't inherit stale state.
        //
        // Deliberately scoped to `removed`, NOT the whole requested set: a chat in
        // `failed` still exists on disk, and the response has just told the user
        // so. Clearing its flags would quietly unarchive it (so it reappears in
        // the active list on the next refetch), unstar it, and re-attach it to the
        // parent it was detached from — a chat the user was told SURVIVED, mutated
        // by the delete that spared it.
        await archive.setManyArchived(agent, removed, false).catch(() => undefined);
        await unread.setManyUnread(user, agent, removed, false).catch(() => undefined);
        for (const sessionId of removed) {
          await star.setStarred(agent, sessionId, false).catch(() => undefined);
          await parentDetach.setDetached(agent, sessionId, false).catch(() => undefined);
        }
        return reply.code(200).send({ ok: true, removed, failed });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Promote a chat into a NEW project (issue #20): create the project + keeper,
  // then re-home the chat's transcript into it so it lists + resumes under the
  // new project. Returns { project, promoted } — `promoted:false` means the
  // project was created but the transcript couldn't be moved (e.g. an unknown
  // session id); the project is still usable.
  //
  // Nothing about it is root-specific: it takes a source workspace like every
  // other route in this file, and the root is a workspace.
  app.post<{
    Params: { slug: string; sessionId: string };
    Body: { name?: string; slug?: string; group?: string; summary?: string; domain?: string[] };
  }>(
    "/chats/:sessionId/promote",
    {
      schema: {
        tags: ["Chats"],
        summary: "Promote a chat into a new project",
        description:
          "Promotes a chat into a NEW project: creates the project + its agent, then re-homes the chat's transcript into it so it lists and resumes under the new project. `name` is required (validated at runtime; a missing/blank name returns 400). Responds 201 with `{ project, promoted, sessionId }` — `promoted:false` means the project was created but the transcript couldn't be moved (e.g. an unknown session id); the project is still usable.",
        params: {
          type: "object",
          properties: {
            slug: { type: "string", description: "Slug of the project the chat currently lives in." },
            sessionId: { type: "string", description: "Chat (session) id to promote." },
          },
          required: ["slug", "sessionId"],
        },
        body: {
          type: ["object", "null"],
          additionalProperties: true,
          properties: {
            name: { description: "New project name (required; validated at runtime)." },
            slug: { description: "Optional explicit project slug." },
            group: { description: "Optional project group." },
            summary: { description: "Optional project summary." },
            domain: { description: "Optional project domain tags." },
          },
          required: [],
        },
        response: {
          201: {
            description:
              "Object `{ project, promoted, sessionId, cancelledTurn }` describing the created project, whether the transcript was re-homed, and whether a live turn had to be stopped first (#731).",
            type: "object",
            additionalProperties: true,
          },
          409: {
            description:
              "`{ code: 'turn_running' }` — a turn is still running on this chat and could not be stopped. Nothing was moved and NO project was created (#731).",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body ?? {};
      if (!body.name || !body.name.trim()) {
        return reply.code(400).send({ error: "Project name is required", code: "invalid" });
      }
      try {
        const from = await projects.get(req.params.slug);
        // #731: promote MOVES the transcript, so mid-turn it lost the chat from
        // BOTH projects — the surviving process rewrote the source path it still
        // held, while the moved copy went unlisted in the target with no recovery
        // path in the UI. Quiesce BEFORE `projects.create` so a refusal doesn't
        // leave an empty project behind as a side-effect of a failed promote.
        const quiesced = await quiesceSession(interlock, req.params.sessionId);
        if (quiesced === "stuck") {
          return reply.code(409).send(turnRunningError([req.params.sessionId]));
        }
        const project = await projects.create({
          name: body.name,
          slug: body.slug,
          group: body.group,
          summary: body.summary,
          domain: Array.isArray(body.domain) ? body.domain : undefined,
        });
        // Register the keeper + sweeper (creates the project's .chats symlink)
        // BEFORE moving the transcript into it.
        try {
          await herdctl.ensureProjectAgent(project);
        } catch (err) {
          req.log.warn({ err }, "promote: keeper registration failed (project still created)");
        }
        let promoted = false;
        try {
          await herdctl.promoteSession(req.params.sessionId, from, project);
          promoted = true;
        } catch (err) {
          req.log.warn({ err }, "promote: could not re-home the transcript");
        }
        return reply.code(201).send({
          project,
          promoted,
          sessionId: req.params.sessionId,
          cancelledTurn: quiesced === "stopped",
        });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // --- importing native Claude Code chats (#588) -------------------------
  //
  // A workspace is backed by a working directory, and the user very often
  // already has terminal `claude` history for it — or for their own checkout of
  // the same repo elsewhere on disk. These two routes surface that history and
  // pull it in. Detection lives in `../adoptable.ts`; the actual adoption is the
  // engine's primitive, threaded through `herdctl.adoptChats`.
  //
  // Both are workspace-scoped like everything else in this file, so the ROOT
  // workspace (key "") gets them from the same mount, unchanged.

  app.get<{ Params: { slug: string } }>(
    "/adoptable-chats",
    {
      schema: {
        tags: ["Chats"],
        summary: "Count the native Claude Code chats this project could import",
        description:
          "Returns the terminal `claude` sessions that could be imported into this project but are not yet visible in it: the project's own working directory, plus any Claude transcript folder whose recorded working directory matches the project (by checkout name for a repo-backed project, by exact path for a notebook project). Sidechains, already-imported sessions and sessions belonging to a real Paddock run are excluded by the engine; empty transcripts, slash-command-only transcripts and Paddock's own sweeper curation runs (`too-small` / `slash-command-only` / `sweeper-run`) are additionally withheld as noise and reported under `filtered`, so a count lower than the raw total always has an explanation. Response: `{ count, sources: [{ sourceCwd, sessionIds }], filtered: [{ sessionId, sourceCwd, reason }] }`. The count is LIVE — re-read it after an import rather than remembering a dismissal.",
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
              "Object `{ count, sources, filtered }` describing what this project could import.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const summary = await herdctl.listAdoptable(project);
        // `importFrom` is a server-internal detail — the synthetic path a legacy
        // source is reached through (#620). Clients round-trip `sourceCwd`, so
        // strip it rather than publishing a `~/.claude` path in the DTO; the
        // response schema is `additionalProperties: true`, so it would otherwise
        // serialize.
        return {
          ...summary,
          sources: summary.sources.map(({ importFrom: _importFrom, ...rest }) => rest),
        };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  app.post<{
    Params: { slug: string };
    Body: { sourceCwd?: string; sessionIds?: string[] } | null;
  }>(
    "/adopt-chats",
    {
      schema: {
        tags: ["Chats"],
        summary: "Import native Claude Code chats into this project",
        description:
          "Imports the terminal `claude` sessions reported by GET …/adoptable-chats. With no body (or no `sourceCwd`) every detected source is imported; with `sourceCwd` only that source is, and it must be one this project actually offers — an unrecognised path is a 400 rather than an invitation to scan arbitrary directories. `sessionIds` narrows the import to a chosen SUBSET of what is on offer (what the confirmation dialog sends); ids that are not on offer are simply not imported, and anything the engine adopts as a side effect of taking a whole source is released again. Transcripts are COPIED, never moved: the user's own `~/.claude` history is left intact and the copies keep their original mtimes, so imported chats sort by when they really happened. Afterwards the session, run-record and detection caches are dropped, so the chats appear on the very next list request with no restart. Response: `{ adopted, skipped }` — `skipped` carries the engine's reason per session (`sidechain`, `already-adopted`, `destination-exists`, `attributed-to-run`, `unreadable`, `placement-failed`, `record-failed`).",
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
            sourceCwd: {
              description:
                "Optional single source working directory to import from. Must be one of the `sourceCwd` values reported by GET …/adoptable-chats (or the project's own working directory); anything else is rejected with 400.",
            },
            sessionIds: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional subset of the offered session ids to import. Omit to import everything on offer.",
            },
          },
          required: [],
        },
        response: {
          200: {
            description: "Object `{ adopted, skipped }` describing what was imported.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const sourceCwd = req.body?.sourceCwd;
        // `=== undefined`, never truthiness: a caller could legitimately post an
        // empty body, and the workspace key itself may be "" — falsiness tests
        // are how the root workspace gets silently dropped (#531).
        if (sourceCwd !== undefined) {
          const { sources } = await herdctl.listAdoptable(project);
          const known =
            sourceCwd === project.workingDir || sources.some((s) => s.sourceCwd === sourceCwd);
          if (!known) {
            return reply
              .code(400)
              .send({ error: `Not an importable source: ${sourceCwd}`, code: "invalid" });
          }
        }
        const result = await herdctl.adoptChats(project, {
          sourceCwd,
          sessionIds: req.body?.sessionIds,
        });
        // Stamp each imported chat's provenance so the list can badge it as
        // imported rather than as an ordinary human chat. `stampIfAbsent`, not
        // `stamp`: provenance describes how a chat came to exist and is never
        // clobbered — if a marker is somehow already there, it knows more than
        // the import does. Best-effort; a sidecar write must not fail an import
        // that already succeeded on disk.
        await Promise.all(
          result.adopted.map((sessionId) =>
            runProvenance.stampIfAbsent(sessionId, ADOPTED_ROOT).catch(() => undefined),
          ),
        );
        return result;
      } catch (err) {
        // A session id that isn't path-safe is bad INPUT, not a server fault:
        // the engine refuses to build a state-file path from it and throws
        // PathTraversalError. Map it to 400 so it reads as "that id is not
        // importable" rather than an internal error.
        if (err instanceof PathTraversalError) {
          return reply.code(400).send({ error: err.message, code: "invalid" });
        }
        return sendProjectError(reply, err);
      }
    },
  );

  app.post<{ Params: { slug: string }; Body: { sessionIds?: string[] } | null }>(
    "/unadopt-chats",
    {
      schema: {
        tags: ["Chats"],
        summary: "Undo the most recent native-chat import into this project",
        description:
          "Reverses the import this server most recently performed into the workspace: each adoption is released and the copies that import placed are deleted, leaving the user's own `~/.claude` history untouched. `sessionIds` undoes part of that import; omit it to undo all of it. Deliberately scoped to the LAST import and remembered in memory — undo may delete files, so the paths it can touch come from what this process actually did rather than from the request body, and a restart forgets the offer rather than acting on a stale one. Response: `{ released }`, the session ids actually released; an empty array means there was nothing to undo (nothing imported, already undone, or the server restarted since).",
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
            sessionIds: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional subset of the last import's session ids to release. Omit to undo the whole import. Ids outside that import are ignored.",
            },
          },
          required: [],
        },
        response: {
          200: {
            description: "Object `{ released }` listing the session ids released.",
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const result = await herdctl.unadoptChats(project, {
          sessionIds: req.body?.sessionIds,
        });
        // Drop the provenance marker the import stamped, so a session that is
        // later re-imported is badged by that import rather than carrying a
        // marker from one that has been undone.
        await Promise.all(
          result.released.map((sessionId) => runProvenance.clear(sessionId).catch(() => undefined)),
        );
        return result;
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

}
