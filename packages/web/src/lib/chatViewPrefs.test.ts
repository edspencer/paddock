import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  readNestedChats,
  readRunningOnly,
  readViewOptionsOpen,
  writeNestedChats,
  writeRunningOnly,
  writeViewOptionsOpen,
} from "./chatViewPrefs";

describe("chatViewPrefs", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("defaults to today's behaviour: nested on, no filter, panel closed", () => {
    expect(readNestedChats()).toBe(true);
    expect(readRunningOnly()).toBe(false);
    expect(readViewOptionsOpen()).toBe(false);
  });

  it("round-trips each flag independently", () => {
    writeNestedChats(false);
    writeRunningOnly(true);
    expect(readNestedChats()).toBe(false);
    expect(readRunningOnly()).toBe(true);
    // Untouched flags keep their defaults.
    expect(readViewOptionsOpen()).toBe(false);

    writeNestedChats(true);
    expect(readNestedChats()).toBe(true);
    expect(readRunningOnly()).toBe(true);
  });

  it("is GLOBAL — the keys carry no project slug", () => {
    // A slug-keyed pref would forget itself on every project switch, and the
    // root workspace's slug is "" (the falsy-key hazard). Neither can happen if
    // the slug never enters the key.
    writeNestedChats(false);
    writeRunningOnly(true);
    writeViewOptionsOpen(true);
    expect(Object.keys(localStorage).sort()).toEqual([
      "paddock:chatView:nested",
      "paddock:chatView:optionsOpen",
      "paddock:chatView:runningOnly",
    ]);
  });

  it("stores nothing for a default value, so a reset profile reads clean", () => {
    writeNestedChats(true);
    writeRunningOnly(false);
    expect(localStorage.getItem("paddock:chatView:nested")).toBeNull();
    expect(localStorage.getItem("paddock:chatView:runningOnly")).toBeNull();
  });

  it("falls back to the value that HIDES NOTHING when the store is corrupt", () => {
    // A half-written value must never be able to make chats disappear: nesting
    // stays on and the running filter stays off.
    localStorage.setItem("paddock:chatView:nested", "yes-please");
    localStorage.setItem("paddock:chatView:runningOnly", "{not json}");
    expect(readNestedChats()).toBe(true);
    expect(readRunningOnly()).toBe(false);
  });

  it("survives localStorage throwing (private mode / quota)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readNestedChats()).toBe(true);
    expect(readRunningOnly()).toBe(false);
    expect(() => writeRunningOnly(true)).not.toThrow();
    expect(() => writeNestedChats(true)).not.toThrow();
  });
});
