import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUnreadChats } from "./useUnreadChats";
import { makeChat } from "../../test/factories";
import type { Chat } from "../../lib/types";

/**
 * Unread affordance (#160/#458) — specifically the precedence rule from #608: an
 * EXPLICIT "mark unread" beats the INFERRED "a turn completed while you were
 * watching it, so you've read it". That inference is still the right default when
 * the user hasn't said otherwise, so both halves are pinned here.
 */

const markChatSeen = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: { ...actual.api, markChatSeen: (...a: unknown[]) => markChatSeen(...a) },
  };
});

type Props = Parameters<typeof useUnreadChats>[0];

/**
 * Drive the hook the way ProjectView does: `onSeen` is the parent's mirror, which
 * CLEARS a chat's manual unread flag in the parent's own list. Wiring it up for
 * real means the derived `unread` set here reflects what the user actually sees
 * after navigating away from the chat.
 */
function harness(sessionId: string) {
  let chats: Chat[] = [
    makeChat({ sessionId, lastTurnCompletedAt: "2026-06-21T10:00:00.000Z" }),
  ];
  const onSeen = vi.fn((id: string) => {
    chats = chats.map((c) => (c.sessionId === id ? { ...c, unread: false } : c));
  });
  /** The user clicking "mark unread" — ProjectView flags it optimistically. */
  const flagUnread = () => {
    chats = chats.map((c) => (c.sessionId === sessionId ? { ...c, unread: true } : c));
  };
  const props = (over: { view?: string; running?: string[] } = {}): Props => ({
    slug: "demo",
    chats,
    view: over.view ?? "chat",
    activeSession: sessionId,
    runningSessions: new Set(over.running ?? []),
    onSeen,
  });
  return { onSeen, flagUnread, props };
}

beforeEach(() => {
  markChatSeen.mockReset();
  markChatSeen.mockResolvedValue(undefined);
});

describe("useUnreadChats — a turn completing in the focused chat (#608)", () => {
  it("does not spend a manual unread flag set moments earlier", async () => {
    const sid = "sess-608-flagged";
    const h = harness(sid);
    // Open the chat with a turn already running. Mount marks it seen — that's the
    // ordinary "you opened it" path, not what this test is about.
    const { rerender, result } = renderHook((p: Props) => useUnreadChats(p), {
      initialProps: h.props({ running: [sid] }),
    });
    h.onSeen.mockClear();
    markChatSeen.mockClear();

    // The user explicitly flags the OPEN chat unread ("come back to this").
    act(() => h.flagUnread());
    rerender(h.props({ running: [sid] }));

    // …and a moment later its in-flight turn lands.
    await act(async () => {
      rerender(h.props({ running: [] }));
    });

    // The explicit flag must survive: the parent's clear-the-flag mirror is never
    // invoked, and the server is told to keep the override.
    expect(h.onSeen).not.toHaveBeenCalled();
    expect(markChatSeen).toHaveBeenCalledWith(
      "demo",
      sid,
      expect.any(Number),
      expect.objectContaining({ keepUnread: true }),
    );

    // So navigating away still shows the cue.
    rerender(h.props({ view: "chats" }));
    expect(result.current.unread.has(sid)).toBe(true);
  });

  it("still marks the focused chat seen when there is no manual flag", async () => {
    const sid = "sess-608-plain";
    const h = harness(sid);
    const { rerender, result } = renderHook((p: Props) => useUnreadChats(p), {
      initialProps: h.props({ running: [sid] }),
    });
    markChatSeen.mockClear();

    // The turn completes while the chat is focused and unflagged.
    await act(async () => {
      rerender(h.props({ running: [] }));
    });

    // lastSeen still advances (the good default: you watched it finish)…
    expect(markChatSeen.mock.calls.map((c) => (c as unknown[]).slice(0, 2))).toEqual([
      ["demo", sid],
    ]);
    // …so the chat is not unread once you leave it.
    rerender(h.props({ view: "chats" }));
    expect(result.current.unread.has(sid)).toBe(false);
  });
});

