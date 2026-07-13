import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  lastSeenKey,
  readLastSeen,
  writeLastSeen,
  setServerLastSeen,
  LAST_SEEN_EVENT,
} from "./lastSeen";

beforeEach(() => localStorage.clear());

// Unique session id per assertion — the server-value cache is module-level and
// has no reset, so tests must not reuse ids across the merge cases below.
let n = 0;
const sid = () => `srv-${++n}`;

describe("lastSeen persistence (#160)", () => {
  it("keys a chat by its session id", () => {
    expect(lastSeenKey("sess-1")).toBe("paddock:lastSeen:sess-1");
  });

  it("round-trips a last-seen timestamp", () => {
    writeLastSeen("sess-1", 1_700_000_000_000);
    expect(readLastSeen("sess-1")).toBe(1_700_000_000_000);
  });

  it("defaults `when` to now", () => {
    const now = 1_699_999_999_999;
    vi.spyOn(Date, "now").mockReturnValue(now);
    writeLastSeen("sess-1");
    expect(readLastSeen("sess-1")).toBe(now);
    vi.restoreAllMocks();
  });

  it("returns 0 for a never-seen chat (so it sorts before any completed turn)", () => {
    expect(readLastSeen("missing")).toBe(0);
  });

  it("returns 0 for a non-numeric stored value", () => {
    localStorage.setItem("paddock:lastSeen:sess-1", "not-a-number");
    expect(readLastSeen("sess-1")).toBe(0);
  });
});

describe("server-backed read-state (#189)", () => {
  it("prefers the server value over the local mirror (max wins)", () => {
    const s = sid();
    writeLastSeen(s, 1000);
    setServerLastSeen(s, 5000); // e.g. seen on another device
    expect(readLastSeen(s)).toBe(5000);
  });

  it("keeps a newer local (optimistic) value ahead of a stale server one", () => {
    const s = sid();
    setServerLastSeen(s, 1000); // stale server
    writeLastSeen(s, 9000); // just opened here — optimistic
    expect(readLastSeen(s)).toBe(9000);
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
});

describe("lastSeen resilience (private mode / quota)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("read never throws when getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readLastSeen("sess-1")).toBe(0);
  });

  it("write swallows a throwing setItem", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => writeLastSeen("sess-1")).not.toThrow();
  });
});
