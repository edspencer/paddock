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
import {
  sendFileServerDef,
  SEND_FILE_SERVER_KEY,
  SEND_FILE_TOOL_NAME,
  MAX_ATTACHMENT_BYTES,
  type SentFileEnvelope,
} from "../../src/send-file-mcp.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function callTool(
  args: Record<string, unknown>,
  workingDirectory?: string,
): Promise<{ result: Result; envelope: SentFileEnvelope | null; saved: Array<{ bytes: Buffer; name: string }> }> {
  const saved: Array<{ bytes: Buffer; name: string }> = [];
  const def = sendFileServerDef({
    workingDirectory,
    saveAttachment: async (bytes, name) => {
      saved.push({ bytes, name });
      return `11111111-2222-3333-4444-555555555555${name.slice(name.lastIndexOf("."))}`;
    },
  });
  const result = (await def.tools[0].handler(args)) as Result;
  let envelope: SentFileEnvelope | null = null;
  if (!result.isError) {
    try {
      envelope = JSON.parse(result.content[0].text) as SentFileEnvelope;
    } catch {
      envelope = null;
    }
  }
  return { result, envelope, saved };
}

describe("send_file MCP tool", () => {
  it("names the server + tool as mcp__paddock__send_file", () => {
    expect(SEND_FILE_SERVER_KEY).toBe("paddock");
    expect(SEND_FILE_TOOL_NAME).toBe("mcp__paddock__send_file");
    const def = sendFileServerDef({ saveAttachment: async () => "id" });
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

  it("rejects inline content inferred as a PDF from a .pdf filename", async () => {
    const { result } = await callTool({ content: "%PDF-1.4", filename: "report.pdf" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("PDF");
  });

  it("rejects inline content with an explicit kind:'pdf'", async () => {
    const { result } = await callTool({ content: "whatever", filename: "doc.txt", kind: "pdf" });
    expect(result.isError).toBe(true);
  });

  describe("real files", () => {
    let dir: string;
    beforeAll(async () => {
      dir = await makeTmpDir("paddock-sendfile-");
      await fs.writeFile(path.join(dir, "real.md"), "# Real\n\nfrom disk", "utf8");
      await fs.writeFile(path.join(dir, "doc.pdf"), Buffer.from("%PDF-1.4\n%%EOF"));
    });
    afterAll(async () => {
      await rmTmpDir(dir);
    });

    it("copies a real file's bytes to the store and returns an attachmentId", async () => {
      const { result, envelope, saved } = await callTool({ file_path: "real.md" }, dir);
      expect(result.isError).toBeFalsy();
      expect(envelope).toMatchObject({
        paddockSendFile: 1,
        filename: "real.md",
        kind: "markdown",
        source: "file",
      });
      expect(envelope?.attachmentId).toBeTruthy();
      // The envelope carries neither the bytes nor the on-disk path.
      expect(envelope?.content).toBeUndefined();
      // The bytes were copied to the store exactly once, at send time.
      expect(saved).toHaveLength(1);
      expect(saved[0].bytes.toString("utf8")).toBe("# Real\n\nfrom disk");
    });

    it("infers the pdf kind for a real .pdf file and stores its bytes", async () => {
      const { result, envelope, saved } = await callTool({ file_path: "doc.pdf" }, dir);
      expect(result.isError).toBeFalsy();
      expect(envelope).toMatchObject({ filename: "doc.pdf", kind: "pdf", source: "file" });
      expect(envelope?.attachmentId).toBeTruthy();
      expect(saved).toHaveLength(1);
      expect(saved[0].bytes.toString("utf8")).toContain("%PDF-1.4");
    });

    it("copies a file referenced by an absolute path OUTSIDE the working dir", async () => {
      const outside = await makeTmpDir("paddock-abs-");
      await fs.writeFile(path.join(outside, "far.md"), "# Far\n\noutside the wd", "utf8");
      const { result, envelope, saved } = await callTool(
        { file_path: path.join(outside, "far.md") },
        dir,
      );
      // Copy-on-send needs no sandbox: an out-of-wd path is read + snapshotted.
      expect(result.isError).toBeFalsy();
      expect(envelope?.source).toBe("file");
      expect(envelope?.attachmentId).toBeTruthy();
      expect(saved[0].bytes.toString("utf8")).toBe("# Far\n\noutside the wd");
      await rmTmpDir(outside);
    });

    it("returns a not-found error that lists the working-dir contents (so the agent can self-correct)", async () => {
      const { result } = await callTool({ file_path: "nope.md" }, dir);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain("not found");
      // The error names the working dir and lists the real file next to it, so the
      // agent doesn't have to shell out to `ls`/`find` to locate it.
      expect(text).toContain(dir);
      expect(text).toContain("real.md");
    });

    it("rejects a file larger than the attachment size cap", async () => {
      const big = path.join(dir, "big.bin");
      await fs.writeFile(big, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
      const { result } = await callTool({ file_path: "big.bin" }, dir);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("too large");
      await fs.rm(big, { force: true });
    });
  });
});
