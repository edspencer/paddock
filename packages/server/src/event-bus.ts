/**
 * In-process lifecycle event bus (Epic G, ticket G1 — hook foundation).
 *
 * Paddock lifecycle events (a chat archived, later: created/forked/unarchived) fire
 * INSIDE Paddock's own server — unlike schedules (Epic D), there is no herdctl seam
 * to add. This tiny typed emitter is that seam: the place that COMMITS a lifecycle
 * action ({@link ArchiveEvent}, from the archive route / the self-MCP archive tool)
 * `emit`s the event AFTER it commits, and the hook dispatcher (wired in `ws.ts`)
 * `on`s it to fire each of the project's enabled hooks via `startAgentTurn`.
 *
 * Two invariants make this safe as a foundation (GG-2, non-blocking after-commit):
 *
 *  1. **`emit` never throws into its caller and never blocks it.** Listeners run
 *     fire-and-forget; a listener that throws (sync or async) is swallowed so the
 *     triggering action (the archive) can NEVER fail or hang because of a hook. This
 *     is the whole point — a buggy hook must not break the thing that triggered it.
 *  2. **Events map 1:1 onto {@link import("./hook-config.js").HookEvent}.** The bus
 *     event name IS the hook's `event` field, so the dispatcher is a trivial
 *     `bus.on("onArchive", …)` that matches hooks with `event === "onArchive"`.
 *
 * Kept deliberately minimal (no Node `EventEmitter`: its `error`-event footgun and
 * default max-listener warnings are noise here) and dependency-free, matching the
 * hand-rolled sidecar style of the rest of the server.
 */
import type { HookEvent } from "./hook-config.js";

/**
 * Payload for the `onArchive` event: which chat, in which project, was archived.
 * The dispatcher passes `slug` to resolve the project's hooks and `sessionId` into
 * the fired hook's prompt so the hook knows WHAT was archived (e.g. which pm server
 * / clone to tear down).
 */
export interface ArchiveEvent {
  /** The project slug whose chat was archived. */
  slug: string;
  /** The archived chat's session id. */
  sessionId: string;
}

/**
 * The typed event map — keyed by {@link HookEvent} so a hook's `event` field and the
 * bus event name are the SAME string. v1 carries only `onArchive`; adding a sibling
 * event is: a new `HookEvent` value + its payload here + an `emit` at the commit site.
 */
export interface PaddockEventMap {
  onArchive: ArchiveEvent;
}

/** A lifecycle event name — exactly the hook events, so `on`/`emit` line up with hooks. */
export type PaddockEventName = HookEvent & keyof PaddockEventMap;

/** A listener for event `E`; may be async — its result is awaited-and-swallowed. */
export type EventListener<E extends PaddockEventName> = (
  payload: PaddockEventMap[E],
) => void | Promise<void>;

/**
 * A minimal typed publish/subscribe hub. One instance is constructed in `app.ts` and
 * shared by the commit sites (archive route / self-MCP archive tool → `emit`) and the
 * hook dispatcher in `ws.ts` (→ `on`).
 */
export class PaddockEventBus {
  private readonly listeners = new Map<PaddockEventName, Set<EventListener<PaddockEventName>>>();

  /**
   * Subscribe `listener` to `event`. Returns an unsubscribe function. Multiple
   * listeners per event are supported (v1 registers one — the hook dispatcher).
   */
  on<E extends PaddockEventName>(event: E, listener: EventListener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as EventListener<PaddockEventName>);
    return () => {
      this.listeners.get(event)?.delete(listener as EventListener<PaddockEventName>);
    };
  }

  /**
   * Fire `event` to every subscribed listener, FIRE-AND-FORGET. Returns immediately
   * (never awaits a listener) and never throws into the caller — a listener that
   * throws synchronously or rejects asynchronously is swallowed. So the action that
   * emitted the event (an archive commit) is fully decoupled from hook execution: it
   * neither waits on hooks nor fails because of them (GG-2).
   */
  emit<E extends PaddockEventName>(event: E, payload: PaddockEventMap[E]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const listener of set) {
      try {
        // A listener may be sync or async. Wrap in Promise.resolve so a synchronous
        // throw and an async rejection are both funneled into the same swallow — the
        // emitter's caller is never affected either way.
        void Promise.resolve()
          .then(() => listener(payload))
          .catch(() => undefined);
      } catch {
        /* a synchronous throw before the microtask — swallow too */
      }
    }
  }
}
