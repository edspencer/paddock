/**
 * PermissionDecisionStore — a Paddock-side sidecar recording how each permission
 * prompt in a chat was settled (#971), so the transcript keeps the approval
 * dialogue after the pinned card has gone.
 *
 * The Claude Code transcript does not record it. The CLI calls the prompt tool
 * itself, outside the model's turn, so the JSONL holds the approved or denied
 * tool_use and its tool_result but no trace of the request. An "Allow once"
 * leaves nothing at all; a denial or cancellation leaves only its tool_result
 * text. This sidecar holds the missing half, keyed by the tool_use the request
 * was about, so the history route can join it onto that tool call.
 *
 * Shape: `sessionId -> (toolUseId -> decision)`, persisted as a plain JSON object.
 * Durability mirrors the other sidecars: lazy single load (in-flight promise
 * shared), write-through serialised on a `writing` chain, tolerant of a missing
 * or corrupt file, mode `0o600` because subjects can be commands or paths.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  PendingPermissionWire,
  PermissionAnswer,
  PermissionOutcome,
} from "./permission-prompts.js";

const STATE_FILE = "permission-decisions.json";

/** Cap on a stored subject, in characters. A heredoc command can be very long. */
export const DECISION_SUBJECT_MAX = 500;

/** How a prompt was settled: one of the user's answers, or cancelled unanswered. */
export type PermissionDecisionOutcome = PermissionAnswer | "cancelled";

const OUTCOMES = new Set<string>(["once", "always", "deny", "cancelled"]);

/** One settled prompt, as stored and as sent to the web. */
export interface PermissionDecision {
  /** The tool_use the request was about; the join key onto the transcript. */
  toolUseId: string;
  /** The tool Claude wanted to run, e.g. `Write` or `Bash`. */
  toolName: string;
  /** What it was for: the file, the command, else the input as JSON. Capped. */
  subject: string;
  outcome: PermissionDecisionOutcome;
  /** Why a cancelled prompt was cancelled, e.g. "the turn ended". */
  reason?: string;
  /** Epoch-ms the request was parked. */
  requestedAt: number;
  /** Epoch-ms it was settled. */
  decidedAt: number;
}

/** A session id we're willing to key on — mirrors MessageProvenanceStore's guard. */
function isSafeId(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(sessionId);
}

/**
 * What a request is about, in one line: the file for an edit tool, the command
 * for Bash, else the input as JSON. Same rule as the web card's
 * `permissionSubject`, capped for storage.
 */
export function decisionSubject(input: Record<string, unknown>): string {
  let subject = JSON.stringify(input);
  for (const key of ["file_path", "notebook_path", "path", "command", "url"]) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) {
      subject = v;
      break;
    }
  }
  return subject.length > DECISION_SUBJECT_MAX
    ? `${subject.slice(0, DECISION_SUBJECT_MAX - 1)}…`
    : subject;
}

/**
 * The decision to record for a settled request, or null when the request names
 * no tool_use (nothing in the transcript to attach it to).
 */
export function permissionDecisionFor(
  wire: PendingPermissionWire,
  outcome: PermissionOutcome,
  decidedAt: number,
): PermissionDecision | null {
  if (!wire.toolUseId) return null;
  return {
    toolUseId: wire.toolUseId,
    toolName: wire.toolName,
    subject: decisionSubject(wire.input),
    ...(outcome.kind === "answered"
      ? { outcome: outcome.answer }
      : { outcome: "cancelled" as const, reason: outcome.reason }),
    requestedAt: wire.requestedAt,
    decidedAt,
  };
}

/** Narrow an untrusted value (a hand-edited file) to a {@link PermissionDecision}. */
function isDecision(v: unknown): v is PermissionDecision {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.toolUseId === "string" &&
    typeof o.toolName === "string" &&
    typeof o.subject === "string" &&
    typeof o.outcome === "string" &&
    OUTCOMES.has(o.outcome) &&
    (o.reason === undefined || typeof o.reason === "string") &&
    typeof o.requestedAt === "number" &&
    typeof o.decidedAt === "number"
  );
}

type State = Map<string, Map<string, PermissionDecision>>;

export class PermissionDecisionStore {
  private readonly stateFile: string;
  /** sessionId -> (toolUseId -> decision), loaded once and written through. */
  private state: State | null = null;
  /** The in-flight load, shared by concurrent first callers. */
  private loadPromise: Promise<State> | null = null;
  /** Serialises concurrent writes so the file never interleaves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, STATE_FILE);
  }

  /** Load the persisted map (lazily, deduped; tolerant of a missing/corrupt file). */
  private ensureLoaded(): Promise<State> {
    if (this.state) return Promise.resolve(this.state);
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const map: State = new Map();
        try {
          const raw = await fs.readFile(this.stateFile, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [sessionId, byTool] of Object.entries(parsed as Record<string, unknown>)) {
              if (!byTool || typeof byTool !== "object" || Array.isArray(byTool)) continue;
              const inner = new Map<string, PermissionDecision>();
              for (const d of Object.values(byTool as Record<string, unknown>)) {
                if (isDecision(d)) inner.set(d.toolUseId, d);
              }
              if (inner.size > 0) map.set(sessionId, inner);
            }
          }
        } catch {
          /* missing or unreadable — start empty */
        }
        this.state = map;
        return map;
      })();
    }
    return this.loadPromise;
  }

  /** A chat's decisions keyed by tool_use id. Non-throwing: any load error reads as none. */
  async list(sessionId: string): Promise<ReadonlyMap<string, PermissionDecision>> {
    if (!isSafeId(sessionId)) return new Map();
    const map = await this.ensureLoaded().catch((): State => new Map());
    return map.get(sessionId) ?? new Map();
  }

  /** Record (replace) the decision for one tool use. An unsafe session id is ignored. */
  async record(sessionId: string, decision: PermissionDecision): Promise<void> {
    if (!isSafeId(sessionId)) return;
    const map = await this.ensureLoaded();
    let inner = map.get(sessionId);
    if (!inner) {
      inner = new Map();
      map.set(sessionId, inner);
    }
    inner.set(decision.toolUseId, decision);
    await this.persist(map);
  }

  /** Write-through, serialised so overlapping writes can't corrupt the file. */
  private persist(map: State): Promise<void> {
    this.writing = this.writing.then(async () => {
      const obj: Record<string, Record<string, PermissionDecision>> = {};
      for (const [sessionId, inner] of map) obj[sessionId] = Object.fromEntries(inner);
      const json = JSON.stringify(obj, null, 2);
      await fs
        .writeFile(this.stateFile, json, { encoding: "utf8", mode: 0o600 })
        .catch(() => undefined);
    });
    return this.writing;
  }
}

/**
 * Attach each tool call's decision as `toolCall.permission`, joined on the tool
 * call's `toolUseId`. Messages without a matching decision pass through as-is.
 */
export function applyPermissionDecisions<
  T extends { toolCall?: { toolUseId?: string; permission?: PermissionDecision } },
>(messages: T[], decisions: ReadonlyMap<string, PermissionDecision>): T[] {
  if (decisions.size === 0) return messages;
  return messages.map((m) => {
    const id = m.toolCall?.toolUseId;
    const permission = id ? decisions.get(id) : undefined;
    return permission ? { ...m, toolCall: { ...m.toolCall, permission } } : m;
  });
}
