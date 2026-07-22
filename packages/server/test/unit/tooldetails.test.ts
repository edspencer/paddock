import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { projectChatsDir } from "../../src/transcripts.js";
import { attachToolDetails, enrichWithToolDetails } from "../../src/tooldetails.js";
import type { EnrichedMessage } from "../../src/subagents.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("tooldetails (issue #237)", () => {
  let projectDir: string;
  beforeEach(async () => {
    projectDir = await makeTmpDir("paddock-tooldetails-");
  });
  afterEach(async () => {
    await rmTmpDir(projectDir);
  });

  /** Write a raw transcript whose lines carry tool_use inputs + toolUseResult sidecars. */
  async function writeMain(sessionId: string, lines: unknown[]): Promise<void> {
    const dir = projectChatsDir(projectDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${sessionId}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );
  }
  const toolUse = (name: string, id: string, input: Record<string, unknown>) => ({
    type: "assistant",
    message: { id: `msg-${id}`, content: [{ type: "tool_use", name, id, input }] },
  });
  /** A tool_result line, with the top-level `toolUseResult` sidecar Claude Code writes. */
  const toolResult = (id: string, toolUseResult?: unknown) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    ...(toolUseResult !== undefined ? { toolUseResult } : {}),
  });

  /** A parsed EnrichedMessage tool message (what parseSessionMessages would yield). */
  const toolMsg = (toolName: string): EnrichedMessage => ({
    role: "tool",
    content: "",
    timestamp: "2026-07-16T00:00:00Z",
    toolCall: { toolName, output: "out", isError: false },
  });

  it("attaches an Edit diff from structuredPatch with real line numbers", async () => {
    await writeMain("s1", [
      toolUse("Edit", "tu_1", { file_path: "/x/a.ts" }),
      toolResult("tu_1", {
        filePath: "/x/a.ts",
        userModified: false,
        structuredPatch: [
          {
            oldStart: 26,
            oldLines: 2,
            newStart: 26,
            newLines: 3,
            lines: [" import a", "-const x = 1", "+const x = 2", "+const y = 3"],
          },
        ],
      }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Edit")]);
    const d = out[0].toolCall!.editDiff!;
    expect(d.kind).toBe("edit");
    expect(d.filePath).toBe("/x/a.ts");
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(1);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({ oldStart: 26, oldLines: 2, newStart: 26, newLines: 3 });
    // Context carries both line numbers; a deletion only old, an addition only new.
    expect(d.hunks[0].lines).toEqual([
      { t: " ", text: "import a", oldLine: 26, newLine: 26 },
      { t: "-", text: "const x = 1", oldLine: 27 },
      { t: "+", text: "const x = 2", newLine: 27 },
      { t: "+", text: "const y = 3", newLine: 28 },
    ]);
  });

  it("carries userModified and multiple hunks", async () => {
    await writeMain("s1", [
      toolUse("Edit", "tu_1", { file_path: "/x/b.ts" }),
      toolResult("tu_1", {
        userModified: true,
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
          { oldStart: 9, oldLines: 1, newStart: 9, newLines: 1, lines: ["-c", "+d"] },
        ],
      }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Edit")]);
    const d = out[0].toolCall!.editDiff!;
    expect(d.userModified).toBe(true);
    expect(d.hunks).toHaveLength(2);
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(2);
  });

  it("renders a Write structuredPatch as additions", async () => {
    await writeMain("s1", [
      toolUse("Write", "tu_1", { file_path: "/x/c.md" }),
      toolResult("tu_1", {
        structuredPatch: [
          { oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ["+line 1", "+line 2"] },
        ],
      }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Write")]);
    const d = out[0].toolCall!.editDiff!;
    expect(d.kind).toBe("write");
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(0);
    expect(d.hunks[0].lines.every((l) => l.t === "+")).toBe(true);
  });

  it("caps a huge diff and flags it truncated (stats stay exact)", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `+line ${i}`);
    await writeMain("s1", [
      toolUse("Write", "tu_1", { file_path: "/x/huge.ts" }),
      toolResult("tu_1", {
        structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1000, lines }],
      }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Write")]);
    const d = out[0].toolCall!.editDiff!;
    expect(d.additions).toBe(1000); // exact
    expect(d.truncated).toBe(true);
    expect(d.hunks[0].lines.length).toBeLessThanOrEqual(400);
  });

  it("attaches Read line-range from the file sidecar", async () => {
    await writeMain("s1", [
      toolUse("Read", "tu_1", { file_path: "/a/b/foo.ts", offset: 33, limit: 8 }),
      toolResult("tu_1", {
        file: { filePath: "/a/b/foo.ts", content: "…", numLines: 8, startLine: 33, totalLines: 210 },
      }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Read")]);
    const r = out[0].toolCall!.readInfo!;
    expect(r.basename).toBe("foo.ts");
    expect(r.filePath).toBe("/a/b/foo.ts");
    expect(r.startLine).toBe(33);
    expect(r.numLines).toBe(8);
    expect(r.totalLines).toBe(210);
  });

  it("gives a Read a basename even without a toolUseResult sidecar", async () => {
    await writeMain("s1", [
      toolUse("Read", "tu_1", { file_path: "/very/long/path/to/thing.ts" }),
      toolResult("tu_1"),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Read")]);
    const r = out[0].toolCall!.readInfo!;
    expect(r.basename).toBe("thing.ts");
    expect(r.startLine).toBeUndefined();
  });

  it("flags an image Read inside the project dir with a servable relative path", async () => {
    const abs = path.join(projectDir, "docs", "diagram.png");
    await writeMain("s1", [
      toolUse("Read", "tu_1", { file_path: abs }),
      toolResult("tu_1", { type: "image", file: { filePath: abs } }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Read")]);
    const r = out[0].toolCall!.readInfo!;
    expect(r.isImage).toBe(true);
    expect(r.projectRelPath).toBe(path.join("docs", "diagram.png"));
  });

  it("flags an image Read outside the project dir WITHOUT a servable path", async () => {
    await writeMain("s1", [
      toolUse("Read", "tu_1", { file_path: "/etc/secret/photo.png" }),
      toolResult("tu_1", { type: "image", file: { filePath: "/etc/secret/photo.png" } }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Read")]);
    const r = out[0].toolCall!.readInfo!;
    expect(r.isImage).toBe(true);
    expect(r.projectRelPath).toBeUndefined();
  });

  it("does not flag a non-image Read as an image", async () => {
    const abs = path.join(projectDir, "src", "index.ts");
    await writeMain("s1", [
      toolUse("Read", "tu_1", { file_path: abs }),
      toolResult("tu_1", { file: { filePath: abs, numLines: 1, startLine: 1, totalLines: 1 } }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Read")]);
    const r = out[0].toolCall!.readInfo!;
    expect(r.isImage).toBeUndefined();
    expect(r.projectRelPath).toBeUndefined();
  });

  it("splits Bash stderr + surfaces interrupted / exit hint / git", async () => {
    await writeMain("s1", [
      toolUse("Bash", "tu_1", { command: "make" }),
      toolResult("tu_1", {
        stdout: "building…",
        stderr: "warning: x",
        interrupted: true,
        returnCodeInterpretation: "No matches found",
        gitOperation: { push: { branch: "feat/x" } },
      }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Bash")]);
    const b = out[0].toolCall!.bashDetails!;
    expect(b.stdout).toBe("building…");
    expect(b.stderr).toBe("warning: x");
    expect(b.interrupted).toBe(true);
    expect(b.returnCodeInterpretation).toBe("No matches found");
    expect(b.gitHint).toBe("push → feat/x");
  });

  it("leaves a clean Bash (no stderr / flags) generic", async () => {
    await writeMain("s1", [
      toolUse("Bash", "tu_1", { command: "ls" }),
      toolResult("tu_1", { stdout: "a\nb", stderr: "", interrupted: false }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Bash")]);
    expect(out[0].toolCall!.bashDetails).toBeUndefined();
  });

  it("counts Grep matches (files + content mode) and Glob matches", async () => {
    await writeMain("s1", [
      toolUse("Grep", "tu_1", { pattern: "foo" }),
      toolResult("tu_1", { mode: "files_with_matches", numFiles: 22, filenames: [] }),
      toolUse("Grep", "tu_2", { pattern: "bar" }),
      toolResult("tu_2", { mode: "content", numFiles: 0, numLines: 15, filenames: [] }),
      toolUse("Glob", "tu_3", { pattern: "**/*.ts" }),
      toolResult("tu_3", { numFiles: 7, totalMatches: 7, truncated: true, durationMs: 8 }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [
      toolMsg("Grep"),
      toolMsg("Grep"),
      toolMsg("Glob"),
    ]);
    expect(out[0].toolCall!.searchInfo).toMatchObject({ kind: "grep", numFiles: 22 });
    expect(out[1].toolCall!.searchInfo).toMatchObject({ kind: "grep", numLines: 15 });
    expect(out[2].toolCall!.searchInfo).toMatchObject({
      kind: "glob",
      totalMatches: 7,
      truncated: true,
    });
  });

  it("renders a TaskUpdate status transition", async () => {
    await writeMain("s1", [
      toolUse("TaskUpdate", "tu_1", { taskId: "2", status: "in_progress" }),
      toolResult("tu_1", {
        success: true,
        taskId: "2",
        updatedFields: ["status"],
        statusChange: { from: "pending", to: "in_progress" },
      }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("TaskUpdate")]);
    expect(out[0].toolCall!.taskUpdate).toEqual({
      taskId: "2",
      updatedFields: ["status"],
      from: "pending",
      to: "in_progress",
    });
  });

  it("renders a TaskCreate subject + description", async () => {
    await writeMain("s1", [
      toolUse("TaskCreate", "tu_1", { description: "Do the thing", activeForm: "Doing" }),
      toolResult("tu_1", { task: { id: "1", subject: "Expose Ollama to LAN" } }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("TaskCreate")]);
    expect(out[0].toolCall!.taskCreate).toEqual({
      taskId: "1",
      subject: "Expose Ollama to LAN",
      description: "Do the thing",
    });
  });

  it("joins positionally across interleaved non-detail tools", async () => {
    await writeMain("s1", [
      toolUse("Read", "tu_1", { file_path: "/x/1.ts" }),
      toolResult("tu_1", { file: { filePath: "/x/1.ts", numLines: 1, startLine: 1, totalLines: 1 } }),
      toolUse("Grep", "tu_2", { pattern: "z" }),
      toolResult("tu_2", { mode: "files_with_matches", numFiles: 3 }),
    ]);
    // A WebFetch (not a detail tool) sits between them — it must NOT consume a slot,
    // because it isn't in the recovered detail list either.
    const out = await attachToolDetails(projectDir, "s1", [
      toolMsg("Read"),
      toolMsg("WebFetch"),
      toolMsg("Grep"),
    ]);
    expect(out[0].toolCall!.readInfo!.basename).toBe("1.ts");
    expect(out[1].toolCall!.readInfo).toBeUndefined();
    expect(out[1].toolCall!.searchInfo).toBeUndefined();
    expect(out[2].toolCall!.searchInfo!.numFiles).toBe(3);
  });

  it("isolates a family when herdctl drops a paired tool from its parsed stream", async () => {
    // All three are paired in the raw transcript, but herdctl emits NO tool message
    // for the (interrupted, empty-output) Bash — so the parsed stream is Read, Grep.
    // A global positional join would misalign Grep onto Bash's slot; the per-name
    // bucketing keeps Grep correct.
    await writeMain("s1", [
      toolUse("Read", "tu_1", { file_path: "/x/a.ts" }),
      toolResult("tu_1", { file: { filePath: "/x/a.ts", numLines: 1, startLine: 1, totalLines: 1 } }),
      toolUse("Bash", "tu_2", { command: "grep zzz ." }),
      toolResult("tu_2", { stdout: "", stderr: "boom", interrupted: true }),
      toolUse("Grep", "tu_3", { pattern: "q" }),
      toolResult("tu_3", { mode: "files_with_matches", numFiles: 5 }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Read"), toolMsg("Grep")]);
    expect(out[0].toolCall!.readInfo!.basename).toBe("a.ts");
    expect(out[1].toolCall!.searchInfo!.numFiles).toBe(5);
  });

  it("skips an unpaired tool_use (no tool_result) and keeps alignment", async () => {
    await writeMain("s1", [
      toolUse("Read", "tu_1", { file_path: "/x/unpaired.ts" }),
      toolUse("Read", "tu_2", { file_path: "/x/paired.ts" }),
      toolResult("tu_2", { file: { filePath: "/x/paired.ts", numLines: 1, startLine: 1, totalLines: 1 } }),
    ]);
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Read")]);
    expect(out[0].toolCall!.readInfo!.basename).toBe("paired.ts");
  });

  it("skips an in-flight (pending) tool message in the stream so it doesn't steal the completed call's detail (herdctl#399)", async () => {
    // Core@5.24.0 now injects the unpaired in-flight tool_use into the parsed
    // stream as a `pending:true` message (previously herdctl dropped it). The
    // per-name positional join must skip it — else it consumes the completed
    // sibling's recovered detail and both render wrong.
    await writeMain("s1", [
      toolUse("Read", "tu_1", { file_path: "/x/paired.ts" }),
      toolResult("tu_1", { file: { filePath: "/x/paired.ts", numLines: 1, startLine: 1, totalLines: 1 } }),
      toolUse("Read", "tu_2", { file_path: "/x/running.ts" }), // in-flight, no result yet
    ]);
    const pendingRead: EnrichedMessage = {
      role: "tool",
      content: "",
      timestamp: "2026-07-16T00:00:00Z",
      toolCall: { toolName: "Read", output: "", isError: false, pending: true },
    };
    const out = await attachToolDetails(projectDir, "s1", [toolMsg("Read"), pendingRead]);
    // The completed Read keeps its own recovered range/basename.
    expect(out[0].toolCall!.readInfo!.basename).toBe("paired.ts");
    // The pending Read is left alone (no detail joined, flag preserved).
    expect(out[1].toolCall!.readInfo).toBeUndefined();
    expect(out[1].toolCall!.pending).toBe(true);
  });

  it("passes a detail-free transcript through unchanged (early return identity)", async () => {
    const msgs = [toolMsg("WebFetch"), toolMsg("WebSearch")];
    const out = await attachToolDetails(projectDir, "s1", msgs);
    expect(out).toBe(msgs);
  });

  it("enrichWithToolDetails orchestrates subagents + details + background", async () => {
    await writeMain("s2", [
      toolUse("Edit", "tu_1", { file_path: "/x/a.ts" }),
      toolResult("tu_1", {
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
      }),
    ]);
    const out = await enrichWithToolDetails(projectDir, "s2", [toolMsg("Edit")]);
    expect(out[0].toolCall!.editDiff!.additions).toBe(1);
  });
});
