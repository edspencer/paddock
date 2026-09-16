import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_UI, capMessages } from "../../src/ui-config.js";
import { loadPaddockConfig } from "../../src/config.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("capMessages (issue #914)", () => {
  const msgs = [1, 2, 3, 4, 5];

  it("returns the TRAILING n — the newest messages, not the oldest", () => {
    expect(capMessages(msgs, 2)).toEqual([4, 5]);
  });

  it("treats 0 as unlimited", () => {
    expect(capMessages(msgs, 0)).toBe(msgs);
  });

  it("returns everything when the list already fits", () => {
    expect(capMessages(msgs, 5)).toBe(msgs);
    expect(capMessages(msgs, 99)).toBe(msgs);
  });

  it("ignores a negative or non-integer limit rather than slicing oddly", () => {
    expect(capMessages(msgs, -3)).toBe(msgs);
    expect(capMessages(msgs, 2.5)).toBe(msgs);
  });

  it("handles an empty transcript", () => {
    expect(capMessages([], 10)).toEqual([]);
  });
});

describe("ui config resolution (issue #914)", () => {
  const ENV_KEYS = ["PADDOCK_DATA_DIR", "PADDOCK_UI_TRANSCRIPT_RENDER_LIMIT"] as const;
  const saved: Record<string, string | undefined> = {};
  let dir: string;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = makeTmpDir("ui-config");
    process.env.PADDOCK_DATA_DIR = dir;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmTmpDir(dir);
  });

  const limit = () => loadPaddockConfig().ui.transcriptRenderLimit;

  it("defaults to 500", () => {
    expect(DEFAULT_UI.transcriptRenderLimit).toBe(500);
    expect(limit()).toBe(500);
  });

  it("reads the env var", () => {
    process.env.PADDOCK_UI_TRANSCRIPT_RENDER_LIMIT = "120";
    expect(limit()).toBe(120);
  });

  it("accepts 0 (unlimited) — the floor is 0, not 1", () => {
    process.env.PADDOCK_UI_TRANSCRIPT_RENDER_LIMIT = "0";
    expect(limit()).toBe(0);
  });

  it("falls back to the default on a malformed value rather than failing boot", () => {
    for (const bad of ["nonsense", "-5", "1.5"]) {
      process.env.PADDOCK_UI_TRANSCRIPT_RENDER_LIMIT = bad;
      expect(limit()).toBe(DEFAULT_UI.transcriptRenderLimit);
    }
  });
});
