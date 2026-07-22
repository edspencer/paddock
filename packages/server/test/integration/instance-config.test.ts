/**
 * Integration coverage for the instance-settings REST surface (issue #385),
 * driven through the REAL app via `app.inject`:
 *   - GET /api/instance-config → grouped shape with per-field flags
 *   - PUT /api/instance-config → writes only the editable allowlist to
 *     paddock.config.yaml (comment-preserving), rejects invalid + read-only,
 *     returns { restartRequired: true }, and creates the file on first write.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";

describe("integration: instance-config (#385)", () => {
  let t: TestApp;
  let configPath: string;

  beforeAll(async () => {
    t = await startTestApp();
    configPath = path.join(t.cfg.dataDir, "paddock.config.yaml");
  });
  afterAll(async () => {
    await t.teardown();
  });

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

  it("PUT writes the editable allowlist and reports restartRequired", async () => {
    const res = await t.app.inject({
      method: "PUT",
      url: "/api/instance-config",
      payload: { patch: { "curation.overviewMaxTokens": 2777, "brand.name": "Test Box" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().restartRequired).toBe(true);

    const raw = await fs.readFile(configPath, "utf8");
    expect(raw).toContain("2777");
    expect(raw).toContain("Test Box");

    // GET still reports the OLD (frozen) values — writes don't hot-apply.
    const after = flat((await t.app.inject({ method: "GET", url: "/api/instance-config" })).json());
    expect(after["curation.overviewMaxTokens"].value).toBe(2000);
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
