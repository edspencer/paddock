/**
 * #955, end to end: an agent's auto-memory write must LAND, through the real
 * Claude Code binary, with the agent config paddock actually builds.
 *
 * The earlier #690 test pinned the literal memory path and could not see that
 * the harness resolves symlinks before deciding whether a write is a memory
 * write — so it stayed green while every memory write was being denied. This
 * one asks the binary.
 *
 * The model is a ~60-line in-process stub of the Messages API: it reads the
 * memory directory out of the system prompt Claude Code sends — exactly what a
 * model is told — and answers with a `Write` to `<that dir>/probe.md`, then
 * records the tool result. No credentials, no network, a dummy API key.
 *
 * Driven through herdctl's own `SDKRuntime` with the config from
 * `buildAgentConfig` plus the fleet-default tool lists every keeper inherits,
 * so the whole chain — paddock config → herdctl `settings` passthrough → SDK
 * `settings` option → flag-tier setting in the binary — is what is under test.
 * Skipped where the SDK's platform binary is not installed.
 *
 * Why the control is `host`: under `own` the symlink resolves into `.chats/`,
 * an ordinary path the inherited `Write` allow rule already covers, so the
 * write succeeds even without the fix. Under `host` it resolves into the
 * user's `~/.claude`, a protected path no allow rule can pre-approve — the
 * "which is a sensitive file … resolves through a symlink" denial in #955.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createRequire } from "node:module";
import { existsSync, promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { SDKRuntime } from "@herdctl/core";
import { resolveAutoMemoryDir } from "../../src/auto-memory.js";
import { buildAgentConfig } from "../../src/herdctl-agent-config.js";
import { DENIED_TOOLS, FLEET_ALLOWED_TOOLS } from "../../src/herdctl-agent-names.js";
import { EMPTY_MCP_SOURCES } from "../../src/claude-mcp.js";
import { EMPTY_HOST_PLUGINS } from "../../src/claude-plugins.js";
import { ensureProjectChats, type TranscriptsMode } from "../../src/transcripts.js";
import type { PaddockConfig } from "../../src/config.js";
import type { Project } from "../../src/projects.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

function platformBinary(): string | undefined {
  const require = createRequire(import.meta.url);
  try {
    const pkg = require.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    );
    const bin = path.join(path.dirname(pkg), process.platform === "win32" ? "claude.exe" : "claude");
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

interface ToolResult {
  isError: boolean;
  text: string;
}

/** A Messages API that writes one memory file, then reports what happened. */
function startStub(): Promise<{
  url: string;
  results: ToolResult[];
  memoryDirs: string[];
  requests: () => number;
  close: () => void;
}> {
  const results: ToolResult[] = [];
  const memoryDirs: string[] = [];
  let requests = 0;
  const usage = { input_tokens: 1, output_tokens: 1 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(404).end();
        return;
      }
      requests++;
      const j = JSON.parse(body) as {
        model: string;
        system?: unknown;
        tools?: Array<{ name: string }>;
        messages: Array<{ content: unknown }>;
      };
      const last = j.messages.at(-1)?.content;
      const toolResult = Array.isArray(last)
        ? (last as Array<{ type: string; is_error?: boolean; content?: unknown }>).find(
            (b) => b.type === "tool_result",
          )
        : undefined;
      const memoryDir = JSON.stringify(j.system ?? "").match(/(\/[^"\\\s]*\/memory\/)/)?.[1];
      if (memoryDir) memoryDirs.push(memoryDir);
      const canWrite = (j.tools ?? []).some((t) => t.name === "Write");

      const events: Array<[string, Record<string, unknown>]> = [
        ["message_start", { message: { id: `msg_${requests}`, type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, usage } }],
      ];
      const text = (t: string) => {
        events.push(
          ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { index: 0, delta: { type: "text_delta", text: t } }],
          ["content_block_stop", { index: 0 }],
          ["message_delta", { delta: { stop_reason: "end_turn" }, usage }],
        );
      };
      if (toolResult) {
        const t = typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content);
        results.push({ isError: toolResult.is_error === true, text: t });
        text("done");
      } else if (!canWrite || !memoryDir) {
        text("ok"); // side requests (titles etc.)
      } else {
        const input = JSON.stringify({
          file_path: path.join(memoryDir, "probe.md"),
          content: "---\nname: probe\n---\ncodeword: TURTLE\n",
        });
        events.push(
          ["content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${requests}`, name: "Write", input: {} } }],
          ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: input } }],
          ["content_block_stop", { index: 0 }],
          ["message_delta", { delta: { stop_reason: "tool_use" }, usage }],
        );
      }
      events.push(["message_stop", {}]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        results,
        memoryDirs,
        requests: () => requests,
        close: () => server.close(),
      });
    }),
  );
}

const binary = platformBinary();

