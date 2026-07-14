import { describe, it, expect, beforeEach } from "vitest";
import { queuedKey, readQueued, writeQueued } from "./queued";

describe("queued-message persistence (#197)", () => {
  beforeEach(() => localStorage.clear());

  it("keys an established chat by its session id", () => {
    expect(queuedKey("sess-1", "proj")).toBe("paddock:queued:sess-1");
  });

  it("keys a brand-new chat by its slug", () => {
    expect(queuedKey(null, "proj")).toBe("paddock:queued:new:proj");
    expect(queuedKey(undefined, "scratch")).toBe("paddock:queued:new:scratch");
  });

  it("round-trips a queued message", () => {
    writeQueued("sess-1", "proj", "please also run the tests");
    expect(readQueued("sess-1", "proj")).toBe("please also run the tests");
  });

  it("returns null when nothing is queued", () => {
    expect(readQueued("missing", "proj")).toBeNull();
  });

  it("writing null/empty forgets the key (flush/edit/clear)", () => {
    writeQueued("sess-1", "proj", "queued text");
    writeQueued("sess-1", "proj", null);
    expect(readQueued("sess-1", "proj")).toBeNull();
    expect(localStorage.getItem("paddock:queued:sess-1")).toBeNull();

    writeQueued("sess-1", "proj", "queued again");
    writeQueued("sess-1", "proj", "");
    expect(readQueued("sess-1", "proj")).toBeNull();
    expect(localStorage.getItem("paddock:queued:sess-1")).toBeNull();
  });

  it("keeps the new-chat and established-chat slots independent", () => {
    writeQueued(null, "proj", "queued-new");
    writeQueued("sess-1", "proj", "queued-established");
    expect(readQueued(null, "proj")).toBe("queued-new");
    expect(readQueued("sess-1", "proj")).toBe("queued-established");
  });

  it("preserves a multi-line queued message verbatim", () => {
    const msg = "first line\nsecond line";
    writeQueued("sess-2", "proj", msg);
    expect(readQueued("sess-2", "proj")).toBe(msg);
  });
});
