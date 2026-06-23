import { describe, it, expect } from "vitest";
import {
  MODELS,
  KEEPER_DEFAULT_MODEL,
  SWEEPER_DEFAULT_MODEL,
  isKnownModel,
  getContextLimit,
  getModelInfo,
} from "../../src/models.js";

describe("models", () => {
  it("exposes the picker list in order with the keeper default first", () => {
    expect(MODELS.map((m) => m.id)).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]);
    expect(MODELS[0].id).toBe(KEEPER_DEFAULT_MODEL);
  });

  it("defaults: keeper = Opus, sweeper = Haiku", () => {
    expect(KEEPER_DEFAULT_MODEL).toBe("claude-opus-4-8");
    expect(SWEEPER_DEFAULT_MODEL).toBe("claude-haiku-4-5-20251001");
    expect(isKnownModel(KEEPER_DEFAULT_MODEL)).toBe(true);
    expect(isKnownModel(SWEEPER_DEFAULT_MODEL)).toBe(true);
  });

  it("isKnownModel rejects unknown ids", () => {
    expect(isKnownModel("gpt-4")).toBe(false);
    expect(isKnownModel("")).toBe(false);
  });

  it("getContextLimit returns the model's limit, 200k fallback for unknown", () => {
    // Opus 4.8 runs a 1M context window on the Max/CLI runtime.
    expect(getContextLimit("claude-opus-4-8")).toBe(1_000_000);
    expect(getContextLimit("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(getContextLimit("nope")).toBe(200_000);
  });

  it("getModelInfo returns the full info or undefined", () => {
    expect(getModelInfo("claude-sonnet-4-6")).toEqual({
      id: "claude-sonnet-4-6",
      label: "Sonnet 4.6",
      contextLimit: 1_000_000,
    });
    expect(getModelInfo("nope")).toBeUndefined();
  });
});
