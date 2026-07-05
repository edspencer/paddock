/**
 * Sub-agent (Task/Agent tool) transcript reader — issue #37.
 *
 * When a chat agent spawns a sub-agent via the `Task` tool (classic Claude Code)
 * or the `Agent` tool (Agent SDK), the sub-agent runs its own turn whose full
 * step-by-step transcript is written to disk alongside the parent session:
 *
 *   <projectDir>/.chats/<sessionId>/subagents/agent-<hex>.jsonl        // the steps
 *   <projectDir>/.chats/<sessionId>/subagents/agent-<hex>.meta.json    // linking sidecar
 *
 * The `.meta.json` sidecar is the key linking artifact:
 *   { "agentType", "description", "toolUseId", "spawnDepth" }
 * Its `toolUseId` ties the sub-agent transcript back to the parent turn's
 * `Task`/`Agent` tool_use block, so we can render each sub-agent's activity
 * underneath the tool block that launched it.
 *
 * herdctl deliberately filters these `isSidechain` files out of session
 * discovery (they'd clutter the top-level chat list), and its parsed
 * `ChatToolCall` carries neither the tool input nor the `toolUseId`. Rather than
 * change upstream, we read the raw transcript here (paddock already owns the
 * `.chats/` layout via `transcripts.ts`) and reuse core's exported
 * `parseSessionMessages` — the expensive jsonl→messages parsing — on each
 * sub-agent file. Discovery lives here; parsing stays in core.
 */
import { promises as fs, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { parseSessionMessages, type ChatMessage, type ChatToolCall } from "@herdctl/core";
import { projectChatsDir } from "./transcripts.js";

/** Tool names that launch a sub-agent. `Task` = classic Claude Code, `Agent` = Agent SDK. */
const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent"]);

/** Both sessionId and toolUseId are path segments — keep them inside `.chats/`. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The parent-turn view of a sub-agent launch, recovered from the main transcript. */
export interface TaskToolUse {
  toolUseId: string;
  subagentType?: string;
  description?: string;
  prompt?: string;
}

/** A sub-agent's `.meta.json` sidecar, plus the resolved path to its transcript. */
export interface SubagentMeta {
  toolUseId: string;
  agentType?: string;
  description?: string;
  spawnDepth?: number;
  /** Absolute path to the sibling `agent-<hex>.jsonl`. */
  transcriptPath: string;
}

/**
 * A paddock-enriched tool call: core's `ChatToolCall` plus the sub-agent fields
 * we recover for `Task`/`Agent` blocks. All additive and optional, so non-Task
 * tool calls (and older transcripts) are unaffected.
 */
export type EnrichedToolCall = ChatToolCall & {
  toolUseId?: string;
  subagentType?: string;
  description?: string;
  prompt?: string;
  /** True when a sub-agent transcript exists on disk for this tool_use. */
  hasSubagent?: boolean;
};

export type EnrichedMessage = Omit<ChatMessage, "toolCall"> & { toolCall?: EnrichedToolCall };

/**
 * Stream the main session transcript and recover, in file order, every
 * `Task`/`Agent` tool_use that was **paired** with a tool_result. Pairing is
 * tracked so the returned list aligns 1:1 with herdctl's parsed tool messages
 * (which only exist for paired calls): an in-flight/unpaired launch at the tail
 * is simply omitted until the turn completes, keeping the positional join exact.
 */
export async function readTaskToolUses(
  projectDir: string,
  sessionId: string,
): Promise<TaskToolUse[]> {
  if (!SAFE_SEGMENT.test(sessionId)) return [];
  const file = path.join(projectChatsDir(projectDir), `${sessionId}.jsonl`);

  const byId = new Map<string, TaskToolUse>();
  const order: string[] = [];
  const resultIds = new Set<string>();

  const stream = createReadStream(file, { encoding: "utf8" });
  stream.on("error", () => undefined);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: { message?: { content?: unknown } };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const content = parsed.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as {
          type?: string;
          name?: string;
          id?: string;
          tool_use_id?: string;
          input?: { subagent_type?: unknown; description?: unknown; prompt?: unknown };
        };
        if (b?.type === "tool_use" && b.name && SUBAGENT_TOOL_NAMES.has(b.name) && b.id) {
          if (!byId.has(b.id)) {
            order.push(b.id);
            byId.set(b.id, {
              toolUseId: b.id,
              subagentType: str(b.input?.subagent_type),
              description: str(b.input?.description),
              prompt: str(b.input?.prompt),
            });
          }
        } else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
          resultIds.add(b.tool_use_id);
        }
      }
    }
  } catch {
    return [];
  } finally {
    rl.close();
    stream.destroy();
  }

  return order.filter((id) => resultIds.has(id)).map((id) => byId.get(id)!);
}

