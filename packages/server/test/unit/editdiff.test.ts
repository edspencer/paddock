import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { projectChatsDir } from "../../src/transcripts.js";
import { enrichWithEdits } from "../../src/editdiff.js";
import type { EnrichedMessage } from "../../src/subagents.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("editdiff (issue #232)", () => {
  let projectDir: string;
  beforeEach(async () => {
    projectDir = await makeTmpDir("paddock-editdiff-");
  });
  afterEach(async () => {
    await rmTmpDir(projectDir);
  });

  /** Write a raw transcript whose lines carry the edit tool_use inputs. */
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
  const toolResult = (id: string) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  });

  /** A parsed EnrichedMessage tool message (what parseSessionMessages would yield). */
  const toolMsg = (toolName: string): EnrichedMessage => ({
    role: "tool",
    content: "",
    timestamp: "2026-07-16T00:00:00Z",
    toolCall: { toolName, output: "updated", isError: false },
  });

  it("attaches an Edit diff (context + del + add) with accurate stats", async () => {
    await writeMain("s1", [
      toolUse("Edit", "tu_1", {
        file_path: "/x/a.ts",
        old_string: "import a\nconst x = 1\nexport x",
        new_string: "import a\nconst x = 2\nconst y = 3\nexport x",
      }),
      toolResult("tu_1"),
    ]);
    const out = await enrichWithEdits(projectDir, "s1", [toolMsg("Edit")]);
    const d = out[0].toolCall!.editDiff!;
    expect(d.kind).toBe("edit");
    expect(d.filePath).toBe("/x/a.ts");
    expect(d.additions).toBe(2); // "const x = 2" + "const y = 3"
    expect(d.deletions).toBe(1); // "const x = 1"
    expect(d.hunks).toHaveLength(1);
    const kinds = d.hunks[0].lines.map((l) => l.t + l.text);
    expect(kinds).toEqual([
      " import a",
      "-const x = 1",
      "+const x = 2",
      "+const y = 3",
      " export x",
    ]);
  });

  it("attaches one hunk per MultiEdit sub-edit", async () => {
    await writeMain("s1", [
      toolUse("MultiEdit", "tu_1", {
        file_path: "/x/b.ts",
        edits: [
          { old_string: "foo", new_string: "bar" },
          { old_string: "a\nb", new_string: "a\nc" },
        ],
      }),
      toolResult("tu_1"),
    ]);
    const out = await enrichWithEdits(projectDir, "s1", [toolMsg("MultiEdit")]);
    const d = out[0].toolCall!.editDiff!;
    expect(d.kind).toBe("multiedit");
    expect(d.hunks).toHaveLength(2);
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(2);
  });

  it("renders a Write as all-additions", async () => {
    await writeMain("s1", [
      toolUse("Write", "tu_1", { file_path: "/x/c.md", content: "line 1\nline 2\nline 3" }),
      toolResult("tu_1"),
    ]);
    const out = await enrichWithEdits(projectDir, "s1", [toolMsg("Write")]);
    const d = out[0].toolCall!.editDiff!;
    expect(d.kind).toBe("write");
    expect(d.additions).toBe(3);
    expect(d.deletions).toBe(0);
    expect(d.hunks[0].lines.every((l) => l.t === "+")).toBe(true);
  });

  it("joins positionally across interleaved non-edit tools", async () => {
    await writeMain("s1", [
      toolUse("Edit", "tu_1", { file_path: "/x/1", old_string: "a", new_string: "b" }),
      toolResult("tu_1"),
      toolUse("Edit", "tu_2", { file_path: "/x/2", old_string: "c", new_string: "d" }),
      toolResult("tu_2"),
    ]);
    // A Read sits between the two edits in the parsed message stream.
    const out = await enrichWithEdits(projectDir, "s1", [
      toolMsg("Edit"),
      toolMsg("Read"),
      toolMsg("Edit"),
    ]);
    expect(out[0].toolCall!.editDiff!.filePath).toBe("/x/1");
    expect(out[1].toolCall!.editDiff).toBeUndefined(); // the Read is untouched
    expect(out[2].toolCall!.editDiff!.filePath).toBe("/x/2");
  });

  it("skips an unpaired edit tool_use (no tool_result) and keeps alignment", async () => {
    await writeMain("s1", [
      // tu_1 launched but never got a result → herdctl emits no tool message for it,
      // so it must NOT consume a join slot.
      toolUse("Edit", "tu_1", { file_path: "/x/unpaired", old_string: "a", new_string: "b" }),
      toolUse("Edit", "tu_2", { file_path: "/x/paired", old_string: "c", new_string: "d" }),
      toolResult("tu_2"),
    ]);
    const out = await enrichWithEdits(projectDir, "s1", [toolMsg("Edit")]);
    expect(out[0].toolCall!.editDiff!.filePath).toBe("/x/paired");
  });

  it("handles an oversized edit without building a giant LCS matrix (naive fallback)", async () => {
    // 2000 x 2000 distinct lines → 4M cells, over MAX_LCS_CELLS → naive all-del/all-add.
    const oldStr = Array.from({ length: 2000 }, (_, i) => `old-${i}`).join("\n");
    const newStr = Array.from({ length: 2000 }, (_, i) => `new-${i}`).join("\n");
    await writeMain("s1", [
      toolUse("Edit", "tu_1", { file_path: "/x/huge.ts", old_string: oldStr, new_string: newStr }),
      toolResult("tu_1"),
    ]);
    const out = await enrichWithEdits(projectDir, "s1", [toolMsg("Edit")]);
    const d = out[0].toolCall!.editDiff!;
    // Stats stay exact (computed before the render cap); rendered lines are capped.
    expect(d.additions).toBe(2000);
    expect(d.deletions).toBe(2000);
    expect(d.truncated).toBe(true);
    expect(d.hunks[0].lines.length).toBeLessThanOrEqual(400);
    // Naive fallback emits deletions first.
    expect(d.hunks[0].lines[0].t).toBe("-");
  });

  it("passes an edit-free transcript through unchanged (early return identity)", async () => {
    const msgs = [toolMsg("Read"), toolMsg("Grep")];
    const out = await enrichWithEdits(projectDir, "s1", msgs);
    expect(out).toBe(msgs);
  });
});
