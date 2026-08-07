/**
 * Integration coverage for the instance-settings REST surface (issue #385),
 * driven through the REAL app via `app.inject`:
 *   - GET /api/instance-config → grouped shape with per-field flags, and — the
 *     part #722 was missing — what a SUBSEQUENT GET reports about a write that
 *     already landed (`pendingValue` / `pendingRestart` / `restartRequired`).
 *   - PUT /api/instance-config → writes only the editable allowlist to
 *     paddock.config.yaml (comment-preserving), rejects invalid + read-only,
 *     returns { restartRequired: true }, creates the file on first write, clears
 *     a key on `null` (#723), and refuses a stale conditional write (409).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { FIELDS } from "../../src/instance-config.js";

describe("integration: instance-config (#385)", () => {
  let t: TestApp;
  let configPath: string;
  // This suite WRITES fields through the API, and `env > file` — a PADDOCK_* var
  // leaked in from the shell (this repo's own dev box exports several) would make
  // those writes legitimately 400. Scrub every var any field references so the
  // suite asserts the code's behaviour and not the box's environment.
  const shadowVars = [...new Set(FIELDS.flatMap((f) => f.envVars))];
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of shadowVars) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    t = await startTestApp();
    configPath = path.join(t.cfg.dataDir, "paddock.config.yaml");
  });
  afterAll(async () => {
    await t.teardown();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const get = async () => (await t.app.inject({ method: "GET", url: "/api/instance-config" })).json();
  const put = async (body: unknown) =>
    t.app.inject({ method: "PUT", url: "/api/instance-config", payload: body as object });
  const readYaml = async () => parseYaml(await fs.readFile(configPath, "utf8")) as Record<string, any>;

  const flat = (body: { groups: { fields: { key: string }[] }[] }) =>
    Object.fromEntries(body.groups.flatMap((g) => g.fields).map((f) => [f.key, f]));

  it("GET returns grouped fields with value/default/editable flags", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/instance-config" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.restartRequired).toBe(false);
    expect(body.configPath).toBe(configPath);

    const fields = flat(body);
    expect(fields["curation.overviewMaxTokens"].editable).toBe(true);
    expect(fields["curation.overviewMaxTokens"].value).toBe(2000);
    expect(fields["port"].editable).toBe(false);
    expect(fields["auth.mode"].editable).toBe(false);
    // No secret keys are ever present.
    expect(fields["transcription.apiKey"]).toBeUndefined();
  });

  /**
   * The load-bearing assertion of #722, and the one this file never made: what a
   * GET reports AFTER a successful write. It used to report the pre-save values
   * for everything, so the editor re-fetched, rendered them, and looked like the
   * save had silently reverted.
   */
  it("PUT writes the editable allowlist, and the next GET reports it as pending", async () => {
    const before = await get();
    const res = await put({
      patch: { "curation.overviewMaxTokens": 2777, "brand.name": "Test Box" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().restartRequired).toBe(true);

    const raw = await fs.readFile(configPath, "utf8");
    expect(raw).toContain("2777");
    expect(raw).toContain("Test Box");

    const body = await get();
    const after = flat(body);
    // `value` is still the frozen boot value — writes genuinely don't hot-apply…
    expect(after["curation.overviewMaxTokens"].value).toBe(2000);
    // …but the write is now VISIBLE, which is what the editor renders.
    expect(after["curation.overviewMaxTokens"].pendingValue).toBe(2777);
    expect(after["curation.overviewMaxTokens"].pendingRestart).toBe(true);
    expect(after["brand.name"].pendingValue).toBe("Test Box");
    expect(body.restartRequired).toBe(true);
    expect(body.configVersion).not.toBe(before.configVersion);
    // Untouched fields don't get dragged into the restart claim.
    expect(after["brand.accent"].pendingRestart).toBe(false);
  });

  /**
   * Two tabs. Before #722 the second client's GET could not observe the first
   * one's write at all, so it re-saved over it with nothing able to notice.
   */
  it("a second client sees the first client's write, and a stale write is refused", async () => {
    const stale = (await get()).configVersion; // tab B's snapshot
    const res = await put({ patch: { "curation.overviewMaxTokens": 1111 } }); // tab A saves
    expect(res.statusCode).toBe(200);

    // Tab B, on its next load, sees A's value rather than the boot value.
    expect(flat(await get())["curation.overviewMaxTokens"].pendingValue).toBe(1111);

    // And a save composed against B's stale snapshot is refused, not merged away.
    const conflict = await put({ patch: { "curation.overviewMaxTokens": 2222 }, expectedVersion: stale });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("config_conflict");
    expect((await readYaml()).curation.overviewMaxTokens).toBe(1111); // A's write survives

    // Re-reading and saving again succeeds.
    const fresh = (await get()).configVersion;
    const ok = await put({ patch: { "curation.overviewMaxTokens": 2222 }, expectedVersion: fresh });
    expect(ok.statusCode).toBe(200);
    expect((await readYaml()).curation.overviewMaxTokens).toBe(2222);
    expect(ok.json().configVersion).not.toBe(fresh);
  });

  // Issue #723: `Number(null) === 0` passed the `>= 0` check, so "clear this
  // override" wrote a meaningful zero — no retries, no debounce.
  it("PUT with null clears a recovery key instead of writing 0 (#723)", async () => {
    await put({ patch: { "recovery.debounceMs": 4000, "recovery.maxRetries": 5 } });
    expect((await readYaml()).recovery).toMatchObject({ debounceMs: 4000, maxRetries: 5 });

    const res = await put({
      patch: {
        "recovery.debounceMs": null,
        "recovery.maxRetries": null,
        "recovery.limboTimeoutMs": null,
      },
    });
    expect(res.statusCode).toBe(200);

    const recovery = (await readYaml()).recovery ?? {};
    expect(recovery.debounceMs).toBeUndefined();
    expect(recovery.maxRetries).toBeUndefined();
    expect(recovery.limboTimeoutMs).toBeUndefined();

    // And the screen reports the built-in defaults as pending, not zeros.
    const fields = flat(await get());
    expect(fields["recovery.maxRetries"].pendingValue).toBe(fields["recovery.maxRetries"].default);
    expect(fields["recovery.debounceMs"].pendingValue).toBe(fields["recovery.debounceMs"].default);
  });

  it("PUT rejects a field the environment shadows", async () => {
    process.env.PADDOCK_BRAND_LOGO = "🚜";
    try {
      const res = await put({ patch: { "brand.logo": "🐴" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/PADDOCK_BRAND_LOGO/);
    } finally {
      delete process.env.PADDOCK_BRAND_LOGO;
    }
  });

  it("PUT rejects an unbounded string", async () => {
    const res = await put({ patch: { "brand.name": "x".repeat(200_000) } });
    expect(res.statusCode).toBe(400);
    expect((await fs.readFile(configPath, "utf8")).length).toBeLessThan(10_000);
  });

  it("PUT rejects a read-only key", async () => {
    const res = await t.app.inject({
      method: "PUT",
      url: "/api/instance-config",
      payload: { patch: { port: 9999 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/read-only/);
  });

  it("PUT rejects an invalid value", async () => {
    const res = await t.app.inject({
      method: "PUT",
      url: "/api/instance-config",
      payload: { patch: { "curation.overviewMaxTokens": -5 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/positive integer/);
  });

  it("PUT rejects a malformed body", async () => {
    const res = await t.app.inject({
      method: "PUT",
      url: "/api/instance-config",
      payload: { notPatch: true },
    });
    expect(res.statusCode).toBe(400);
  });
});
