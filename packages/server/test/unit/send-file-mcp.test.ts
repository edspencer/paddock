/**
 * The Paddock send_file MCP tool (issue #112). Exercises the injected-server
 * definition's handler contract directly: inline/virtual files, real-file reads
 * with a working-directory sandbox, kind/language inference, and the error
 * paths. The herdctl HTTP bridge that fronts this handler at runtime is core's
 * own (already tested upstream); here we prove the Paddock-side behavior.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import symlinkSync from "node:fs";
import {
  sendFileServerDef,
  SEND_FILE_SERVER_KEY,
  SEND_FILE_TOOL_NAME,
  type SentFile,
} from "../../src/send-file-mcp.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/** Invoke the single tool of a def built around a capturing onFile sink. */
async function callTool(
  args: Record<string, unknown>,
  workingDirectory?: string,
): Promise<{ emitted: SentFile[]; result: Awaited<ReturnType<typeof invoke>> }> {
  const emitted: SentFile[] = [];
  const def = sendFileServerDef({ workingDirectory, onFile: (f) => emitted.push(f) });
  const result = await invoke(def, args);
  return { emitted, result };
}

function invoke(
  def: ReturnType<typeof sendFileServerDef>,
  args: Record<string, unknown>,
) {
  return def.tools[0].handler(args);
}

describe("send_file MCP tool", () => {
  it("names the server + tool as mcp__paddock__send_file", () => {
    expect(SEND_FILE_SERVER_KEY).toBe("paddock");
    expect(SEND_FILE_TOOL_NAME).toBe("mcp__paddock__send_file");
    const def = sendFileServerDef({ onFile: () => undefined });
    expect(def.name).toBe("paddock");
    expect(def.tools[0].name).toBe("send_file");
  });

  it("emits an inline markdown file inferred from the .md extension", async () => {
    const { emitted, result } = await callTool({
      content: "# Hi\n\nHello **world**",
      filename: "notes.md",
      message: "here you go",
    });
    expect(result.isError).toBeFalsy();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      filename: "notes.md",
      kind: "markdown",
      content: "# Hi\n\nHello **world**",
      message: "here you go",
    });
  });

  it("infers the code kind + language from a source extension", async () => {
    const { emitted } = await callTool({
      content: "export const x = 1;\n",
      filename: "example.ts",
    });
    expect(emitted[0]).toMatchObject({ kind: "code", language: "typescript" });
  });

  it("infers mermaid from a .mmd file", async () => {
    const { emitted } = await callTool({
      content: "graph TD; A-->B;",
      filename: "flow.mmd",
    });
    expect(emitted[0].kind).toBe("mermaid");
  });

  it("honors an explicit kind override", async () => {
    const { emitted } = await callTool({
      content: "graph TD; A-->B;",
      filename: "diagram.txt",
      kind: "mermaid",
    });
    expect(emitted[0].kind).toBe("mermaid");
  });

  it("rejects a call with neither content nor file_path", async () => {
    const { emitted, result } = await callTool({ filename: "x.md" });
    expect(result.isError).toBe(true);
    expect(emitted).toHaveLength(0);
  });

  it("rejects inline content declared as an image", async () => {
    const { result } = await callTool({
      content: "not really an image",
      filename: "x.png",
    });
    expect(result.isError).toBe(true);
  });

  describe("real files", () => {
    let dir: string;
    beforeAll(async () => {
      dir = await makeTmpDir("paddock-sendfile-");
      await fs.writeFile(path.join(dir, "real.md"), "# Real\n\nfrom disk", "utf8");
    });
    afterAll(async () => {
      await rmTmpDir(dir);
    });

    it("reads a real file relative to the working directory", async () => {
      const { emitted, result } = await callTool({ file_path: "real.md" }, dir);
      expect(result.isError).toBeFalsy();
      expect(emitted[0]).toMatchObject({
        filename: "real.md",
        kind: "markdown",
        content: "# Real\n\nfrom disk",
      });
    });

    it("returns a not-found error for a missing file", async () => {
      const { result } = await callTool({ file_path: "nope.md" }, dir);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });

    it("refuses a path that escapes the working directory", async () => {
      const outside = await makeTmpDir("paddock-outside-");
      await fs.writeFile(path.join(outside, "secret.md"), "secret", "utf8");
      // A symlink inside the working dir pointing outside must not bypass the guard.
      symlinkSync.symlinkSync(path.join(outside, "secret.md"), path.join(dir, "link.md"));
      const { result } = await callTool({ file_path: "link.md" }, dir);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("escapes");
      await rmTmpDir(outside);
    });

    it("errors when a real file_path is given but no working directory", async () => {
      const { result } = await callTool({ file_path: "real.md" });
      expect(result.isError).toBe(true);
    });
  });
});
