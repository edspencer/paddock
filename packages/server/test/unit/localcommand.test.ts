import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { projectChatsDir } from "../../src/transcripts.js";
import { enrichWithLocalCommands } from "../../src/localcommand.js";
import type { EnrichedMessage } from "../../src/subagents.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Local-command output recovery (issue #158): `/context` / `/usage` render their
 * output into a `type:"system"` / `local_command` transcript entry that
 * @herdctl/core's parser drops (it keeps only user/assistant entries). This pass
 * recovers it and re-injects it as a `role:"user"` `<local-command-stdout>` message
 * right after the `<command-name>` echo it belongs to, so the web renders it.
 */
describe("enrichWithLocalCommands (issue #158)", () => {
  let projectDir: string;
  beforeEach(async () => {
    projectDir = await makeTmpDir("paddock-localcommand-");
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

  /** A parsed EnrichedMessage as parseSessionMessages would yield it. */
  const userMsg = (content: string, uuid?: string): EnrichedMessage => ({
    role: "user",
    content,
    timestamp: "2026-07-20T00:00:00Z",
    ...(uuid ? { uuid } : {}),
  });

  it("recovers a /context local_command entry and injects it after its echo", async () => {
    await writeMain("s1", [
      {
        type: "user",
        message: { role: "user", content: "<command-name>/context</command-name>" },
        uuid: "echo-1",
      },
      {
        type: "system",
        subtype: "local_command",
        parentUuid: "echo-1",
        uuid: "out-1",
        timestamp: "2026-07-20T00:00:01Z",
        content: "<local-command-stdout>## Context Usage\n\n**Tokens:** 21.3k / 200k</local-command-stdout>",
      },
    ]);
    // What core's parser yields: the echo survived, the system entry was dropped.
    const parsed: EnrichedMessage[] = [userMsg("<command-name>/context</command-name>", "echo-1")];

    const out = await enrichWithLocalCommands(projectDir, "s1", parsed);
    expect(out).toHaveLength(2);
    expect(out[0].uuid).toBe("echo-1"); // echo stays first
    // The recovered stdout is injected right after, as a user message the web
    // renderer detects (`localCommandStdout`) and shows as a labeled output block.
    expect(out[1].role).toBe("user");
    expect(out[1].uuid).toBe("out-1");
    expect(out[1].content).toContain("<local-command-stdout>");
    expect(out[1].content).toContain("## Context Usage");
    expect(out[1].timestamp).toBe("2026-07-20T00:00:01Z");
  });

  it("passes a transcript with no local commands through untouched", async () => {
    await writeMain("s2", [
      { type: "user", message: { role: "user", content: "hello" }, uuid: "u1" },
    ]);
    const parsed: EnrichedMessage[] = [userMsg("hello", "u1")];
    const out = await enrichWithLocalCommands(projectDir, "s2", parsed);
    expect(out).toBe(parsed); // early no-op returns the same array
  });

  it("drops a recovered entry whose anchor echo isn't in the parsed messages", async () => {
    await writeMain("s3", [
      {
        type: "system",
        subtype: "local_command",
        parentUuid: "missing-echo",
        uuid: "out-3",
        content: "<local-command-stdout>orphaned</local-command-stdout>",
      },
    ]);
    // The echo was trimmed (e.g. by a message limit) — nothing to anchor to.
    const parsed: EnrichedMessage[] = [userMsg("something else", "u9")];
    const out = await enrichWithLocalCommands(projectDir, "s3", parsed);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("something else");
  });

  it("ignores a local_command entry with no stdout wrapper", async () => {
    await writeMain("s4", [
      {
        type: "system",
        subtype: "local_command",
        parentUuid: "echo-4",
        content: "some other system content",
      },
    ]);
    const parsed: EnrichedMessage[] = [userMsg("<command-name>/foo</command-name>", "echo-4")];
    const out = await enrichWithLocalCommands(projectDir, "s4", parsed);
    expect(out).toHaveLength(1);
  });

  it("does NOT inject an empty-output block (would render as a raw-XML bubble — Warren #358)", async () => {
    // A display-only command that produced nothing: an EMPTY stdout block. Injecting
    // it would fall through the web detectors to the raw-XML user-bubble fallback,
    // reintroducing the exact bug #158 fixes — so it must be dropped at recovery.
    await writeMain("s5", [
      {
        type: "system",
        subtype: "local_command",
        parentUuid: "echo-5",
        uuid: "out-5",
        content: "<local-command-stdout></local-command-stdout>",
      },
      {
        type: "system",
        subtype: "local_command",
        parentUuid: "echo-5",
        uuid: "out-5b",
        content: "<local-command-stdout>   \n  </local-command-stdout>",
      },
    ]);
    const parsed: EnrichedMessage[] = [userMsg("<command-name>/foo</command-name>", "echo-5")];
    const out = await enrichWithLocalCommands(projectDir, "s5", parsed);
    expect(out).toHaveLength(1); // nothing injected; only the echo remains
  });
});