describe.skipIf(!binary)("agent memory writes through the real binary (#955)", () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  let tmp: string;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    stub = await startStub();
  });
  afterAll(() => stub.close());

  beforeEach(async () => {
    tmp = await makeTmpDir("paddock-memwrite-");
    stub.results.length = 0;
    stub.memoryDirs.length = 0;
    // The SDK runtime spreads process.env into the binary's environment. Point
    // it at the stub and strip anything that could reach a real account.
    for (const k of Object.keys(process.env)) {
      if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$)/.test(k)) delete process.env[k];
    }
    Object.assign(process.env, {
      HOME: path.join(tmp, "home"),
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_API_KEY: "sk-dummy-not-a-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
    });
    await fs.mkdir(path.join(tmp, "home"), { recursive: true });
  });
  afterEach(async () => {
    // Restore in place: reassigning `process.env` swaps the special env object
    // for a plain one, which leaks into every later file in this worker.
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    await rmTmpDir(tmp);
  });

  /** Lay a project out the way paddock does, run one turn, report the write. */
  async function runTurn(transcripts: TranscriptsMode, withFix: boolean) {
    const claudeHome = path.join(tmp, "claude-home");
    const userHome = path.join(tmp, "home", ".claude");
    const projectDir = path.join(tmp, "proj");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(userHome, { recursive: true });
    await ensureProjectChats(projectDir, projectDir, { path: claudeHome, transcripts, userHome });

    const cfg = { nativeSystemPrompt: true, browserMcp: false, dataDir: tmp } as unknown as PaddockConfig;
    const project = {
      slug: "mem",
      name: "mem",
      dir: projectDir,
      workingDir: projectDir,
      model: "claude-haiku-4-5",
    } as unknown as Project;
    const autoMemoryDir = withFix ? await resolveAutoMemoryDir(claudeHome, projectDir, userHome) : undefined;
    const agent = {
      // What herdctl merges in from the fleet `defaults` paddock writes at boot.
      allowed_tools: [...FLEET_ALLOWED_TOOLS],
      denied_tools: [...DENIED_TOOLS],
      ...buildAgentConfig(cfg, project, undefined, EMPTY_MCP_SOURCES, EMPTY_HOST_PLUGINS, undefined, autoMemoryDir),
    };

    const runtime = new SDKRuntime({ claudeHomePath: claudeHome });
    for await (const _ of runtime.execute({
      prompt: "remember the codeword",
      agent: { ...agent, configPath: path.join(tmp, "agent.yaml") } as never,
    })) {
      // drain
    }
    expect(stub.requests()).toBeGreaterThan(0); // the stub, and nothing else, answered
    expect(stub.results).toHaveLength(1);
    return { result: stub.results[0], autoMemoryDir };
  }

  it.each(["own", "host"] as const)(
    "lands under transcripts: %s, at the symlink-free path",
    async (transcripts) => {
      const { result, autoMemoryDir } = await runTurn(transcripts, true);
      expect(result.isError, result.text).toBe(false);
      expect(await fs.readFile(path.join(autoMemoryDir!, "probe.md"), "utf8")).toContain("TURTLE");
    },
    60_000,
  );

  // The control: without the setting the same turn is denied. If this ever
  // passes, the harness changed and the fix may no longer be needed.
  it("is denied under host without autoMemoryDirectory — the #955 bug", async () => {
    const { result } = await runTurn("host", false);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/sensitive file[\s\S]*resolves through a symlink/);
  }, 60_000);

  // The fix must change only how the memory dir is SPELLED, never which one it
  // is — so ask the binary. With no symlink anywhere in this Claude home, the dir
  // Claude Code names in its own system prompt must equal paddock's, for every
  // layout paddock hands it: a notes-repo subdirectory (a notebook project), a
  // linked worktree, a symlinked cwd into a repo, and a cwd outside git.
  it("names the same memory dir Claude Code picks on its own, layout by layout", async () => {
    const { execFileSync } = await import("node:child_process");
    const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "ignore" });
    const repo = path.join(tmp, "notes");
    await fs.mkdir(path.join(repo, "nb"), { recursive: true });
    git(repo, "init", "-q");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
    git(repo, "worktree", "add", "-q", path.join(tmp, "wt"));
    await fs.symlink(path.join(repo, "nb"), path.join(tmp, "nb-link"));
    await fs.mkdir(path.join(tmp, "plain"));
    const claudeHome = path.join(tmp, "plain-home");
    await fs.mkdir(claudeHome);

    for (const cwd of [path.join(repo, "nb"), path.join(tmp, "wt"), path.join(tmp, "nb-link"), path.join(tmp, "plain")]) {
      stub.memoryDirs.length = 0;
      const runtime = new SDKRuntime({ claudeHomePath: claudeHome });
      for await (const _ of runtime.execute({
        prompt: "hi",
        agent: { name: "k", configPath: path.join(tmp, "a.yaml"), working_directory: cwd, model: "claude-haiku-4-5" } as never,
      })) {
        // drain
      }
      expect(stub.memoryDirs.length, cwd).toBeGreaterThan(0);
      const theirs = stub.memoryDirs[0].replace(/\/$/, "");
      expect(await resolveAutoMemoryDir(claudeHome, cwd), cwd).toBe(theirs);
    }
  }, 120_000);
});
