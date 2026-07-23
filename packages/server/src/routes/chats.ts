/**
 * Chat (session) routes: the project-chat cluster (list / runs / usage / create /
 * messages / subagents / context / delete / rename / fork / archive / star / seen)
 * and the mirrored one-off scratch-chat cluster (incl. scratch→project promote).
 * Chat SENDING happens over WS; these are the REST reads + lifecycle mutations.
 */
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { DiscoveredSession } from "@herdctl/core";
import { SCRATCH_SLUG, SCRATCH_AGENT, keeperAgentName } from "../herdctl.js";
import { applyMessageProvenance } from "../message-provenance.js";
import { buildProjectRuns } from "../runs.js";
import { KEEPER_DEFAULT_MODEL } from "../models.js";
import { projectChatsDir } from "../transcripts.js";
import { readSubagentMessages, readSessionTokenUsageWithSubagents } from "../subagents.js";
import { enrichWithToolDetails } from "../tooldetails.js";
import { scanTranscriptNotice } from "../turn-notice.js";
import type { RunProvenance } from "../run-provenance.js";
import { sendProjectError } from "../route-errors.js";
import {
  type ChatUsage,
  SAFE_SESSION_ID,
  RUNS_SEEN_SESSION,
  clampRunsLimit,
  toChatUsage,
  toChatDto,
  buildProjectChats,
  makeTriggerResolver,
} from "../chat-dto.js";
import type { RouteCtx } from "../route-context.js";

