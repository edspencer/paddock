/**
 * Unit tests for curation-config.ts (issue #384) — the per-project curation
 * budget override resolver + sanitizer, mirroring recovery-config's discipline.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_CURATION,
  resolveCurationConfig,
  sanitizeCurationOverride,
} from "../../src/curation-config.js";

const INSTANCE = { overviewMaxTokens: 2000, changelogMaxTokens: 8000, claudeMaxTokens: 6000 };

describe("sanitizeCurationOverride", () => {
  it("keeps only positive-integer budgets", () => {
    expect(
      sanitizeCurationOverride({
        overviewMaxTokens: 1500,
        changelogMaxTokens: 4000,
        claudeMaxTokens: 3000,
      }),
    ).toEqual({ overviewMaxTokens: 1500, changelogMaxTokens: 4000, claudeMaxTokens: 3000 });
  });

  it("drops non-positive / non-integer / non-number fields", () => {
    expect(
      sanitizeCurationOverride({
        overviewMaxTokens: 0, // not positive
        changelogMaxTokens: -5, // negative
        claudeMaxTokens: 3.5, // not integer
      }),
    ).toBeUndefined();
  });

  it("keeps the valid subset and drops the rest", () => {
    expect(
      sanitizeCurationOverride({ changelogMaxTokens: 3000, claudeMaxTokens: "nope" }),
    ).toEqual({ changelogMaxTokens: 3000 });
  });

  it("returns undefined for non-objects / empty / arrays", () => {
    expect(sanitizeCurationOverride(undefined)).toBeUndefined();
    expect(sanitizeCurationOverride(null)).toBeUndefined();
    expect(sanitizeCurationOverride({})).toBeUndefined();
    expect(sanitizeCurationOverride([1, 2])).toBeUndefined();
    expect(sanitizeCurationOverride("x")).toBeUndefined();
  });
});

describe("resolveCurationConfig", () => {
  it("inherits every instance default when there is no override", () => {
    expect(resolveCurationConfig(undefined, INSTANCE)).toEqual(INSTANCE);
  });

  it("overrides field-by-field; absent fields inherit", () => {
    expect(resolveCurationConfig({ changelogMaxTokens: 4000 }, INSTANCE)).toEqual({
      overviewMaxTokens: 2000, // inherited
      changelogMaxTokens: 4000, // overridden
      claudeMaxTokens: 6000, // inherited
    });
  });

  it("re-sanitises a corrupt override so a bad on-disk value can't leak through", () => {
    expect(
      resolveCurationConfig(
        { changelogMaxTokens: 4000, claudeMaxTokens: -1 } as never,
        INSTANCE,
      ),
    ).toEqual({ overviewMaxTokens: 2000, changelogMaxTokens: 4000, claudeMaxTokens: 6000 });
  });

  it("DEFAULT_CURATION is the documented 2000/8000/6000", () => {
    expect(DEFAULT_CURATION).toEqual(INSTANCE);
  });
});