/**
 * Archived is silent: the projects payload's `chatTurns` and `/chats/attention`
 * never count an archived chat, so the unread set leaves it out too. It is
 * silenced, not consumed — unarchiving brings the cue back.
 */
describe("useUnreadChats — archived chats are never unread", () => {
  it("leaves out an archived chat however it would be unread, and restores it on unarchive", () => {
    const chats = (archived: boolean): Chat[] => [
      // A manual flag, and a completed turn newer than any lastSeen (0).
      makeChat({ sessionId: "flagged", unread: true, archived }),
      makeChat({ sessionId: "replied", lastTurnCompletedAt: "2026-06-21T10:00:00.000Z", archived }),
      makeChat({ sessionId: "live", archived }),
    ];
    const props = (archived: boolean, running: string[] = []): Props => ({
      slug: "demo",
      chats: chats(archived),
      view: "home",
      activeSession: null,
      runningSessions: new Set(running),
    });
    const { rerender, result } = renderHook((p: Props) => useUnreadChats(p), {
      initialProps: props(true, ["live"]),
    });
    // A turn lands live in the third, which flags it unread this session.
    rerender(props(true));
    expect([...result.current.unread]).toEqual([]);

    rerender(props(false));
    expect([...result.current.unread].sort()).toEqual(["flagged", "live", "replied"]);
  });
});

/**
 * Seen only while visible (#958): the automatic marks wait for the tab to be
 * shown, so a reply that lands in a background tab is still unread when you
 * come back to it — and is marked seen the moment you do.
 */
