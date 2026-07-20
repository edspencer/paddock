/**
 * The attachment store backing `mcp__paddock__send_file` real-file sends (#112):
 * copy-on-send bytes, id-addressed serving with a content-type, id validation,
 * cleanup, and extracting a chat's referenced ids from its transcript.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "@herdctl/core";
import { AttachmentStore, collectAttachmentIds } from "../../src/attachments.js";
import { SEND_FILE_TOOL_NAME } from "../../src/send-file-mcp.js";
import { wrapAttachments } from "../../src/attachments-hint.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("AttachmentStore", () => {
  let root: string;
  let store: AttachmentStore;
  beforeEach(async () => {
    root = await makeTmpDir("paddock-att-");
    store = new AttachmentStore(root);
    await store.init();
  });
  afterEach(async () => {
    await rmTmpDir(root);
  });

  it("saves bytes under a uuid id preserving the extension, and reads them back", async () => {
    const id = await store.save(Buffer.from("hello"), "greeting.txt");
    expect(id).toMatch(/^[0-9a-f-]{36}\.txt$/);
    const read = await store.read(id);
    expect(read?.bytes.toString("utf8")).toBe("hello");
    // Non-image → served as text.
    expect(read?.mime).toContain("text/plain");
  });

  it("serves an image id with its image content-type", async () => {
    const id = await store.save(Buffer.from([0x89, 0x50]), "shot.png");
    const read = await store.read(id);
    expect(read?.mime).toBe("image/png");
  });

  it("serves a pdf id as application/pdf (not rewritten to text/plain)", async () => {
    const id = await store.save(Buffer.from("%PDF-1.4"), "report.pdf");
    const read = await store.read(id);
    expect(read?.mime).toBe("application/pdf");
  });

  it("returns null for a malformed id (no path traversal)", async () => {
    expect(await store.read("../etc/passwd")).toBeNull();
    expect(await store.read("not-a-uuid")).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    expect(await store.read("11111111-2222-3333-4444-555555555555.png")).toBeNull();
  });

  it("removes attachments and ignores malformed ids", async () => {
    const id = await store.save(Buffer.from("x"), "a.txt");
    await store.remove([id, "../evil"]);
    expect(await store.read(id)).toBeNull();
    // The bogus id must not have caused anything outside the store to be touched.
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("absolutePath returns the on-disk path for a valid id, null for a bad one (#328)", async () => {
    const id = await store.save(Buffer.from("x"), "a.png");
    expect(store.absolutePath(id)).toBe(path.join(root, id));
    expect(store.absolutePath("../evil")).toBeNull();
    expect(store.absolutePath("not-a-uuid")).toBeNull();
  });

  it("exists reflects on-disk presence and rejects malformed ids (#328)", async () => {
    const id = await store.save(Buffer.from("x"), "a.png");
    expect(await store.exists(id)).toBe(true);
    expect(await store.exists("11111111-2222-3333-4444-555555555555.png")).toBe(false);
    expect(await store.exists("../evil")).toBe(false);
  });
});

describe("collectAttachmentIds", () => {
  const toolMsg = (output: string): ChatMessage => ({
    role: "tool",
    content: output,
    timestamp: "2026-07-09T00:00:00Z",
    toolCall: { toolName: SEND_FILE_TOOL_NAME, output, isError: false },
  });

  it("extracts ids from file-source send_file envelopes only", () => {
    const messages: ChatMessage[] = [
      toolMsg(JSON.stringify({ paddockSendFile: 1, source: "file", attachmentId: "id-a", filename: "a.png", kind: "image" })),
      // inline send → no attachment
      toolMsg(JSON.stringify({ paddockSendFile: 1, source: "inline", content: "# hi", filename: "b.md", kind: "markdown" })),
      toolMsg(JSON.stringify({ paddockSendFile: 1, source: "file", attachmentId: "id-c", filename: "c.pdf", kind: "text" })),
      // a different tool's output must be ignored
      { role: "tool", content: "ok", timestamp: "t", toolCall: { toolName: "Bash", output: "ok", isError: false } },
    ];
    expect(collectAttachmentIds(messages)).toEqual(["id-a", "id-c"]);
  });

  it("ignores non-JSON / non-envelope outputs", () => {
    expect(collectAttachmentIds([toolMsg("not json")])).toEqual([]);
  });

  it("also collects ids from a user-message attachment wrapper (#328 cleanup)", () => {
    const wrapped = wrapAttachments(
      [
        { id: "u1.png", filename: "shot.png", kind: "image", path: "/x/u1.png" },
        { id: "u2.csv", filename: "data.csv", kind: "text", path: "/x/u2.csv" },
      ],
      "please review",
    );
    const messages: ChatMessage[] = [
      { role: "user", content: wrapped, timestamp: "t" },
      toolMsg(JSON.stringify({ paddockSendFile: 1, source: "file", attachmentId: "id-a", filename: "a.png", kind: "image" })),
    ];
    // Both the user-uploaded ids and the send_file id are collected (in message
    // order) for removal.
    expect(collectAttachmentIds(messages)).toEqual(["u1.png", "u2.csv", "id-a"]);
  });
});
