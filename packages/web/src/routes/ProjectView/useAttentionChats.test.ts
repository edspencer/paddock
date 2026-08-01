import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAttentionChats } from "./useAttentionChats";
import { makeChat } from "../../test/factories";
import type { AttentionChat, AttentionChats } from "../../lib/types";

/**
 * Home's attention feed (#599). The hook itself is thin — one GET per workspace
 * — so what these tests are really about is the two guards around it: the
 * DEBOUNCE that stops a fleet-wide turn boundary stampeding the server, and the
 * SEQUENCE ref that stops an older response overwriting a fresher one.
 */

const attentionChats = vi.fn();
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: { ...actual.api, attentionChats: (...a: unknown[]) => attentionChats(...a) },
  };
});

const REFETCH_DEBOUNCE_MS = 250;

function row(sessionId: string, name: string): AttentionChat {
  return { ...makeChat({ sessionId, name }), projectSlug: "p", projectName: "Test Project" };
}

/** A promise the test resolves by hand, so response ORDER is under its control. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Let the in-flight fetch's `.then` chain run. Fake timers are installed for the
 * debounce, so `waitFor` is off the table — it would advance them and fire the
 * very timer under test. Draining the microtask queue inside `act` is the
 * equivalent that leaves the clock alone.
 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Mount the hook with a controllable slug + running set. */
