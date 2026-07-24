/**
 * Unit tests for the safe-by-default bind guard (#435).
 *
 * Two surfaces:
 *  - `isLoopbackHost` / `evaluateBindSafety` — the pure decision logic (the full
 *    matrix: loopback vs non-loopback × auth mode × dangerously-open opt-in).
 *  - `buildApp` wiring — a refuse decision actually fails the boot closed (the
 *    guard runs before any heavy init, so this needs no fake-claude fleet).
 */
import { describe, it, expect, afterEach } from "vitest";
import { isLoopbackHost, evaluateBindSafety } from "../../src/bind-safety.js";
import { loadPaddockConfig, type PaddockConfig } from "../../src/config.js";
import { buildApp } from "../../src/app.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("isLoopbackHost", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "localhost",
    "LOCALHOST",
    "::1",
    "[::1]",
    " 127.0.0.1 ",
    "::ffff:127.0.0.1",
  ])("treats %s as loopback", (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });

  it.each([
    "0.0.0.0",
    "::",
    "192.168.1.10",
    "10.0.0.5",
    "0.0.0.0:4000",
    "example.com",
    "128.0.0.1",
    "",
  ])("treats %s as NON-loopback", (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("evaluateBindSafety", () => {
  it("allows a loopback bind with auth=none (the default posture)", () => {
    const d = evaluateBindSafety({ host: "127.0.0.1", authMode: "none", dangerouslyAllowOpen: false });
    expect(d.action).toBe("allow");
  });

  it("refuses a non-loopback bind with auth=none and no override", () => {
    const d = evaluateBindSafety({ host: "0.0.0.0", authMode: "none", dangerouslyAllowOpen: false });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") {
      expect(d.message).toMatch(/refusing to start/);
      expect(d.message).toMatch(/PADDOCK_DANGEROUSLY_ALLOW_OPEN/);
    }
  });

  it("downgrades to a loud warning when the dangerous override is set", () => {
    const d = evaluateBindSafety({ host: "0.0.0.0", authMode: "none", dangerouslyAllowOpen: true });
    expect(d.action).toBe("warn");
    if (d.action === "warn") {
      expect(d.message).toMatch(/OPEN and UNAUTHENTICATED/);
    }
  });

  it.each(["trusted-header", "jwt"] as const)(
    "allows a non-loopback bind with a real auth mode (%s), no flag needed",
    (authMode) => {
      const d = evaluateBindSafety({ host: "0.0.0.0", authMode, dangerouslyAllowOpen: false });
      expect(d.action).toBe("allow");
    },
  );

  it("does not require the override when auth gates a non-loopback bind", () => {
    // A real auth mode makes the override irrelevant.
    const d = evaluateBindSafety({ host: "10.0.0.5", authMode: "jwt", dangerouslyAllowOpen: false });
    expect(d.action).toBe("allow");
  });
});

describe("buildApp bind-safety wiring (#435)", () => {
  let dataDir: string | undefined;
  const saved = { ...process.env };

  afterEach(async () => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
    if (dataDir) await rmTmpDir(dataDir);
    dataDir = undefined;
  });

  /** A resolved config pointed at a throwaway data dir, with overrides applied. */
  async function makeConfig(over: Partial<PaddockConfig>): Promise<PaddockConfig> {
    dataDir = await makeTmpDir("paddock-bind-");
    process.env.PADDOCK_DATA_DIR = dataDir;
    const base = loadPaddockConfig();
    return { ...base, ...over } as PaddockConfig;
  }

  it("fails the boot closed on a non-loopback bind with auth=none", async () => {
    const config = await makeConfig({
      host: "0.0.0.0",
      auth: { ...loadPaddockConfig().auth, mode: "none" },
      dangerouslyAllowOpen: false,
    });
    await expect(buildApp({ config, serveStatic: false })).rejects.toThrow(/refusing to start/);
  });
});
