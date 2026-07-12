import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { lastSeenKey, readLastSeen, writeLastSeen } from "./lastSeen";

beforeEach(() => localStorage.clear());

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
