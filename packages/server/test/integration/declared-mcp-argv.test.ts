/**
 * Where a declared MCP server's `env` ACTUALLY ends up once a turn runs — read
 * off a real spawn rather than inferred from anybody's source.
 *
 * `mcp-servers.ts` keeps a resolved credential out of every surface paddock
 * owns: the boot log, an error message, the Settings API. What the engine does
 * with the record afterwards is the rest of the story. Up to @herdctl/core
 * 5.33.1 the CLI runtime serialised the whole `mcp_servers` map into one
 * `--mcp-config '{"mcpServers":…}'` ARGUMENT, readable by any local process via
 * `/proc/<pid>/cmdline` — this file used to pin that as a characterisation test.
 * 5.33.2 (herdctl#467) writes the config to an owner-only (0600) temp file and
 * passes its PATH instead, so this now pins the fix:
 *
 *  1. the token is NOT in the spawned argv — the argument is a path;
 *  2. the file it names is 0600 and does hold the server, token included, and
 *     `mcp__notion__*` is allowlisted — so the server still reaches `claude` and
 *     can actually be called (the half that makes the feature work at all).
 *
 * If (1) starts failing, the exposure is back and `argvExposure` in
 * `mcp-servers.ts` (and the docs that repeat it) need widening again.
 *
 * Coverage boundary, stated honestly: this is the native CLI/batch runtime, the
 * only one whose argv is observable from outside a test. It does NOT cover a
 * `docker: true` project on batch: herdctl's Docker runner supplies its own
 * process spawner, and with one the config is still passed inline on the
 * `docker exec` command line — which is why `argvExposure` survives, narrowed to
 * that case. The SDK runtime (`driveMode: session`) never shells out at all.
 *
 * The token is synthetic and exists only in this file. `npx-not-real` is never
 * started: the fake `claude` on PATH is what gets spawned, and it only records
 * the flags it was given (and, for a path, what the file held).
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestApp, type TestApp } from "../helpers/app.js";
import { listen, connectWs, type WsClient, type WsEvent } from "../helpers/ws.js";

const SECRET = "ntn_SYNTHETIC_ARGV_SECRET_2222";

const isComplete = (slug: string) => (e: WsEvent) =>
  e.type === "chat:complete" && e.payload?.projectSlug === slug;

interface Invocation {
  prompt: string;
  allowedTools: string | null;
  mcpConfig: string | null;
  mcpConfigFile: { mode?: number; content?: string; error?: string } | null;
}

describe("integration: what a declared MCP server puts in the spawned argv (#691)", () => {
  let t: TestApp | undefined;
  let ws: WsClient | undefined;

  afterEach(async () => {
    ws?.close();
    ws = undefined;
    await t?.teardown();
    t = undefined;
  });

  it("keeps the credential off the command line under batch, in an owner-only file", async () => {
    const logPath = path.join(
      await fs.mkdtemp(path.join((await fs.realpath("/tmp")) + path.sep, "paddock-inv-")),
      "invocations.jsonl",
    );
    // The integration harness pins `driveMode: batch` (it drives turns through
    // the fake `claude`), which is exactly the runtime this test is about.
    t = await startTestApp({
      script: { "Hello there": "Hi!" },
      env: { PADDOCK_FAKE_INVOCATION_LOG: logPath, PADDOCK_TEST_NOTION_TOKEN: SECRET },
      configFile: {
        mcpServers: {
          notion: {
            command: "npx-not-real",
            env: { NOTION_TOKEN: "env:PADDOCK_TEST_NOTION_TOKEN" },
          },
        },
      },
    });
    await t.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Mcp Proj" } });
    const { port } = await listen(t.app);
    ws = await connectWs(port);

    const mark = ws.mark();
    ws.send({
      type: "chat:send",
      payload: { projectSlug: "mcp-proj", sessionId: null, message: "Hello there" },
    });
    await ws.waitFor(isComplete("mcp-proj"), { from: mark });

    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
    const turn = lines
      .map((l) => JSON.parse(l) as Invocation)
      .find((i) => i.prompt.includes("Hello there"));
    expect(turn, "the fake claude recorded no invocation for this turn").toBeDefined();

    // (1) The argument is a path, not the definition — and not the token.
    expect(turn!.mcpConfig).toBeTruthy();
    expect(turn!.mcpConfig!.trimStart().startsWith("{")).toBe(false);
    expect(path.isAbsolute(turn!.mcpConfig!)).toBe(true);
    expect(turn!.mcpConfig).not.toContain(SECRET);

    // (2) …the file it names is owner-only and carries the declared server,
    // resolved out of the environment, to the process that runs the model…
    const file = turn!.mcpConfigFile;
    expect(file?.error).toBeUndefined();
    expect(file?.mode).toBe(0o600);
    const parsed = JSON.parse(file!.content!) as {
      mcpServers: Record<string, { command?: string; env?: Record<string, string> }>;
    };
    expect(parsed.mcpServers.notion.command).toBe("npx-not-real");
    expect(parsed.mcpServers.notion.env?.NOTION_TOKEN).toBe(SECRET);
    // …and it is callable: without this pattern every one of its tools is
    // auto-denied with no prompt and nothing in the logs.
    expect(turn!.allowedTools).toContain("mcp__notion__*");
    // herdctl removes the file once the turn is over.
    await expect(fs.stat(turn!.mcpConfig!)).rejects.toThrow();
  }, 30_000);
});
