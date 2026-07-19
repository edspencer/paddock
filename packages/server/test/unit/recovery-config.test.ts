/**
 * Unit tests for the keeper-chat recovery config primitives (issue #301, Phase 0):
 * the defaults, the killed/stopped status classifier, the untrusted-override
 * sanitiser, and the per-project-else-instance resolver. Pure functions — no env,
 * no fs — so the tri-state resolution + defensive coercion are pinned precisely.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RECOVERY,
  isTerminatedTaskStatus,
  resolveRecoveryConfig,
  sanitizeRecoveryOverride,
  type RecoveryConfig,
} from "../../src/recovery-config.js";

describe("DEFAULT_RECOVERY", () => {
  it("has Layer 2 ON, Layer 3 OFF, guards at documented values", () => {
    expect(DEFAULT_RECOVERY).toEqual({
      surfaceKilledTask: true,
      autoReDrive: false,
      debounceMs: 5000,
      maxRetries: 1,
      limboTimeoutMs: 0,
    });
  });
});

describe("isTerminatedTaskStatus", () => {
  it.each(["killed", "stopped", "KILLED", " Stopped "])("treats %j as terminated", (s) => {
    expect(isTerminatedTaskStatus(s)).toBe(true);
  });
  it.each(["completed", "running", "timed out", "", null, undefined])(
    "treats %j as not terminated",
    (s) => {
      expect(isTerminatedTaskStatus(s)).toBe(false);
    },
  );
});

describe("sanitizeRecoveryOverride", () => {
  it("keeps only valid fields, dropping wrong-typed ones", () => {
    expect(
      sanitizeRecoveryOverride({
        surfaceKilledTask: false,
        autoReDrive: "yes", // wrong type → dropped
        debounceMs: 1234,
        maxRetries: -1, // negative → dropped
        limboTimeoutMs: 2.5, // non-integer → dropped
      }),
    ).toEqual({ surfaceKilledTask: false, debounceMs: 1234 });
  });

  it("returns undefined for a non-object / empty / all-invalid value", () => {
    expect(sanitizeRecoveryOverride(undefined)).toBeUndefined();
    expect(sanitizeRecoveryOverride(null)).toBeUndefined();
    expect(sanitizeRecoveryOverride([])).toBeUndefined();
    expect(sanitizeRecoveryOverride("nope")).toBeUndefined();
    expect(sanitizeRecoveryOverride({})).toBeUndefined();
    expect(sanitizeRecoveryOverride({ autoReDrive: 1, maxRetries: "x" })).toBeUndefined();
  });

  it("accepts 0 for the numeric knobs (a valid non-negative integer)", () => {
    expect(sanitizeRecoveryOverride({ debounceMs: 0, limboTimeoutMs: 0 })).toEqual({
      debounceMs: 0,
      limboTimeoutMs: 0,
    });
  });
});

describe("resolveRecoveryConfig", () => {
  const instance: RecoveryConfig = {
    surfaceKilledTask: true,
    autoReDrive: false,
    debounceMs: 5000,
    maxRetries: 1,
    limboTimeoutMs: 0,
  };

  it("inherits every field from the instance default when there is no override", () => {
    expect(resolveRecoveryConfig(undefined, instance)).toEqual(instance);
  });

  it("lets a per-project override win field-by-field, inheriting the rest", () => {
    expect(
      resolveRecoveryConfig({ surfaceKilledTask: false, autoReDrive: true }, instance),
    ).toEqual({
      surfaceKilledTask: false,
      autoReDrive: true,
      debounceMs: 5000,
      maxRetries: 1,
      limboTimeoutMs: 0,
    });
  });

  it("ignores invalid override fields (a corrupt on-disk value can't leak through)", () => {
    const corrupt = { surfaceKilledTask: "no", debounceMs: -5 } as unknown as Parameters<
      typeof resolveRecoveryConfig
    >[0];
    expect(resolveRecoveryConfig(corrupt, instance)).toEqual(instance);
  });

  it("honours an override that turns a knob to 0", () => {
    expect(resolveRecoveryConfig({ debounceMs: 0 }, instance).debounceMs).toBe(0);
  });
});
