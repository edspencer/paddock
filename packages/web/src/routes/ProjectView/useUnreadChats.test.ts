import { describe, it, expect, vi, beforeEach } from "vitest";
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
