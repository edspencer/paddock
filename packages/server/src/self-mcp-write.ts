/**
 * Write-side handler factories for the Paddock self-management MCP — Phase 2
 * (issue #214). The create/fork/send/archive/fork-batch tools, each bound to a
 * per-turn {@link SelfMcpWriteContext}. Every factory returns an async handler
 * that validates/normalizes args (including the #336 per-chat `model` override and
 * the CLI-transport-tolerant `prompts` coercion) and delegates to the write
 * callbacks, which START real keeper turns. Present only when the write flag is on.
 */
import type { McpToolCallResult } from "@herdctl/core";
import type { SelfMcpCreateProjectInput, SelfMcpWriteContext } from "./self-mcp-types.js";
import {
  ok,
  fail,
  errText,
  truncateText,
  redactPaths,
  resolveModelArg,
  coercePrompts,
  FORK_BATCH_MAX,
} from "./self-mcp-util.js";
// The SAME shape validators `ProjectStore.create` uses, so the tool's up-front
// checks can't drift from the store's (issue #467). `project-paths.ts` is pure
// (node:path only), so importing it keeps these handlers fleet-free/unit-testable.
import { SLUG_RE, isValidRepoUrl } from "./project-paths.js";
import { PROJECT_STATUSES } from "./project-types.js";

export function createChatHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) return fail("Error: `prompt` is required (the first turn for the new chat).");
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;
      const name = typeof args.name === "string" && args.name.trim().length > 0 ? args.name.trim() : undefined;
      const preloadContext = typeof args.preload_context === "boolean" ? args.preload_context : undefined;
      // Per-chat model override (#336): validated against the picker allow-list; a
      // non-blank unknown id is rejected with an actionable error instead of being
      // silently ignored.
      const modelResult = resolveModelArg(args.model);
      if (typeof modelResult === "string") return fail(modelResult);
      const model = modelResult.model;

      const { sessionId } = await write.createChat(project, prompt, { name, preloadContext, model });
      // Echo the human-readable name + kickoff prompt so the chat renders with its
      // real title (not just a link) both live and on reload (#253). When no name
      // was given the web derives a title from the prompt (matching the sidebar's
      // auto-name). Prompt is capped to bound the tool-result payload. `model` is
      // echoed (when overridden) so the tool result records which model the spawned
      // chat runs on (#336).
      return ok({ created: true, project, sessionId, name, model, prompt: truncateText(prompt) });
    } catch (error) {
      return fail(`Error creating chat: ${errText(error)}`);
    }
  };
}

export function forkChatHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;
      const explicit = typeof args.session_id === "string" ? args.session_id.trim() : "";
      const sourceSessionId = explicit.length > 0 ? explicit : write.currentSessionId();
      if (!sourceSessionId) {
        return fail("no chat to fork (current chat id not yet known — pass session_id)");
      }
      const prompt = typeof args.prompt === "string" && args.prompt.trim().length > 0 ? args.prompt.trim() : undefined;
      const name = typeof args.name === "string" && args.name.trim().length > 0 ? args.name.trim() : undefined;
      // Per-chat model override (#336): validated against the picker allow-list.
      // Only applies to a kickoff turn — a fork without `prompt` runs no turn.
      const modelResult = resolveModelArg(args.model);
      if (typeof modelResult === "string") return fail(modelResult);
      const model = modelResult.model;

      const { sessionId } = await write.forkChat({ projectSlug: project, sourceSessionId, prompt, name, model });
      return ok({
        forked: true,
        project,
        sessionId,
        from: sourceSessionId,
        name,
        model,
        prompt: prompt ? truncateText(prompt) : undefined,
      });
    } catch (error) {
      return fail(`Error forking chat: ${errText(error)}`);
    }
  };
}

export function sendMessageHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!sessionId) return fail("Error: `session_id` is required (get it from list_chats).");
      if (!prompt) return fail("Error: `prompt` is required (the message to send).");
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      await write.sendMessage(project, sessionId, prompt);
      // Echo the sent message so the tool renders the actual message text (#253).
      return ok({ sent: true, project, sessionId, prompt: truncateText(prompt) });
    } catch (error) {
      return fail(`Error sending message: ${errText(error)}`);
    }
  };
}

