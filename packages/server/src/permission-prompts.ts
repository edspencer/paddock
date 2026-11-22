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

export class PermissionPromptStore {
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
    const wire: PendingPermissionWire = { ...req, id: randomUUID(), requestedAt: Date.now() };
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
   * turn is interrupted or ends, since nothing is waiting for an answer then.
   * Returns how many were cancelled.
   */
  cancelSession(sessionId: string, reason: string): number {
    const session = this.bySession.get(sessionId);
    if (!session) return 0;
    const ids = [...session.keys()];
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
