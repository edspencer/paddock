import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "@herdctl/core";
import { projectChatsDir } from "../../src/transcripts.js";
import {
  readTaskToolUses,
  listSubagents,
  readSubagentMessages,
  enrichWithSubagents,
} from "../../src/subagents.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("subagents (issue #37)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTmpDir("paddock-subagents-");
  });
  afterEach(async () => {
    await rmTmpDir(projectDir);
  });

  async function writeMain(sessionId: string, lines: unknown[]): Promise<void> {
    const dir = projectChatsDir(projectDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${sessionId}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );
  }

  async function writeSubagent(
    sessionId: string,
    hex: string,
    meta: Record<string, unknown>,
    lines: unknown[],
  ): Promise<void> {
    const dir = path.join(projectChatsDir(projectDir), sessionId, "subagents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `agent-${hex}.meta.json`), JSON.stringify(meta), "utf8");
    await fs.writeFile(
      path.join(dir, `agent-${hex}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );
  }

  /** An assistant line carrying a Task/Agent tool_use block. */
  const toolUse = (name: string, id: string, input: Record<string, unknown>) => ({
    type: "assistant",
    message: { id: `msg-${id}`, content: [{ type: "tool_use", name, id, input }] },
  });
  /** A user line carrying the paired tool_result. */
  const toolResult = (id: string, text: string) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  });

  describe("readTaskToolUses", () => {
    it("recovers Agent AND Task tool_uses with their input, in order", async () => {
      await writeMain("s1", [
        toolUse("Agent", "toolu_A", {
          subagent_type: "Explore",
          description: "map features",
          prompt: "go explore",
        }),
        toolResult("toolu_A", "done A"),
        toolUse("Task", "toolu_B", { subagent_type: "general-purpose", description: "fix bug" }),
        toolResult("toolu_B", "done B"),
      ]);
      const uses = await readTaskToolUses(projectDir, "s1");
      expect(uses.map((u) => u.toolUseId)).toEqual(["toolu_A", "toolu_B"]);
      expect(uses[0]).toMatchObject({
        subagentType: "Explore",
        description: "map features",
        prompt: "go explore",
      });
      expect(uses[1]).toMatchObject({ subagentType: "general-purpose", description: "fix bug" });
    });

    it("omits an unpaired (in-flight) tool_use so the join stays aligned", async () => {
      await writeMain("s2", [
        toolUse("Agent", "toolu_A", { description: "first" }),
        toolResult("toolu_A", "done"),
        toolUse("Agent", "toolu_B", { description: "still running" }), // no result yet
      ]);
      const uses = await readTaskToolUses(projectDir, "s2");
      expect(uses.map((u) => u.toolUseId)).toEqual(["toolu_A"]);
    });

    it("ignores non-subagent tools and returns [] for a bad session id", async () => {
      await writeMain("s3", [
        toolUse("Bash", "toolu_X", { command: "ls" }),
        toolResult("toolu_X", "files"),
      ]);
      expect(await readTaskToolUses(projectDir, "s3")).toEqual([]);
      expect(await readTaskToolUses(projectDir, "../escape")).toEqual([]);
    });
  });

  describe("listSubagents", () => {
    it("keys meta sidecars by toolUseId and resolves the sibling transcript path", async () => {
      await writeSubagent(
        "s4",
        "abc123",
        { agentType: "Explore", description: "map", toolUseId: "toolu_A", spawnDepth: 1 },
        [{ type: "user", message: { content: "hi" } }],
      );
      const map = await listSubagents(projectDir, "s4");
      const meta = map.get("toolu_A");
      expect(meta).toBeDefined();
      expect(meta).toMatchObject({ agentType: "Explore", description: "map", spawnDepth: 1 });
      expect(meta!.transcriptPath.endsWith("agent-abc123.jsonl")).toBe(true);
    });

    it("returns an empty map when there are no sub-agents", async () => {
      expect((await listSubagents(projectDir, "none")).size).toBe(0);
    });
  });

  describe("readSubagentMessages", () => {
    it("parses the sub-agent's own transcript via core's parser", async () => {
      await writeSubagent(
        "s5",
        "deadbeef",
        { agentType: "Explore", description: "map", toolUseId: "toolu_A" },
        [
          { type: "user", message: { content: "explore the code", role: "user" }, uuid: "u1" },
          {
            type: "assistant",
            message: { id: "m1", role: "assistant", content: [{ type: "text", text: "found it" }] },
            uuid: "a1",
          },
        ],
      );
      const messages = await readSubagentMessages(projectDir, "s5", "toolu_A");
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some((m) => m.content.includes("found it"))).toBe(true);
    });

    it("enriches a sub-agent's OWN nested Task blocks for recursive expansion", async () => {
      // Parent sub-agent (toolu_A) whose transcript itself launches a child
      // sub-agent (toolu_child). Both sidecars are flat in the same session dir.
      await writeSubagent(
        "s7",
        "parent",
        { agentType: "general", description: "parent", toolUseId: "toolu_A" },
        [
          {
            type: "assistant",
            message: {
              id: "m1",
              content: [{ type: "tool_use", name: "Agent", id: "toolu_child", input: { subagent_type: "Explore", description: "dig deeper" } }],
            },
          },
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_child", content: "child done" }] } },
        ],
      );
      await writeSubagent(
        "s7",
        "child",
        { agentType: "Explore", description: "dig deeper", toolUseId: "toolu_child", spawnDepth: 2 },
        [{ type: "user", message: { content: "hi" } }],
      );

      const msgs = await readSubagentMessages(projectDir, "s7", "toolu_A");
      const nested = msgs.find((m) => m.toolCall?.toolName === "Agent");
      expect(nested?.toolCall).toMatchObject({
        toolUseId: "toolu_child",
        subagentType: "Explore",
        hasSubagent: true, // the child sidecar exists → the UI can expand again
      });
    });

    it("returns [] for an unknown toolUseId or bad ids", async () => {
      expect(await readSubagentMessages(projectDir, "s5", "toolu_missing")).toEqual([]);
      expect(await readSubagentMessages(projectDir, "s5", "../escape")).toEqual([]);
      expect(await readSubagentMessages(projectDir, "../escape", "toolu_A")).toEqual([]);
    });
  });

  describe("enrichWithSubagents", () => {
    const toolMsg = (toolName: string, output: string): ChatMessage => ({
      role: "tool",
      content: output,
      timestamp: "2026-01-01T00:00:00Z",
      toolCall: { toolName, inputSummary: undefined, output, isError: false },
    });

    it("attaches recovered fields to Agent blocks by order and flags hasSubagent", async () => {
      await writeMain("s6", [
        toolUse("Agent", "toolu_A", { subagent_type: "Explore", description: "map features" }),
        toolResult("toolu_A", "done A"),
        toolUse("Agent", "toolu_B", { subagent_type: "general", description: "no sidecar" }),
        toolResult("toolu_B", "done B"),
      ]);
      // Only toolu_A has a sub-agent transcript on disk.
      await writeSubagent(
        "s6",
        "aaa",
        { agentType: "Explore", description: "map features", toolUseId: "toolu_A" },
        [{ type: "user", message: { content: "hi" } }],
      );

      const messages: ChatMessage[] = [
        { role: "user", content: "please", timestamp: "t", toolCall: undefined },
        toolMsg("Agent", "done A"),
        toolMsg("Bash", "irrelevant"),
        toolMsg("Agent", "done B"),
      ];
      const enriched = await enrichWithSubagents(projectDir, "s6", messages);

      const agentCalls = enriched.filter((m) => m.toolCall?.toolName === "Agent");
      expect(agentCalls[0].toolCall).toMatchObject({
        toolUseId: "toolu_A",
        subagentType: "Explore",
        description: "map features",
        hasSubagent: true,
      });
      expect(agentCalls[1].toolCall).toMatchObject({
        toolUseId: "toolu_B",
        subagentType: "general",
        hasSubagent: false,
      });
      // Non-Agent tool call is untouched.
      expect(enriched[2].toolCall).not.toHaveProperty("toolUseId");
    });

    it("reports the sub-agent's RUN time (first→last transcript timestamp), not the launch", async () => {
      await writeMain("s8", [
        toolUse("Agent", "toolu_A", { subagent_type: "Explore", description: "runs a while" }),
        toolResult("toolu_A", "done A"),
      ]);
      await writeSubagent(
        "s8",
        "aaa",
        { agentType: "Explore", description: "runs a while", toolUseId: "toolu_A" },
        [
          { type: "user", message: { content: "go" }, timestamp: "2026-01-01T00:00:00.000Z" },
          {
            type: "assistant",
            message: { id: "m1", content: [{ type: "text", text: "done" }] },
            timestamp: "2026-01-01T00:00:12.500Z",
          },
        ],
      );
      const enriched = await enrichWithSubagents(projectDir, "s8", [toolMsg("Agent", "done A")]);
      expect(enriched[0].toolCall?.subagentDurationMs).toBe(12_500);
    });

    it("passes messages through unchanged when there are no Agent tool calls", async () => {
      const messages: ChatMessage[] = [toolMsg("Bash", "ls output")];
      const enriched = await enrichWithSubagents(projectDir, "nope", messages);
      expect(enriched).toBe(messages); // same reference — cheap early return
    });
  });
});