/**
 * Handler factory for archive_chat / unarchive_chat. Both resolve the target the
 * same way — `session_id` OPTIONAL, defaulting to the CURRENT chat so an agent can
 * archive ITSELF without knowing its own id (mirrors fork_chat's self-default) —
 * and differ only in the boolean they set. `archived` selects which tool this is.
 */
export function archiveChatHandler(write: SelfMcpWriteContext, archived: boolean) {
  const verb = archived ? "archiving" : "unarchiving";
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;
      const explicit = typeof args.session_id === "string" ? args.session_id.trim() : "";
      const sessionId = explicit.length > 0 ? explicit : write.currentSessionId();
      if (!sessionId) {
        return fail("no chat to archive (current chat id not yet known — pass session_id)");
      }
      await write.setArchived(project, sessionId, archived);
      return ok({ archived, project, sessionId });
    } catch (error) {
      return fail(`Error ${verb} chat: ${errText(error)}`);
    }
  };
}

/**
 * `create_project` (issue #467) — provision a whole new project. The one write tool
 * that does NOT act inside an existing project, which is why it sits behind its own
 * `projectsMcpEnabled` gate.
 *
 * Pure, like its siblings: it trims + SHAPE-validates the args (using the very same
 * `SLUG_RE` / `isValidRepoUrl` / `PROJECT_STATUSES` the store and DTO use, so there
 * is no second definition of "valid") and delegates to `write.createProject`, which
 * runs `ProjectStore.create` + `ensureProjectAgent` — literally the REST create path.
 * The up-front checks are a fast, actionable-error convenience, NOT a replacement for
 * the store's own validation: the store still rejects a duplicate slug, a bad URL and
 * an unclonable repo, and still rolls the whole project dir back on a clone failure.
 */
export function createProjectHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail("Error: `name` is required (the project's display name).");

      const slugArg = typeof args.slug === "string" ? args.slug.trim() : "";
      // Only validate a slug the caller actually SUPPLIED — an omitted slug is
      // derived from `name` by the store (slugify), which can't produce a bad one.
      if (slugArg && !SLUG_RE.test(slugArg)) {
        return fail(
          `Error: invalid slug "${slugArg}" — must be kebab-case (lowercase a-z, 0-9 and ` +
            "single hyphens, e.g. \"my-new-project\"). Omit `slug` to derive it from `name`.",
        );
      }

      const repoArg = typeof args.repo === "string" ? args.repo.trim() : "";
      if (repoArg && !isValidRepoUrl(repoArg)) {
        return fail(
          `Error: invalid repo URL "${repoArg}" — expected an https://, git://, ssh:// or ` +
            "git@host:owner/repo url. Omit `repo` to create a notebook project.",
        );
      }

      const statusArg = typeof args.status === "string" ? args.status.trim().toLowerCase() : "";
      if (statusArg && !(PROJECT_STATUSES as readonly string[]).includes(statusArg)) {
        return fail(
          `Error: unknown status "${statusArg}". Valid statuses: ${PROJECT_STATUSES.join(", ")}.`,
        );
      }

      const summary = typeof args.summary === "string" ? args.summary.trim() : "";
      const area = typeof args.area === "string" ? args.area.trim() : "";

      const input: SelfMcpCreateProjectInput = {
        name,
        ...(slugArg ? { slug: slugArg } : {}),
        ...(repoArg ? { repo: repoArg } : {}),
        ...(summary ? { summary } : {}),
        ...(area ? { group: area } : {}),
        ...(statusArg ? { status: statusArg } : {}),
      };
      const project = await write.createProject(input);
      return ok({ created: true, ...project });
    } catch (error) {
      // Redact server filesystem paths: a clone failure arrives as git's whole argv
      // (`Command failed: git clone -- <url> <dest>`), and the agent needs the repo
      // URL + git's reason, not our on-disk layout. Capped so a verbose git failure
      // can't flood the tool result.
      return fail(`Error creating project: ${truncateText(redactPaths(errText(error)))}`);
    }
  };
}