/**
 * Read the `subagents/*.meta.json` sidecars for a session, keyed by `toolUseId`.
 * Returns an empty map when the session has no sub-agents (the common case) or
 * the directory is missing/unreadable.
 */
export async function listSubagents(
  projectDir: string,
  sessionId: string,
): Promise<Map<string, SubagentMeta>> {
  const out = new Map<string, SubagentMeta>();
  if (!SAFE_SEGMENT.test(sessionId)) return out;
  const dir = path.join(projectChatsDir(projectDir), sessionId, "subagents");
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith(".meta.json")) continue;
    const raw = await fs.readFile(path.join(dir, entry), "utf8").catch(() => null);
    if (raw === null) continue;
    let meta: {
      toolUseId?: unknown;
      agentType?: unknown;
      description?: unknown;
      spawnDepth?: unknown;
    };
    try {
      meta = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof meta.toolUseId !== "string") continue;
    out.set(meta.toolUseId, {
      toolUseId: meta.toolUseId,
      agentType: str(meta.agentType),
      description: str(meta.description),
      spawnDepth: typeof meta.spawnDepth === "number" ? meta.spawnDepth : undefined,
      // The transcript is the sidecar's sibling: agent-<hex>.meta.json → agent-<hex>.jsonl
      transcriptPath: path.join(dir, entry.replace(/\.meta\.json$/, ".jsonl")),
    });
  }
  return out;
}

/**
 * Parse a single sub-agent's transcript into messages, reusing core's parser.
 * Returns [] when the `toolUseId` doesn't correspond to a known sub-agent or the
 * transcript is missing. Both segments are validated to stay inside `.chats/`.
 */
export async function readSubagentMessages(
  projectDir: string,
  sessionId: string,
  toolUseId: string,
): Promise<ChatMessage[]> {
  if (!SAFE_SEGMENT.test(sessionId) || !SAFE_SEGMENT.test(toolUseId)) return [];
  const subagents = await listSubagents(projectDir, sessionId);
  const meta = subagents.get(toolUseId);
  if (!meta) return [];
  return parseSessionMessages(meta.transcriptPath).catch(() => [] as ChatMessage[]);
}

/**
 * Enrich a session's parsed messages: attach the recovered sub-agent fields
 * (`toolUseId`, `subagentType`, `description`, `prompt`, `hasSubagent`) to every
 * `Task`/`Agent` tool message, joining by file order. Non-Task tool calls and
 * sessions without sub-agents pass through unchanged (a cheap early return).
 */
export async function enrichWithSubagents(
  projectDir: string,
  sessionId: string,
  messages: ChatMessage[],
): Promise<EnrichedMessage[]> {
  const hasAgentTool = messages.some(
    (m) => m.toolCall && SUBAGENT_TOOL_NAMES.has(m.toolCall.toolName),
  );
  if (!hasAgentTool) return messages;

  const [taskUses, subagents] = await Promise.all([
    readTaskToolUses(projectDir, sessionId),
    listSubagents(projectDir, sessionId),
  ]);

  let i = 0;
  return messages.map((m) => {
    if (!m.toolCall || !SUBAGENT_TOOL_NAMES.has(m.toolCall.toolName)) return m;
    const use = taskUses[i++];
    if (!use) return m;
    return {
      ...m,
      toolCall: {
        ...m.toolCall,
        toolUseId: use.toolUseId,
        subagentType: use.subagentType,
        description: use.description,
        prompt: use.prompt,
        hasSubagent: subagents.has(use.toolUseId),
      },
    };
  });
}

/** Coerce a JSON value to a trimmed non-empty string, else undefined. */
function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}