export function registerChatRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  const {
    projects,
    herdctl,
    archive,
    star,
    readState,
    runProvenance,
    messageProvenance,
    events,
    readStateUser,
    agentForSlug,
    projectDirForSlug,
    cleanupAttachments,
    chatUsageResolver,
  } = ctx;

  // --- chats (sessions) --------------------------------------------------

  app.get<{ Params: { slug: string } }>("/api/projects/:slug/chats", async (req, reply) => {
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
      const provenanceOf = (s: DiscoveredSession) => runProvenance.get(s.sessionId);
      const triggerOf = makeTriggerResolver(project);
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
        ),
      };
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });

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
    "/api/projects/:slug/runs",
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
    "/api/projects/:slug/runs/seen",
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
  app.get<{ Params: { slug: string } }>(
    "/api/projects/:slug/chats/usage",
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const sessions = await herdctl.listSessions(project).catch(() => []);
        const usageOf = chatUsageResolver(project.dir, project.model ?? KEEPER_DEFAULT_MODEL);
        const entries = await Promise.all(
          sessions.map(async (s) => {
            const u = await usageOf(s).catch(() => null);
            return u ? ([s.sessionId, u] as const) : null;
          }),
        );
        const usage: Record<string, ChatUsage> = {};
        for (const e of entries) if (e) usage[e[0]] = e[1];
        return { usage };
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/chats", async (req, reply) => {
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
    "/api/projects/:slug/chats/:sessionId/messages",
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
    "/api/projects/:slug/chats/:sessionId/subagents/:toolUseId/messages",
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
    "/api/projects/:slug/chats/:sessionId/context",
    async (req, reply) => {
      try {
        const projectDir = await projectDirForSlug(req.params.slug);
        let model = KEEPER_DEFAULT_MODEL;
        if (req.params.slug !== SCRATCH_SLUG) {
          const p = await projects.get(req.params.slug).catch(() => null);
          if (p?.model) model = p.model;
        }
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
    "/api/projects/:slug/chats/:sessionId",
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        await cleanupAttachments(agent, req.params.sessionId);
        const removed = await herdctl.deleteSession(agent, req.params.sessionId);
        // Drop any archived/starred flag so a future session id can't inherit it.
        await archive.setArchived(agent, req.params.sessionId, false).catch(() => undefined);
        await star.setStarred(agent, req.params.sessionId, false).catch(() => undefined);
        return reply.code(200).send({ ok: true, removed });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Rename a chat (session): set or clear its custom display name. Now unblocked
  // by @herdctl/core's fleet.setSessionName (issue #10). A null/empty name
  // clears any custom name.
  app.patch<{ Params: { slug: string; sessionId: string }; Body: { name?: string | null } }>(
    "/api/projects/:slug/chats/:sessionId",
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
  app.post<{ Params: { slug: string; sessionId: string }; Body: { name?: string } }>(
    "/api/projects/:slug/chats/:sessionId/fork",
    async (req, reply) => {
      try {
        const project = await projects.get(req.params.slug);
        const newId = await herdctl.forkSession(project, req.params.sessionId, req.body?.name);
        return reply.code(201).send({ sessionId: newId });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Archive (or unarchive) a project chat (#95). A non-destructive toggle on a
  // persisted per-chat flag — the transcript is untouched and the chat stays
  // openable/resumable/forkable; it just moves into the Archived section.
  app.post<{ Params: { slug: string; sessionId: string }; Body: { archived?: boolean } }>(
    "/api/projects/:slug/chats/:sessionId/archive",
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
    "/api/projects/:slug/chats/:sessionId/star",
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
  app.post<{ Params: { slug: string; sessionId: string }; Body: { when?: number } }>(
    "/api/projects/:slug/chats/:sessionId/seen",
    async (req, reply) => {
      try {
        const agent = await agentForSlug(req.params.slug);
        const when =
          typeof req.body?.when === "number" && Number.isFinite(req.body.when)
            ? req.body.when
            : Date.now();
        await readState.setLastSeen(readStateUser(req), agent, req.params.sessionId, when);
        return reply.code(200).send({ ok: true, lastSeen: when });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // One-off chats (scratch dir). Scratch chats never get context preload, so
  // their previews are never polluted — no wrapper stripping needed.
  app.get("/api/chats", async (req) => {
    const sessions = await herdctl.listScratchSessions().catch(() => []);
    const usageOf = chatUsageResolver(herdctl.scratchDir, KEEPER_DEFAULT_MODEL);
    const user = readStateUser(req);
    return {
      chats: await Promise.all(
        sessions.map(async (s) =>
          toChatDto(
            s,
            undefined,
            await usageOf(s),
            await archive.isArchived(SCRATCH_AGENT, s.sessionId).catch(() => false),
            undefined,
            await readState.getLastSeen(user, SCRATCH_AGENT, s.sessionId).catch(() => 0),
            await runProvenance.get(s.sessionId).catch(() => null),
            undefined,
            await star.isStarred(SCRATCH_AGENT, s.sessionId).catch(() => false),
          ),
        ),
      ),
    };
  });

  // Messages of a one-off (scratch) chat.
  app.get<{ Params: { sessionId: string } }>(
    "/api/chats/:sessionId/messages",
    async (req) => {
      const messages = await herdctl
        .sessionMessages(SCRATCH_AGENT, req.params.sessionId)
        .catch(() => []);
      return {
        messages: await enrichWithToolDetails(
          herdctl.scratchDir,
          req.params.sessionId,
          messages,
        ),
      };
    },
  );

  // Sub-agent transcript within a one-off (scratch) chat (issue #37).
  app.get<{ Params: { sessionId: string; toolUseId: string } }>(
    "/api/chats/:sessionId/subagents/:toolUseId/messages",
    async (req) => {
      const messages = await readSubagentMessages(
        herdctl.scratchDir,
        req.params.sessionId,
        req.params.toolUseId,
      );
      return { messages };
    },
  );

  // Context-window usage for a one-off (scratch) chat (see the project variant).
  app.get<{ Params: { sessionId: string } }>("/api/chats/:sessionId/context", async (req) => {
    const u = await readSessionTokenUsageWithSubagents(
      herdctl.scratchDir,
      req.params.sessionId,
    ).catch(() => null);
    return { usage: u ? toChatUsage(u, KEEPER_DEFAULT_MODEL) : null };
  });

  // Delete a one-off (scratch) chat.
  app.delete<{ Params: { sessionId: string } }>(
    "/api/chats/:sessionId",
    async (req, reply) => {
      try {
        await cleanupAttachments(SCRATCH_AGENT, req.params.sessionId);
        const removed = await herdctl.deleteSession(SCRATCH_AGENT, req.params.sessionId);
        await archive.setArchived(SCRATCH_AGENT, req.params.sessionId, false).catch(() => undefined);
        await star.setStarred(SCRATCH_AGENT, req.params.sessionId, false).catch(() => undefined);
        return reply.code(200).send({ ok: true, removed });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Archive (or unarchive) a one-off (scratch) chat (#95). Same non-destructive
  // toggle as the project variant.
  app.post<{ Params: { sessionId: string }; Body: { archived?: boolean } }>(
    "/api/chats/:sessionId/archive",
    async (req, reply) => {
      try {
        const archived = req.body?.archived !== false; // default true
        await archive.setArchived(SCRATCH_AGENT, req.params.sessionId, archived);
        return reply.code(200).send({ ok: true, archived });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Star (or unstar) a one-off (scratch) chat (#373). Same non-destructive toggle
  // as the project variant.
  app.post<{ Params: { sessionId: string }; Body: { starred?: boolean } }>(
    "/api/chats/:sessionId/star",
    async (req, reply) => {
      try {
        const starred = req.body?.starred !== false; // default true
        await star.setStarred(SCRATCH_AGENT, req.params.sessionId, starred);
        return reply.code(200).send({ ok: true, starred });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Mark a one-off (scratch) chat SEEN (#189). Same as the project variant.
  app.post<{ Params: { sessionId: string }; Body: { when?: number } }>(
    "/api/chats/:sessionId/seen",
    async (req, reply) => {
      try {
        const when =
          typeof req.body?.when === "number" && Number.isFinite(req.body.when)
            ? req.body.when
            : Date.now();
        await readState.setLastSeen(readStateUser(req), SCRATCH_AGENT, req.params.sessionId, when);
        return reply.code(200).send({ ok: true, lastSeen: when });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Rename a one-off (scratch) chat (issue #10).
  app.patch<{ Params: { sessionId: string }; Body: { name?: string | null } }>(
    "/api/chats/:sessionId",
    async (req, reply) => {
      try {
        await herdctl.renameSession(SCRATCH_AGENT, req.params.sessionId, req.body?.name ?? null);
        return reply.code(200).send({ ok: true });
      } catch (err) {
        return sendProjectError(reply, err);
      }
    },
  );

  // Promote a one-off (scratch) chat into a new project (issue #20): create the
  // project + keeper, then re-home the chat's transcript into it so it lists +
  // resumes under the project. Returns { project, promoted } — `promoted:false`
  // means the project was created but the transcript couldn't be moved (e.g. an
  // unknown session id); the project is still usable.
  app.post<{
    Params: { sessionId: string };
    Body: { name?: string; slug?: string; group?: string; summary?: string; domain?: string[] };
  }>("/api/chats/:sessionId/promote", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.name || !body.name.trim()) {
      return reply.code(400).send({ error: "Project name is required", code: "invalid" });
    }
    try {
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
        await herdctl.promoteScratchSession(req.params.sessionId, project);
        promoted = true;
      } catch (err) {
        req.log.warn({ err }, "promote: could not re-home scratch transcript");
      }
      return reply.code(201).send({ project, promoted, sessionId: req.params.sessionId });
    } catch (err) {
      return sendProjectError(reply, err);
    }
  });
}