/**
 * `promote_project` (issue #470) — turn an EXISTING notebook project into a
 * repo-backed one in place, over the same `ProjectStore.promote` (#213) that
 * `POST /api/projects/:slug/promote` uses. Shares `create_project`'s
 * `projectsMcpEnabled` gate: same blast-radius class (it clones a caller-supplied
 * URL and restructures a project), and this one MUTATES existing state.
 *
 * Pure, like its siblings: it resolves the target (defaulting to the current
 * project, as every other project-targeting write tool does), shape-checks the URL
 * with the very same `isValidRepoUrl` the store uses, and delegates. Everything
 * that makes promotion safe — the already-repo-backed / root-workspace / existing-
 * checkout-dir guards, and the rollback that leaves an untouched notebook when the
 * clone fails — stays in the store; nothing is re-implemented here.
 *
 * Deliberately NO up-front `SLUG_RE` check on the target, unlike `create_project`:
 * there the slug names a project being INVENTED, here it names one that must
 * already exist, so the store's own `not_found` is both the real check and the
 * better message — and `SLUG_RE` would reject the root workspace's legitimate ""
 * key with a misleading "invalid slug" instead of the store's explicit refusal.
 */
export function promoteProjectHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const projectSlug = projectArg.length > 0 ? projectArg : write.currentProjectSlug;

      const repo = typeof args.repo === "string" ? args.repo.trim() : "";
      if (!repo) {
        return fail("Error: `repo` is required (the git URL to back the project with).");
      }
      if (!isValidRepoUrl(repo)) {
        return fail(
          `Error: invalid repo URL "${repo}" — expected an https://, git://, ssh:// or ` +
            "git@host:owner/repo url.",
        );
      }

      const project = await write.promoteProject(projectSlug, repo);
      return ok({ promoted: true, ...project });
    } catch (error) {
      // Same hygiene as create_project: a clone failure arrives as git's whole argv
      // (`Command failed: git clone -- <url> <dest>`), and the agent needs the repo
      // URL + git's reason, not our on-disk layout.
      return fail(`Error promoting project: ${truncateText(redactPaths(errText(error)))}`);
    }
  };
}

export function forkChatBatchHandler(write: SelfMcpWriteContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const prompts = coercePrompts(args.prompts);
      if (prompts.length === 0) {
        return fail(
          "Error: `prompts` is required — a non-empty list of directive strings " +
            "(a JSON array, or one directive per line).",
        );
      }
      if (prompts.length > FORK_BATCH_MAX) {
        return fail(`Error: too many prompts (${prompts.length}); max ${FORK_BATCH_MAX} forks per call.`);
      }
      if (prompts.some((p) => p.length === 0)) {
        return fail("Error: every entry in `prompts` must be a non-empty string.");
      }
      const clean = prompts;
      const projectArg = typeof args.project === "string" ? args.project.trim() : "";
      const project = projectArg.length > 0 ? projectArg : write.currentProjectSlug;
      const explicit = typeof args.session_id === "string" ? args.session_id.trim() : "";
      const sourceSessionId = explicit.length > 0 ? explicit : write.currentSessionId();
      if (!sourceSessionId) {
        return fail("no chat to fork (current chat id not yet known — pass session_id)");
      }
      const namePrefix =
        typeof args.name_prefix === "string" && args.name_prefix.trim().length > 0 ? args.name_prefix.trim() : undefined;
      // Per-chat model override (#336): one model for the WHOLE fan-out (each fork's
      // kickoff turn runs on it), validated against the picker allow-list.
      const modelResult = resolveModelArg(args.model);
      if (typeof modelResult === "string") return fail(modelResult);
      const model = modelResult.model;

      // Concurrent fan-out; herdctl enforces the real concurrency cap downstream.
      const forks = await Promise.all(
        clean.map(async (prompt, i) => {
          const name = namePrefix ? `${namePrefix} ${i + 1}` : undefined;
          const { sessionId } = await write.forkChat({ projectSlug: project, sourceSessionId, prompt, name, model });
          return { sessionId, prompt };
        }),
      );
      return ok({ count: forks.length, source: sourceSessionId, model, forks });
    } catch (error) {
      return fail(`Error forking chat batch: ${errText(error)}`);
    }
  };
}
