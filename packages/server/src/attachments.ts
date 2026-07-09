/**
 * Attachment store for files shared via `mcp__paddock__send_file` (issue #112).
 *
 * When an agent sends a REAL file, we copy its bytes here AT SEND TIME and record
 * only an opaque attachment id in the chat transcript (via the tool's output
 * envelope). This makes a shared file an immutable snapshot — it renders
 * identically forever, even if the original is later edited, moved, or deleted —
 * and means the render endpoint only ever serves files that were explicitly
 * sent, never an arbitrary path on the box. (Inline/virtual content is NOT stored
 * here; it rides in the transcript envelope so it stays in the agent's context.)
 *
 * Layout: a flat directory of `<uuid><ext>` files. Ids are self-locating, so the
 * serving endpoint needs only the id. Cleanup on chat delete parses the chat's
 * transcript for the ids it referenced (see `collectAttachmentIds`).
 */
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ChatMessage } from "@herdctl/core";
import { contentTypeFor } from "./projects.js";
import { SEND_FILE_TOOL_NAME, type SentFileEnvelope } from "./send-file-mcp.js";

/** `<uuid>` optionally followed by a short `.ext` — the only shape we serve. */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[A-Za-z0-9]{1,8})?$/;

export class AttachmentStore {
  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  /** Persist bytes, returning an opaque id (`<uuid>` + the source's extension). */
  async save(bytes: Buffer, filenameForExt: string): Promise<string> {
    const ext = path.extname(filenameForExt).toLowerCase().replace(/[^.a-z0-9]/g, "");
    const id = `${randomUUID()}${ext}`;
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(path.join(this.root, id), bytes);
    return id;
  }

  /** Read an attachment by id (validated), with a content-type for serving. */
  async read(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
    if (!ID_RE.test(id)) return null;
    try {
      const bytes = await fs.readFile(path.join(this.root, id));
      const mime = contentTypeFor(id);
      return {
        bytes,
        // Non-image kinds (markdown/code/text/html) are fetched as text.
        mime: mime === "application/octet-stream" ? "text/plain; charset=utf-8" : mime,
      };
    } catch {
      return null;
    }
  }

  /** Best-effort removal of a set of attachments (used on chat delete). */
  async remove(ids: string[]): Promise<void> {
    await Promise.all(
      ids
        .filter((id) => ID_RE.test(id))
        .map((id) => fs.rm(path.join(this.root, id), { force: true }).catch(() => undefined)),
    );
  }
}

/**
 * Extract the attachment ids a chat's transcript references, by parsing the
 * `send_file` tool outputs. Used to clean up a chat's attachments when it's
 * deleted. Inline sends carry no id, so they're naturally skipped.
 */
export function collectAttachmentIds(messages: ChatMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (m.toolCall?.toolName !== SEND_FILE_TOOL_NAME || !m.toolCall.output) continue;
    try {
      const env = JSON.parse(m.toolCall.output) as SentFileEnvelope;
      if (env?.paddockSendFile === 1 && env.source === "file" && env.attachmentId) {
        ids.push(env.attachmentId);
      }
    } catch {
      // Not our envelope / not JSON — skip.
    }
  }
  return ids;
}
