/**
 * Where a declared MCP server's `env` ACTUALLY ends up once a turn runs — read
 * off a real spawn rather than inferred from anybody's source.
 *
 * `mcp-servers.ts` keeps a resolved credential out of every surface paddock
 * owns: the boot log, an error message, the Settings API. That is complete, and
 * it is still not the whole story, because of what the engine does with the
 * record afterwards. herdctl's CLI runtime serialises the entire `mcp_servers`
 * map into one `--mcp-config '{"mcpServers":…}'` ARGUMENT, and a process
 * argument is not private on Linux: `/proc/<pid>/cmdline` is world-readable by
 * default and `ps` prints it.
 *
 * This is therefore a **characterisation test** — it pins behaviour paddock does
 * not want and cannot fix from here, so that the boot warning is grounded in an
 * observation rather than in a reading of someone else's dist bundle. Its two
 * assertions point in opposite directions on purpose:
 *
 *  1. the token IS in the spawned argv (the exposure is real, so the warning is
 *     warranted);
 *  2. `mcp__notion__*` is in the same argv (the server can actually be called —
 *     the half that makes the feature work at all).
 *
 * **If (1) starts failing, that is good news.** It means the engine learned to
 * pass `--mcp-config` as a file path (the Claude CLI accepts one) or the runtime
 * changed. Delete this test and the warning with it rather than "fixing" it.
 *
 * Coverage boundary, stated honestly: this is the CLI/batch runtime, the only
 * one whose argv is observable from outside a test — the SDK runtime resolves
 * its own bundled binary and never shells out. The SDK path does not have this
 * problem: it hands the same record to the SDK in-process, and the stdio server
 * it spawns gets the value in its environment, where `/proc/<pid>/environ` is
 * owner-only. That is where Claude Code itself puts it.
 *
 * The token is synthetic and exists only in this file. `npx-not-real` is never
 * started: the fake `claude` on PATH is what gets spawned, and it only records
 * the flags it was given.
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

  it("passes the whole definition — credential included — on the command line under batch", async () => {
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

    // The declared server reached the process that runs the model: declared in
    // paddock.config.yaml, resolved out of the environment, spawned into argv.
    expect(turn!.mcpConfig).toBeTruthy();
    const parsed = JSON.parse(turn!.mcpConfig!) as {
      mcpServers: Record<string, { command?: string; env?: Record<string, string> }>;
    };
    expect(parsed.mcpServers.notion.command).toBe("npx-not-real");
    // (2) …and it is callable: without this pattern every one of its tools is
    // auto-denied with no prompt and nothing in the logs.
    expect(turn!.allowedTools).toContain("mcp__notion__*");
    // (1) …and the credential is right there on the command line. See the header:
    // this assertion failing is an upstream improvement, not a regression here.
    expect(parsed.mcpServers.notion.env?.NOTION_TOKEN).toBe(SECRET);
    expect(turn!.mcpConfig).toContain(SECRET);
  }, 30_000);
});
