/**
 * Pending permission prompts (edspencer/paddock#971, #178).
 *
 * A keeper chat runs headless, so when Claude Code reaches an "ask" permission
 * decision (an Edit of a file under `~/.claude/`, say) there was nobody to ask
 * and the request was denied on the spot. The permission prompt tool
 * (`permission-prompt-mcp.ts`) now parks each such request here and waits for a
 * human to answer it from the web.
 *
 * This module is the parking lot and nothing else: no MCP, no sockets. It
 *   - holds each pending request with the resolver its tool call is awaiting,
 *   - settles a request with the user's answer, or as cancelled when the turn
 *     is interrupted or the session goes away,
 *   - reports the full pending set for a session on every change, so the WS
 *     layer can broadcast it as a LEVEL frame (replace semantics, exactly like
 *     `chat:background`) and replay it to a socket that (re)connects.
 *
 * In-memory only. A server restart kills the CLI process that was waiting, so
 * there is nothing on disk worth recovering. How each request was SETTLED is
 * durable, but not here: {@link PermissionPromptStore.onSettle} hands it to the
 * WS layer, which records it in `permission-decisions.ts`.
 */
import { randomUUID } from "node:crypto";

/** The three answers the web offers. */
export type PermissionAnswer = "once" | "always" | "deny";

/** One pending request, as sent to the web. */
export interface PendingPermissionWire {
  id: string;
  projectSlug: string;
  sessionId: string;
  /** The tool Claude wants to run, e.g. `Edit` or `Bash`. */
  toolName: string;
  /** The tool's input as the CLI passed it. Rendered, never trusted. */
  input: Record<string, unknown>;
  /** What it is about, in one line, uncapped (`requestSubject`). */
  subject: string;
  toolUseId?: string;
  /**
   * Whether "Always allow" is on offer: false when no session rule can be scoped
   * to exactly this file or command (`alwaysAllowRule`), so the card hides it.
   */
  alwaysAllowed: boolean;
  /** Epoch-ms the request was parked. */
  requestedAt: number;
}

/** How a parked request was settled. */
export type PermissionOutcome =
  | { kind: "answered"; answer: PermissionAnswer }
  | { kind: "cancelled"; reason: string };

interface Entry {
  wire: PendingPermissionWire;
  settle: (outcome: PermissionOutcome) => void;
}

/**
 * How long a prompt waits for the stream to show the tool_use it names. The CLI
 * writes the assistant message before it asks, but the Agent SDK answers an MCP
 * call as soon as it reads it while stream messages queue for the consumer, so
 * the prompt can arrive first.
 */
export const TOOL_USE_SIGHTING_GRACE_MS = 10_000;

/** The ids of the tool_use blocks in one raw SDK message. */
export function toolUseIdsIn(m: unknown): string[] {
  const content = (m as { message?: { content?: unknown } } | null)?.message?.content;
  if (!Array.isArray(content)) return [];
  return (content as Array<Record<string, unknown>>)
    .filter((b) => b?.type === "tool_use" && typeof b.id === "string")
    .map((b) => b.id as string);
}

/**
 * The tool_use ids each session's stream has emitted that have no tool_result
 * yet, with the tool each names. The CLI only asks about a call it is about to
 * run, so a prompt naming anything else did not come from the CLI's permission
 * path: the model called the prompt tool itself.
 */
export class OpenToolUses {
  /** sessionId -> (toolUseId -> toolName). */
  private bySession = new Map<string, Map<string, string>>();
  private waiters = new Set<() => void>();

  /** Read one raw SDK message: a tool_use opens its id, a tool_result closes it. */
  observe(m: unknown): void {
    const msg = m as { session_id?: unknown; message?: { content?: unknown } } | null;
    const sessionId = msg?.session_id;
    const content = msg?.message?.content;
    if (typeof sessionId !== "string" || !Array.isArray(content)) return;
    let open = this.bySession.get(sessionId);
    let added = false;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        if (!open) {
          open = new Map();
          this.bySession.set(sessionId, open);
        }
        open.set(block.id, typeof block.name === "string" ? block.name : "");
        added = true;
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        open?.delete(block.tool_use_id);
      }
    }
    if (open?.size === 0) this.bySession.delete(sessionId);
    if (added) for (const wake of [...this.waiters]) wake();
  }

  /** Whether `toolUseId` is an unanswered call to `toolName` on this session. */
  isOpen(sessionId: string, toolUseId: string, toolName: string): boolean {
    return this.bySession.get(sessionId)?.get(toolUseId) === toolName;
  }

  /**
   * Resolve true once the call is open, or false after `graceMs` (or an abort)
   * without it. See {@link TOOL_USE_SIGHTING_GRACE_MS} for why a wait is needed.
   */
  waitFor(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    graceMs: number,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    if (this.isOpen(sessionId, toolUseId, toolName)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (seen: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        abortSignal?.removeEventListener("abort", onAbort);
        resolve(seen);
      };
      const check = () => {
        if (this.isOpen(sessionId, toolUseId, toolName)) done(true);
      };
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), graceMs);
      this.waiters.add(check);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Forget a session's calls: its turn or stream is over, so none will run. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

/**
 * Backstop on how long a request may stay pending, well past the prompt tool's
 * own 24h call limit (`herdctl-permission-shim.ts`). Turn end, Stop and the
 * session's stream closing cancel requests; this catches one stranded by a path
 * none of those see, which would otherwise be replayed to every new socket.
 */
export const MAX_PENDING_AGE_MS = 48 * 60 * 60 * 1000;

