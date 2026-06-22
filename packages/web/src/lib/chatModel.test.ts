import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { chatModelKey, readChatModel, writeChatModel } from "./chatModel";

beforeEach(() => localStorage.clear());

describe("chatModel persistence", () => {
  it("keys an established chat by its session id", () => {
    expect(chatModelKey("sess-1", "proj")).toBe("paddock:chatModel:sess-1");
  });

  it("keys a brand-new chat (no session id) by new:<slug>", () => {
    expect(chatModelKey(null, "proj")).toBe("paddock:chatModel:new:proj");
    expect(chatModelKey(undefined, "scratch")).toBe("paddock:chatModel:new:scratch");
  });

  it("round-trips a saved model", () => {
    writeChatModel("sess-1", "proj", "claude-opus-4-8");
    expect(readChatModel("sess-1", "proj")).toBe("claude-opus-4-8");
  });

  it("returns null when nothing is stored", () => {
    expect(readChatModel("missing", "proj")).toBeNull();
  });

  it("treats an empty stored value as null", () => {
    localStorage.setItem("paddock:chatModel:sess-1", "");
    expect(readChatModel("sess-1", "proj")).toBeNull();
  });

  it("new-chat and established-chat keys are independent", () => {
    writeChatModel(null, "proj", "model-new");
    writeChatModel("sess-1", "proj", "model-established");
    expect(readChatModel(null, "proj")).toBe("model-new");
    expect(readChatModel("sess-1", "proj")).toBe("model-established");
  });
});

describe("chatModel resilience (private mode / quota)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("read never throws when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readChatModel("sess-1", "proj")).toBeNull();
  });

  it("write swallows a throwing setItem", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => writeChatModel("sess-1", "proj", "m")).not.toThrow();
  });
});
