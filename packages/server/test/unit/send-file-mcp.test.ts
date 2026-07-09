/**
 * The Paddock send_file MCP tool (issue #112). The tool returns a JSON envelope
 * as its result `output` — that's the single representation the web renders from
 * (live + on reload), so these tests assert the envelope shape for inline and
 * real-file sends, kind/language inference, and the error/sandbox paths. The
 * herdctl HTTP bridge that fronts the handler at runtime is core's own.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { symlinkSync } from "node:fs";
import {
  sendFileServerDef,
  SEND_FILE_SERVER_KEY,
  SEND_FILE_TOOL_NAME,
  type SentFileEnvelope,
} from "../../src/send-file-mcp.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function callTool(
  args: Record<string, unknown>,
  workingDirectory?: string,
): Promise<{ result: Result; envelope: SentFileEnvelope | null }> {
  const def = sendFileServerDef({ workingDirectory });
  const result = (await def.tools[0].handler(args)) as Result;
  let envelope: SentFileEnvelope | null = null;
  if (!result.isError) {
    try {
      envelope = JSON.parse(result.content[0].text) as SentFileEnvelope;
    } catch {
      envelope = null;
    }
  }
  return { result, envelope };
}

describe("send_file MCP tool", () => {
  it("names the server + tool as mcp__paddock__send_file", () => {
    expect(SEND_FILE_SERVER_KEY).toBe("paddock");
    expect(SEND_FILE_TOOL_NAME).toBe("mcp__paddock__send_file");
    const def = sendFileServerDef({});
    expect(def.name).toBe("paddock");
    expect(def.tools[0].name).toBe("send_file");
  });

  it("returns an inline markdown envelope inferred from the .md extension", async () => {
    const { result, envelope } = await callTool({
      content: "# Hi\n\nHello **world**",
      filename: "notes.md",
      message: "here you go",
    });
    expect(result.isError).toBeFalsy();
    expect(envelope).toMatchObject({
      paddockSendFile: 1,
      filename: "notes.md",
      kind: "markdown",
      source: "inline",
      content: "# Hi\n\nHello **world**",
      message: "here you go",
    });
    // Inline never carries a path.
    expect(envelope?.path).toBeUndefined();
  });

  it("infers the code kind + language from a source extension", async () => {
    const { envelope } = await callTool({
      content: "export const x = 1;\n",
      filename: "example.ts",
    });
    expect(envelope).toMatchObject({ kind: "code", language: "typescript", source: "inline" });
  });

  it("infers mermaid from a .mmd file", async () => {
    const { envelope } = await callTool({ content: "graph TD; A-->B;", filename: "flow.mmd" });
    expect(envelope?.kind).toBe("mermaid");
  });

  it("honors an explicit kind override", async () => {
    const { envelope } = await callTool({
      content: "graph TD; A-->B;",
      filename: "diagram.txt",
      kind: "mermaid",
    });
    expect(envelope?.kind).toBe("mermaid");
  });

  it("rejects a call with neither content nor file_path", async () => {
    const { result } = await callTool({ filename: "x.md" });
    expect(result.isError).toBe(true);
  });

  it("rejects inline content declared as an image", async () => {
    const { result } = await callTool({ content: "not really an image", filename: "x.png" });
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

    it("records only the PATH for a real file (never the bytes)", async () => {
      const { result, envelope } = await callTool({ file_path: "real.md" }, dir);
      expect(result.isError).toBeFalsy();
      expect(envelope).toMatchObject({
        paddockSendFile: 1,
        filename: "real.md",
        kind: "markdown",
        source: "file",
        path: "real.md",
      });
      // Crucially: the transcript-bound envelope must NOT inline the file bytes.
      expect(envelope?.content).toBeUndefined();
    });

    it("returns a not-found error for a missing file", async () => {
      const { result } = await callTool({ file_path: "nope.md" }, dir);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });

    it("refuses a path that escapes the working directory (via symlink)", async () => {
      const outside = await makeTmpDir("paddock-outside-");
      await fs.writeFile(path.join(outside, "secret.md"), "secret", "utf8");
      symlinkSync(path.join(outside, "secret.md"), path.join(dir, "link.md"));
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
