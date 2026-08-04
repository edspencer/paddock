import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  lastSeenKey,
  readLastSeen,
  markSeenLocally,
  revertSeenLocally,
  setServerLastSeen,
  LAST_SEEN_EVENT,
} from "./lastSeen";

beforeEach(() => localStorage.clear());

// Unique session id per assertion — the cache is module-level and has no reset,
// so tests must not reuse ids across the cases below.
let n = 0;
const sid = () => `srv-${++n}`;

describe("lastSeen: server-authoritative read-state (#189 / #488)", () => {
  it("returns 0 for a never-seen chat (so it sorts before any completed turn)", () => {
    expect(readLastSeen(sid())).toBe(0);
  });

  it("folds in a server value", () => {
    const s = sid();
    setServerLastSeen(s, 5000);
    expect(readLastSeen(s)).toBe(5000);
  });

  it("is monotonic: an older/absent server value never lowers the effective time", () => {
    const s = sid();
    setServerLastSeen(s, 5000);
    setServerLastSeen(s, 1000); // older — ignored
    setServerLastSeen(s, undefined); // absent — ignored
    setServerLastSeen(s, 0); // never-seen sentinel — ignored
    expect(readLastSeen(s)).toBe(5000);
  });

  it("dispatches the same-tab event only when the server value advances", () => {
    const s = sid();
    const spy = vi.fn();
    window.addEventListener(LAST_SEEN_EVENT, spy);
    setServerLastSeen(s, 2000); // advances → fires
    setServerLastSeen(s, 1500); // no advance → no fire
    window.removeEventListener(LAST_SEEN_EVENT, spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // The heart of #488: the optimistic value must NOT be persisted, so it cannot
  // outlive the page and shadow the server on this device forever.
  it("does NOT persist an optimistic mark to localStorage", () => {
    const s = sid();
    markSeenLocally(s, 9000);
    expect(readLastSeen(s)).toBe(9000); // visible in-memory…
    expect(localStorage.getItem(lastSeenKey(s))).toBeNull(); // …but nothing stored
    expect(localStorage.length).toBe(0);
  });

  it("markSeenLocally is monotonic and returns the previous value", () => {
    const s = sid();
    expect(markSeenLocally(s, 5000)).toBe(0); // no prior value
    expect(markSeenLocally(s, 9000)).toBe(5000); // advances, reports prior
    expect(markSeenLocally(s, 1000)).toBe(9000); // older — no-op
    expect(readLastSeen(s)).toBe(9000);
  });

  it("a later server value still wins over an earlier optimistic one", () => {
    const s = sid();
    markSeenLocally(s, 1000);
    setServerLastSeen(s, 5000); // e.g. seen on another device
    expect(readLastSeen(s)).toBe(5000);
  });
});

describe("lastSeen: optimistic rollback on a failed POST (#488)", () => {
  it("reverts to the previous value so the cue honestly reappears", () => {
    const s = sid();
    setServerLastSeen(s, 1000);
    const prev = markSeenLocally(s, 9000);
    revertSeenLocally(s, prev, 9000);
    expect(readLastSeen(s)).toBe(1000);
  });

  it("reverts to never-seen when there was no previous value", () => {
    const s = sid();
    const prev = markSeenLocally(s, 9000);
    revertSeenLocally(s, prev, 9000);
    expect(readLastSeen(s)).toBe(0);
  });

  it("does not clobber a server value that landed while the POST was in flight", () => {
    const s = sid();
    const prev = markSeenLocally(s, 9000);
    setServerLastSeen(s, 12_000); // arrived before the failure came back
    revertSeenLocally(s, prev, 9000); // superseded → leave it alone
    expect(readLastSeen(s)).toBe(12_000);
  });
});

// The #488 guards proper: read-state is SERVER-authoritative, so a leftover
// localStorage value must be inert. Kept after the one-time migration that used
// to consume those keys was deleted (#552) — with nothing left to drain them, a
// stale key lingering in some old profile must stay incapable of doing harm.
describe("lastSeen: leftover pre-#488 localStorage keys are inert", () => {
  afterEach(() => vi.restoreAllMocks());

  it("legacy values do NOT feed readLastSeen (the server is authoritative)", () => {
    const s = sid();
    localStorage.setItem(lastSeenKey(s), "9999999");
    expect(readLastSeen(s)).toBe(0);
  });

  it("readLastSeen never touches localStorage at all", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem");
    readLastSeen("sess-1");
    expect(spy).not.toHaveBeenCalled();
  });
});
