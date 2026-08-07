/**
 * Schema versioning for paddock's two on-disk formats (issue #724).
 *
 * The property under test throughout is the DOWNGRADE guard, not migrations:
 * a file written by a newer paddock must never be lenient-parsed, because
 * `ProjectStore.normalize` drops keys it doesn't recognise and the next write
 * persists the loss. The two formats guard asymmetrically on purpose —
 * `paddock.config.yaml` refuses the boot, a `project.yaml` is skipped loudly —
 * and both halves are asserted here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadPaddockConfig } from "../../src/config.js";
import { ProjectStore } from "../../src/projects.js";
import { instanceConfigPath, writeInstanceConfig } from "../../src/instance-config.js";
import {
  CONFIG_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  configSchemaRefusal,
  projectSchemaSkip,
  readSchemaVersion,
} from "../../src/schema-version.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("readSchemaVersion: what a file's own claim about its shape reads as", () => {
  it("treats an ABSENT version as 1 — the shape every pre-adoption file has", () => {
    // The whole adoption story: nothing on a live instance needs rewriting,
    // because those files genuinely ARE version 1.
    expect(readSchemaVersion(undefined)).toBe(1);
    expect(readSchemaVersion(null)).toBe(1);
  });

  it("reads an integer, and a string spelling one (hand-quoted YAML)", () => {
    expect(readSchemaVersion(1)).toBe(1);
    expect(readSchemaVersion(7)).toBe(7);
    expect(readSchemaVersion("2")).toBe(2);
    expect(readSchemaVersion(" 3 ")).toBe(3);
  });

  it("returns null for a claim it cannot make sense of, rather than guessing 1", () => {
    // Guessing 1 would send an unreadable file down the lenient path — exactly
    // the rewrite this mechanism exists to prevent. Callers treat null like a
    // from-the-future version.
    for (const bad of [0, -1, 1.5, "banana", "", true, {}, []]) {
      expect(readSchemaVersion(bad)).toBeNull();
    }
  });
});

describe("the refusal/skip messages", () => {
  it("names the file, BOTH versions, and what to do about it", () => {
    const msg = configSchemaRefusal(9, "/data/paddock.config.yaml")!;
    expect(msg).toMatch(/refusing to start/);
    expect(msg).toContain("/data/paddock.config.yaml");
    expect(msg).toContain("version 9");
    expect(msg).toContain(`version ${CONFIG_SCHEMA_VERSION}`);
    expect(msg).toMatch(/upgrade paddock/i);
  });

  it("says nothing for a file at or below this build's version", () => {
    expect(configSchemaRefusal(undefined, "/x")).toBeUndefined();
    expect(configSchemaRefusal(CONFIG_SCHEMA_VERSION, "/x")).toBeUndefined();
    expect(projectSchemaSkip(undefined, "/x")).toBeUndefined();
    expect(projectSchemaSkip(PROJECT_SCHEMA_VERSION, "/x")).toBeUndefined();
  });

  it("promises, in the project message, that the file is left alone", () => {
    const msg = projectSchemaSkip(4, "/data/projects/futuristic/project.yaml")!;
    expect(msg).toContain("/data/projects/futuristic/project.yaml");
    expect(msg).toContain("version 4");
    expect(msg).toMatch(/NOT deleted/);
  });
});

describe("project.yaml: schemaVersion (#724)", () => {
  let root: string;
  let dataDir: string;
  let store: ProjectStore;
  let warnings: string[];

  /** Write a `project.yaml` by hand, to stand in for one another paddock wrote. */
  const writeYaml = async (slug: string, lines: string[]): Promise<void> => {
    await fsp.mkdir(path.join(root, slug), { recursive: true });
    await fsp.writeFile(path.join(root, slug, "project.yaml"), lines.join("\n"), "utf8");
  };
  const readYaml = (slug: string): Promise<string> =>
    fsp.readFile(path.join(root, slug, "project.yaml"), "utf8");

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-data-");
    root = path.join(dataDir, "projects");
    await fsp.mkdir(root, { recursive: true });
    warnings = [];
    store = new ProjectStore(root, dataDir, { warn: (m) => warnings.push(m) });
    await store.init();
  });
  afterEach(async () => {
    await rmTmpDir(dataDir);
  });

  // --- adoption costs nothing ------------------------------------------------

  it("reads a file with NO schemaVersion, and does not rewrite it to add one", async () => {
    // The load-bearing case. Every `project.yaml` on every live instance today
    // is this file. Merely listing must leave it byte-identical — a read that
    // stamped the version would be exactly the unrequested rewrite the guard
    // exists to prevent. (Same property `linked-project.test.ts` asserts for
    // `managed`.)
    const lines = [
      "name: Legacy",
      "slug: legacy",
      "status: active",
      "started: 2025-01-01",
      "repo: https://github.com/owner/thing.git",
      "",
    ];
    await writeYaml("legacy", lines);

    const listed = await store.list();
    expect(listed.map((p) => p.slug)).toEqual(["legacy"]);
    expect(await readYaml("legacy")).toBe(lines.join("\n"));
    expect(warnings).toEqual([]);
  });

  it("writes schemaVersion explicitly on a NEW project", async () => {
    const created = await store.create({ name: "Notes" });
    const raw = YAML.parse(await fsp.readFile(path.join(created.dir, "project.yaml"), "utf8"));
    expect(raw.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it("gains the field when a legacy file is next written for some OTHER reason", async () => {
    // No backfill pass exists; this is the whole adoption mechanism.
    await writeYaml("legacy", [
      "name: Legacy",
      "slug: legacy",
      "status: active",
      "started: 2025-01-01",
      "",
    ]);
    expect(YAML.parse(await readYaml("legacy")).schemaVersion).toBeUndefined();

    await store.update("legacy", { summary: "now with a summary" });

    const raw = YAML.parse(await readYaml("legacy"));
    expect(raw.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(raw.summary).toBe("now with a summary");
  });

  it("round-trips a project already AT the current version unchanged", async () => {
    const created = await store.create({ name: "Current" });
    const before = await readYaml(created.slug);

    await store.list();
    await store.get(created.slug);

    expect(await readYaml(created.slug)).toBe(before);
  });

  // --- the guard -------------------------------------------------------------

  it("SKIPS a project from the future, warns once, and leaves the file untouched", async () => {
    const lines = [
      "schemaVersion: 99",
      "name: Futuristic",
      "slug: futuristic",
      "status: active",
      "started: 2025-01-01",
      "somethingWeHaveNeverHeardOf: keep me",
      "",
    ];
    await writeYaml("futuristic", lines);
    await writeYaml("ordinary", [
      "name: Ordinary",
      "slug: ordinary",
      "status: active",
      "started: 2025-01-01",
      "",
    ]);

    // Skipped, but the rest of the instance is unaffected: one bad project dir
    // must not brick the box, which is why this is not a refusal.
    const listed = await store.list();
    expect(listed.map((p) => p.slug)).toEqual(["ordinary"]);

    // Loud, not silent — today an unreadable file just vanishes with no word.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("futuristic");
    expect(warnings[0]).toContain("version 99");

    // And, the point of the whole exercise: the bytes are exactly as we found
    // them, unknown key included.
    expect(await readYaml("futuristic")).toBe(lines.join("\n"));

    // Repeated listing does not re-warn — `list()` runs on every GET /api/projects.
    await store.list();
    await store.list();
    expect(warnings).toHaveLength(1);
  });

  it("refuses to hand the record to any mutator, so nothing can rewrite it", async () => {
    const lines = [
      "schemaVersion: 99",
      "name: Futuristic",
      "slug: futuristic",
      "status: active",
      "started: 2025-01-01",
      "keepMe: yes",
      "",
    ];
    await writeYaml("futuristic", lines);

    await expect(store.get("futuristic")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.update("futuristic", { summary: "clobbered" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await readYaml("futuristic")).toBe(lines.join("\n"));
  });

  it("treats an unreadable version claim the same as one from the future", async () => {
    // We cannot establish that this file is safe to rewrite, so we don't.
    const lines = [
      "schemaVersion: banana",
      "name: Odd",
      "slug: odd",
      "status: active",
      "started: 2025-01-01",
      "",
    ];
    await writeYaml("odd", lines);

    expect(await store.list()).toEqual([]);
    expect(warnings[0]).toMatch(/unreadable/);
    expect(await readYaml("odd")).toBe(lines.join("\n"));
  });

  it("hides the ROOT workspace too rather than flattening it to defaults", async () => {
    // The root's record is normally optional — an absent one means "nothing
    // customised yet" and every field falls back to a default. That fallback is
    // precisely what a subsequent write would flatten a from-the-future root to,
    // so the guard must reach it as well.
    await fsp.writeFile(
      path.join(root, "project.yaml"),
      ["schemaVersion: 99", "name: The Instance", "summary: from tomorrow", ""].join("\n"),
      "utf8",
    );

    await expect(store.get("")).rejects.toMatchObject({ code: "not_found" });
    expect(warnings[0]).toContain("version 99");
  });
});

describe("paddock.config.yaml: schemaVersion (#724)", () => {
  // Cleared so the file layer is observed in isolation, and so an ambient
  // CLAUDE_CONFIG_DIR on the dev box cannot trip the unrelated claudeHome refusal.
  const ENV_KEYS = ["PADDOCK_DATA_DIR", "PADDOCK_CONFIG", "CLAUDE_CONFIG_DIR", "PORT"];

  let dataDir: string;
  let saved: Record<string, string | undefined>;

  const writeConfig = (body: string): string => {
    const p = path.join(dataDir, "paddock.config.yaml");
    fs.writeFileSync(p, body, "utf8");
    return p;
  };

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-config-schema-");
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PADDOCK_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  it("loads a file with NO schemaVersion exactly as before", () => {
    writeConfig("port: 5123\n");
    expect(loadPaddockConfig().port).toBe(5123);
  });

  it("loads a file at the current version", () => {
    writeConfig(`schemaVersion: ${CONFIG_SCHEMA_VERSION}\nport: 5124\n`);
    expect(loadPaddockConfig().port).toBe(5124);
  });

  it("REFUSES TO START on a config from the future, naming both versions", () => {
    // Fail-closed, like the claudeHome refusal: an instance config governs auth
    // mode and bind host, and half-understanding those is worse than not booting.
    const p = writeConfig("schemaVersion: 42\nport: 5125\n");
    expect(() => loadPaddockConfig()).toThrow(/refusing to start/);
    expect(() => loadPaddockConfig()).toThrow(/version 42/);
    expect(() => loadPaddockConfig()).toThrow(new RegExp(`version ${CONFIG_SCHEMA_VERSION}`));
    expect(() => loadPaddockConfig()).toThrow(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("leaves the from-the-future file untouched on disk", () => {
    const body = "schemaVersion: 42\nport: 5126\naKeyThisBuildHasNeverSeen: keep me\n";
    const p = writeConfig(body);
    expect(() => loadPaddockConfig()).toThrow();
    expect(fs.readFileSync(p, "utf8")).toBe(body);
  });

  it("refuses an unreadable version claim rather than assuming it is v1", () => {
    writeConfig("schemaVersion: banana\nport: 5127\n");
    expect(() => loadPaddockConfig()).toThrow(/refusing to start/);
  });

  it("stamps the version when writing a file that does not declare one", () => {
    // Adoption for the config file: the first settings save picks it up. Written
    // only when absent — this write is a partial patch over a round-tripped
    // document, so it is not in a position to restate the whole file's version.
    writeConfig("# operator's own comment\nport: 5128\n");
    const cfg = loadPaddockConfig();
    const p = instanceConfigPath(cfg);

    writeInstanceConfig(p, [{ key: "logLevel", value: "debug" }]);

    const after = fs.readFileSync(p, "utf8");
    expect(YAML.parse(after).schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(YAML.parse(after).port).toBe(5128);
    expect(after).toContain("operator's own comment");
  });

  it("creates a brand-new config file already carrying the version", () => {
    const p = path.join(dataDir, "paddock.config.yaml");
    writeInstanceConfig(p, [{ key: "logLevel", value: "debug" }]);
    expect(YAML.parse(fs.readFileSync(p, "utf8")).schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
  });
});