function mount(slug = "p", running: ReadonlySet<string> = new Set()) {
  return renderHook(
    ({ s, r }: { s: string; r: ReadonlySet<string> }) => useAttentionChats(s, r),
    { initialProps: { s: slug, r: running } },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  attentionChats.mockReset().mockResolvedValue({ running: [], unread: [] } satisfies AttentionChats);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useAttentionChats: the initial load", () => {
  it("fetches its own workspace's feed and exposes both lists", async () => {
    attentionChats.mockResolvedValue({
      running: [row("r1", "Streaming now")],
      unread: [row("u1", "Reply waiting")],
    });
    const { result } = mount("p");
    expect(result.current.loading).toBe(true);
    await flush();

    expect(attentionChats.mock.calls).toEqual([["p"]]);
    expect(result.current.running.map((c) => c.name)).toEqual(["Streaming now"]);
    expect(result.current.unread.map((c) => c.name)).toEqual(["Reply waiting"]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("asks under the ROOT key when it is the root workspace's Home", async () => {
    // `""` is a real key, not an absent one — the hook must pass it through
    // rather than treating it as "no workspace".
    mount("");
    await flush();
    expect(attentionChats.mock.calls).toEqual([[""]]);
  });

  it("surfaces a failed fetch in `error` and stops loading", async () => {
    attentionChats.mockRejectedValue(new Error("attention feed exploded"));
    const { result } = mount();
    await flush();
    expect(result.current.error).toBe("attention feed exploded");
    expect(result.current.loading).toBe(false);
  });

  it("clears a stale error once a later fetch succeeds", async () => {
    attentionChats.mockRejectedValueOnce(new Error("boom"));
    const { result } = mount();
    await flush();
    expect(result.current.error).toBe("boom");

    attentionChats.mockResolvedValue({ running: [row("r1", "Back")], unread: [] });
    act(() => result.current.refresh());
    await flush();
    expect(result.current.error).toBeNull();
    expect(result.current.running).toHaveLength(1);
  });
});

describe("useAttentionChats: refetching on the running set", () => {
  it("skips the FIRST observation — the WS set arriving is not a change", async () => {
    // The mount effect already fetched; the socket's first snapshot lands a beat
    // later and would otherwise make every mount fetch twice.
    mount();
    await flush();
    act(() => vi.advanceTimersByTime(REFETCH_DEBOUNCE_MS * 4));
    await flush();
    expect(attentionChats).toHaveBeenCalledTimes(1);
  });

  it("refetches once the running set moves, after the debounce", async () => {
    const { rerender } = mount();
    await flush();
    rerender({ s: "p", r: new Set(["s1"]) });
    await flush();
    // Not yet: a turn boundary fires two transitions in quick succession.
    expect(attentionChats).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(REFETCH_DEBOUNCE_MS));
    await flush();
    expect(attentionChats).toHaveBeenCalledTimes(2);
  });

  it("coalesces a burst of transitions into ONE refetch", async () => {
    // A batch of scheduled wake-ups can fire a dozen transitions; each one
    // restarting the timer is what keeps Home from stampeding the server.
    const { rerender } = mount();
    await flush();
    for (const s of [["a"], ["a", "b"], ["b"], ["b", "c"]]) {
      rerender({ s: "p", r: new Set(s) });
      act(() => vi.advanceTimersByTime(REFETCH_DEBOUNCE_MS - 50));
    }
    await flush();
    expect(attentionChats).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(REFETCH_DEBOUNCE_MS));
    await flush();
    expect(attentionChats).toHaveBeenCalledTimes(2);
  });

  it("keeps the current rows visible across a refetch (no skeleton flash)", async () => {
    attentionChats.mockResolvedValue({ running: [row("r1", "Streaming now")], unread: [] });
    const { result, rerender } = mount();
    await flush();
    expect(result.current.loading).toBe(false);

    rerender({ s: "p", r: new Set(["s1"]) });
    act(() => vi.advanceTimersByTime(REFETCH_DEBOUNCE_MS));
    // Mid-refetch: `loading` stays false and the rows stay put, so a busy
    // instance's Home doesn't strobe every time any chat starts or stops.
    expect(result.current.loading).toBe(false);
    expect(result.current.running.map((c) => c.name)).toEqual(["Streaming now"]);
    await flush();
  });
});

describe("useAttentionChats: out-of-order responses", () => {
  it("ignores an older response that lands after a fresher one", async () => {
    // Two refetches in flight, the OLDER landing last: without the sequence ref
    // it overwrites fresh rows with stale ones and Home shows work that has
    // already finished.
    const first = deferred<AttentionChats>();
    const second = deferred<AttentionChats>();
    attentionChats.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = mount();
    rerender({ s: "p", r: new Set(["s1"]) });
    act(() => vi.advanceTimersByTime(REFETCH_DEBOUNCE_MS));
    await flush();
    expect(attentionChats).toHaveBeenCalledTimes(2);

    // The fresher request answers first…
    await act(async () => {
      second.resolve({ running: [row("r2", "Fresh")], unread: [] });
    });
    expect(result.current.running.map((c) => c.name)).toEqual(["Fresh"]);

    // …and the straggler is dropped rather than applied on top.
    await act(async () => {
      first.resolve({ running: [row("r1", "Stale")], unread: [] });
    });
    expect(result.current.running.map((c) => c.name)).toEqual(["Fresh"]);
  });

  it("ignores a stale REJECTION too — a dead request cannot post an error", async () => {
    const first = deferred<AttentionChats>();
    const second = deferred<AttentionChats>();
    attentionChats.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = mount();
    rerender({ s: "p", r: new Set(["s1"]) });
    act(() => vi.advanceTimersByTime(REFETCH_DEBOUNCE_MS));
    await flush();

    await act(async () => {
      second.resolve({ running: [row("r2", "Fresh")], unread: [] });
    });
    await act(async () => {
      first.reject(new Error("the superseded one timed out"));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.running.map((c) => c.name)).toEqual(["Fresh"]);
  });
});

describe("useAttentionChats: switching workspace", () => {
  it("clears the rows and refetches under the new key", async () => {
    attentionChats.mockResolvedValue({ running: [row("r1", "Project chat")], unread: [] });
    const { result, rerender } = mount("p");
    await flush();
    expect(result.current.running).toHaveLength(1);

    attentionChats.mockResolvedValue({ running: [], unread: [] });
    rerender({ s: "other", r: new Set() });
    // Cleared immediately, not left showing the previous workspace's chats while
    // the new fetch is in the air.
    expect(result.current.running).toEqual([]);
    expect(result.current.loading).toBe(true);
    await flush();
    expect(attentionChats).toHaveBeenLastCalledWith("other");
    expect(result.current.loading).toBe(false);
  });
});