describe("useUnreadChats — marks seen only while the tab is visible (#958)", () => {
  let visibility: DocumentVisibilityState = "visible";
  beforeEach(() => {
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });
  afterEach(() => {
    // Back to jsdom's own getter on the prototype.
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });
  const setVisibility = (v: DocumentVisibilityState) =>
    act(() => {
      visibility = v;
      document.dispatchEvent(new Event("visibilitychange"));
    });
  const seenIds = () => markChatSeen.mock.calls.map((c) => (c as unknown[])[1]);

  it("a chat opened in a background tab is not marked seen until the tab is shown", () => {
    visibility = "hidden";
    const h = harness("sess-bg");
    renderHook((p: Props) => useUnreadChats(p), { initialProps: h.props() });
    expect(markChatSeen).not.toHaveBeenCalled();
    expect(h.onSeen).not.toHaveBeenCalled();

    setVisibility("visible");
    // An EXPLICIT seen (you opened it): the manual-unread mirror runs too.
    expect(seenIds()).toEqual(["sess-bg"]);
    expect(markChatSeen.mock.calls[0][3]).toBeUndefined();
    expect(h.onSeen).toHaveBeenCalledWith("sess-bg");
  });

  it("a turn landing in a hidden tab makes the OPEN chat unread, then clears on return", async () => {
    const sid = "sess-hidden-turn";
    const h = harness(sid);
    const { rerender, result } = renderHook((p: Props) => useUnreadChats(p), {
      initialProps: h.props({ running: [sid] }),
    });
    markChatSeen.mockClear();
    h.onSeen.mockClear();

    setVisibility("hidden");
    await act(async () => {
      rerender(h.props({ running: [] }));
    });
    // Nobody watched it land: no mark, and the open chat now counts as unread.
    expect(markChatSeen).not.toHaveBeenCalled();
    expect(result.current.unread.has(sid)).toBe(true);

    setVisibility("visible");
    // The deferred mark is the INFERRED flavour (#608): keepUnread, no mirror.
    expect(seenIds()).toEqual([sid]);
    expect(markChatSeen.mock.calls[0][3]).toEqual({ keepUnread: true });
    expect(h.onSeen).not.toHaveBeenCalled();
    expect(result.current.unread.has(sid)).toBe(false);
  });

  it("opened hidden AND a turn landed hidden → one explicit mark on return", async () => {
    visibility = "hidden";
    const sid = "sess-both";
    const h = harness(sid);
    const { rerender } = renderHook((p: Props) => useUnreadChats(p), {
      initialProps: h.props({ running: [sid] }),
    });
    await act(async () => {
      rerender(h.props({ running: [] }));
    });
    expect(markChatSeen).not.toHaveBeenCalled();
    setVisibility("visible");
    expect(seenIds()).toEqual([sid]);
    expect(markChatSeen.mock.calls[0][3]).toBeUndefined();
    expect(h.onSeen).toHaveBeenCalledWith(sid);
  });

  it("leaving the chat before the tab is shown drops the mark: no stale seen for the wrong chat", async () => {
    visibility = "hidden";
    const a = "sess-a";
    const h = harness(a);
    const { rerender, result } = renderHook((p: Props) => useUnreadChats(p), {
      initialProps: h.props({ running: [a] }),
    });
    await act(async () => {
      rerender(h.props({ running: [] }));
    });
    expect(result.current.unread.has(a)).toBe(true);
    // Focus moves elsewhere (a redirect, say) while still hidden.
    rerender({ ...h.props(), view: "home", activeSession: null });
    setVisibility("visible");
    expect(markChatSeen).not.toHaveBeenCalled();
    // …so the reply nobody saw stays unread.
    expect(result.current.unread.has(a)).toBe(true);
  });

  it("switching chats while hidden defers the NEW chat, and marks only it on return", () => {
    visibility = "hidden";
    const h = harness("sess-a");
    const { rerender } = renderHook((p: Props) => useUnreadChats(p), { initialProps: h.props() });
    rerender({ ...h.props(), activeSession: "sess-b" });
    setVisibility("visible");
    expect(seenIds()).toEqual(["sess-b"]);
  });

  it("returning to a visible tab does not re-mark an already-seen chat (a manual flag survives)", () => {
    const sid = "sess-flag-survives";
    const h = harness(sid);
    const { rerender } = renderHook((p: Props) => useUnreadChats(p), { initialProps: h.props() });
    markChatSeen.mockClear();
    h.onSeen.mockClear();
    act(() => h.flagUnread());
    rerender(h.props());
    setVisibility("hidden");
    setVisibility("visible");
    expect(markChatSeen).not.toHaveBeenCalled();
    expect(h.onSeen).not.toHaveBeenCalled();
  });

  it("a visible tab behaves exactly as before: marks on open and on completion", async () => {
    const sid = "sess-visible";
    const h = harness(sid);
    const { rerender, result } = renderHook((p: Props) => useUnreadChats(p), {
      initialProps: h.props({ running: [sid] }),
    });
    expect(seenIds()).toEqual([sid]);
    await act(async () => {
      rerender(h.props({ running: [] }));
    });
    expect(seenIds()).toEqual([sid, sid]);
    expect(result.current.unread.has(sid)).toBe(false);
  });
});

/**
 * The deferred mark is applied before the browser can paint (#958). A browser
 * paints only at a TASK boundary, never between microtasks, so "before paint"
 * here means: by the time the microtask queue drains after `visibilitychange`,
 * the open chat is no longer unread. Run outside `act()` on purpose — `act`
 * flushes everything, which is exactly what would hide the difference. With a
 * plain `useEffect` the clear only lands on a later task, and this fails.
 */
describe("useUnreadChats — the deferred mark lands before paint (#958)", () => {
  it("clears the open chat's unread state within the same task as the visibilitychange", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    try {
      const sid = "sess-prepaint";
      const h = harness(sid);
      const { result, rerender } = renderHook((p: Props) => useUnreadChats(p), {
        initialProps: h.props({ running: [sid] }),
      });
      await act(async () => {
        rerender(h.props({ running: [] }));
      });
      expect(result.current.unread.has(sid)).toBe(true);

      g.IS_REACT_ACT_ENVIRONMENT = false;
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      // Drain microtasks only — no task boundary, so no paint could have happened.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(result.current.unread.has(sid)).toBe(false);
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = true;
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });
});
