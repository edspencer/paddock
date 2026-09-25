import { describe, it, expect } from "vitest";
import {
  MODELS,
  DEFAULT_MODEL,
  SWEEPER_DEFAULT_MODEL,
  isKnownModel,
  getContextLimit,
  getModelInfo,
  resolveModels,
  resolveDefaultModel,
  DRIVE_MODES,
  DEFAULT_DRIVE_MODE,
  isKnownDriveMode,
} from "../../src/models.js";

describe("models", () => {
  it("exposes the picker list in order with the keeper default first", () => {
    expect(MODELS.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
    expect(MODELS[0].id).toBe(DEFAULT_MODEL);
  });

  it("defaults: keeper = Opus, sweeper = Haiku", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(SWEEPER_DEFAULT_MODEL).toBe("claude-haiku-4-5-20251001");
    expect(isKnownModel(DEFAULT_MODEL)).toBe(true);
    expect(isKnownModel(SWEEPER_DEFAULT_MODEL)).toBe(true);
  });

  it("isKnownModel rejects unknown ids", () => {
    expect(isKnownModel("gpt-4")).toBe(false);
    expect(isKnownModel("")).toBe(false);
  });

  it("getContextLimit returns the model's limit, 200k fallback for unknown", () => {
    // Opus runs a 1M context window on the Max plan.
    expect(getContextLimit("claude-opus-5-5")).toBe(1_000_000);
    expect(getContextLimit("claude-opus-5")).toBe(1_000_000);
    expect(getContextLimit("claude-opus-4-8")).toBe(1_000_000);
    expect(getContextLimit("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(getContextLimit("nope")).toBe(200_000);
  });

  it("getModelInfo returns the full info or undefined", () => {
    expect(getModelInfo("claude-fable-5")).toEqual({
      id: "claude-fable-5",
      label: "Fable 5",
      contextLimit: 1_000_000,
      pricing: { inputPer1M: 10, outputPer1M: 50 },
    });
    expect(getModelInfo("claude-fable-5-1")).toEqual({
      id: "claude-fable-5-1",
      label: "Fable 5.1",
      contextLimit: 1_000_000,
      pricing: { inputPer1M: 10, outputPer1M: 50, cacheReadMultiplier: 0.025 },
    });
    // Opus 5.5 is the second model to depart from the standard 0.1× cache read.
    expect(getModelInfo("claude-opus-5-5")).toEqual({
      id: "claude-opus-5-5",
      label: "Opus 5.5",
      contextLimit: 1_000_000,
      pricing: { inputPer1M: 4, outputPer1M: 20, cacheReadMultiplier: 0.05 },
    });
    // Pinned because we shipped $3/$15 for a price rise that was cancelled; the
    // standard price is $2/$10. Guards against re-importing the stale schedule.
    expect(getModelInfo("claude-sonnet-5")).toEqual({
      id: "claude-sonnet-5",
      label: "Sonnet 5",
      contextLimit: 1_000_000,
      pricing: { inputPer1M: 2, outputPer1M: 10 },
    });
    expect(getModelInfo("nope")).toBeUndefined();
  });

  it("resolveModels: undefined/empty allow-list returns the full catalog", () => {
    expect(resolveModels()).toBe(MODELS);
    expect(resolveModels(undefined)).toBe(MODELS);
    expect(resolveModels([])).toBe(MODELS);
  });

  it("resolveModels: a subset preserves catalog order + metadata, ignoring unknown ids", () => {
    // Ids given out of catalog order + an unknown one; the result stays in
    // catalog order and drops the unknown.
    const out = resolveModels(["claude-sonnet-5", "gpt-4", "claude-opus-5"]);
    expect(out.map((m) => m.id)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    // The entries are the catalog's own ModelInfo objects (metadata intact).
    expect(out[0]).toBe(getModelInfo("claude-opus-5"));
    expect(out[1].contextLimit).toBe(1_000_000);
  });

  it("resolveModels: an all-unknown allow-list resolves empty (loader collapses that to all)", () => {
    expect(resolveModels(["gpt-4", "nope"])).toEqual([]);
  });

  it("resolveDefaultModel: keeper default when offered, else the first offered model", () => {
    // Keeper default present → it wins regardless of position. Note the
    // allow-list must actually CONTAIN DEFAULT_MODEL for this to test anything:
    // an allow-list of other models would return its first catalog entry and
    // pass for the wrong reason.
    expect(resolveDefaultModel(resolveModels(["claude-sonnet-5", DEFAULT_MODEL]))).toBe(
      DEFAULT_MODEL,
    );
    // A non-default Opus does NOT become the default just by being offered.
    expect(resolveDefaultModel(resolveModels(["claude-sonnet-5", "claude-opus-5"]))).toBe(
      "claude-opus-5",
    );
    // Keeper default NOT offered → first entry (catalog order) is the default.
    expect(resolveDefaultModel(resolveModels(["claude-sonnet-5", "claude-haiku-4-5-20251001"]))).toBe(
      "claude-sonnet-5",
    );
    // Empty list → fall back to the keeper default id (never undefined).
    expect(resolveDefaultModel([])).toBe(DEFAULT_MODEL);
    // Full catalog → the keeper default.
    expect(resolveDefaultModel(MODELS)).toBe(DEFAULT_MODEL);
  });

  it("driveMode: batch/session are known, default is session (#316)", () => {
    expect(DRIVE_MODES).toEqual(["batch", "session"]);
    expect(DEFAULT_DRIVE_MODE).toBe("session");
    expect(isKnownDriveMode("batch")).toBe(true);
    expect(isKnownDriveMode("session")).toBe(true);
    expect(isKnownDriveMode("turbo")).toBe(false);
    expect(isKnownDriveMode("")).toBe(false);
  });
});