export class PermissionPromptStore {
  /** The calls a prompt may be about; fed from the stream by the WS layer. */
  readonly toolUses = new OpenToolUses();

  constructor(private readonly now: () => number = Date.now) {}

  /** sessionId -> (request id -> entry). Insertion order is display order. */
  private bySession = new Map<string, Map<string, Entry>>();

  /**
   * Notified with a session's complete pending set whenever it changes. An empty
   * array means nothing is pending. Set by the WS layer.
   */
  onChange:
    | ((projectSlug: string, sessionId: string, requests: PendingPermissionWire[]) => void)
    | null = null;

  /**
   * Notified once per request as it is settled, answered or cancelled, before
   * the {@link onChange} that drops it. Set by the WS layer to keep the decision
   * in the chat's history.
   */
  onSettle: ((request: PendingPermissionWire, outcome: PermissionOutcome) => void) | null = null;

  /**
   * Park a request and wait for it to be settled. Resolves exactly once; never
   * rejects. An `abortSignal` that fires settles it as cancelled.
   */
  open(
    req: Omit<PendingPermissionWire, "id" | "requestedAt">,
    abortSignal?: AbortSignal,
  ): Promise<PermissionOutcome> {
    if (abortSignal?.aborted) {
      return Promise.resolve({ kind: "cancelled", reason: "aborted before it was shown" });
    }
    const wire: PendingPermissionWire = { ...req, id: randomUUID(), requestedAt: this.now() };
    return new Promise<PermissionOutcome>((resolve) => {
      const onAbort = () =>
        this.settle(wire.sessionId, wire.id, { kind: "cancelled", reason: "aborted" });
      let session = this.bySession.get(wire.sessionId);
      if (!session) {
        session = new Map();
        this.bySession.set(wire.sessionId, session);
      }
      session.set(wire.id, {
        wire,
        settle: (outcome) => {
          abortSignal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        },
      });
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      this.changed(wire.projectSlug, wire.sessionId);
    });
  }

  /**
   * Settle one request with the user's answer. False when there is no such
   * pending request — already answered (a second tab, a double click) or
   * already cancelled — which the caller can ignore.
   */
  answer(sessionId: string, id: string, answer: PermissionAnswer): boolean {
    const entry = this.bySession.get(sessionId)?.get(id);
    // "Always" on a request that does not offer it is applied, and recorded, as once.
    const effective = answer === "always" && entry && !entry.wire.alwaysAllowed ? "once" : answer;
    return this.settle(sessionId, id, { kind: "answered", answer: effective });
  }

  /**
   * Settle every request pending on a session as cancelled. Called when the
   * turn is interrupted or ends, and when the session's stream closes, since
   * nothing is waiting for an answer then.
   * Returns how many were cancelled.
   */
  cancelSession(sessionId: string, reason: string): number {
    this.toolUses.clear(sessionId);
    const session = this.bySession.get(sessionId);
    if (!session) return 0;
    const ids = [...session.keys()];
    for (const id of ids) this.settle(sessionId, id, { kind: "cancelled", reason });
    return ids.length;
  }

  /**
   * Settle as cancelled only the requests on a session about one of `toolUseIds`.
   * For a stream that closes on its own schedule: a newer stream on the same
   * session may already have raised a prompt of its own, which must not go too.
   */
  cancelToolUses(sessionId: string, toolUseIds: ReadonlySet<string>, reason: string): number {
    const ids = this.pendingFor(sessionId)
      .filter((w) => w.toolUseId !== undefined && toolUseIds.has(w.toolUseId))
      .map((w) => w.id);
    for (const id of ids) this.settle(sessionId, id, { kind: "cancelled", reason });
    return ids.length;
  }

  /** A session's pending requests, oldest first. */
  pendingFor(sessionId: string): PendingPermissionWire[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])].map((e) => e.wire);
  }

  /**
   * Every session with something pending, for the connect-time replay. Mirrors
   * `BackgroundRegistry.snapshot()`.
   */
  snapshot(): Array<{ projectSlug: string; sessionId: string; requests: PendingPermissionWire[] }> {
    this.expireStale();
    const out: Array<{
      projectSlug: string;
      sessionId: string;
      requests: PendingPermissionWire[];
    }> = [];
    for (const [sessionId, session] of this.bySession) {
      const requests = [...session.values()].map((e) => e.wire);
      if (requests.length > 0)
        out.push({ projectSlug: requests[0].projectSlug, sessionId, requests });
    }
    return out;
  }

  /** Cancel every request older than {@link MAX_PENDING_AGE_MS}. */
  private expireStale(): void {
    const cutoff = this.now() - MAX_PENDING_AGE_MS;
    const stale = [...this.bySession.values()]
      .flatMap((session) => [...session.values()])
      .filter((e) => e.wire.requestedAt < cutoff)
      .map((e) => e.wire);
    for (const w of stale) this.settle(w.sessionId, w.id, { kind: "cancelled", reason: "it expired" });
  }

  private settle(sessionId: string, id: string, outcome: PermissionOutcome): boolean {
    const session = this.bySession.get(sessionId);
    const entry = session?.get(id);
    if (!session || !entry) return false;
    session.delete(id);
    if (session.size === 0) this.bySession.delete(sessionId);
    entry.settle(outcome);
    this.onSettle?.(entry.wire, outcome);
    this.changed(entry.wire.projectSlug, sessionId);
    return true;
  }

  private changed(projectSlug: string, sessionId: string): void {
    this.onChange?.(projectSlug, sessionId, this.pendingFor(sessionId));
  }
}
