/**
 * Paddock-native "send file" MCP tool.
 *
 * Exposes a single `paddock_send_file` tool to keeper/scratch agents via
 * herdctl's `injectedMcpServers` mechanism. The keeper runs as a `claude -p`
 * subprocess (CLI runtime), which can't reach an in-process SDK MCP server
 * directly — so herdctl's CLI runtime stands up a localhost HTTP MCP bridge for
 * each injected server and auto-allowlists its `mcp__<name>__*` tools.
 *
 * ── How the rendered file reaches (and persists in) the chat ────────────────
 * The tool returns a small JSON ENVELOPE as its result `output`. That output is
 * the one representation that survives everywhere:
 *   - live: `@herdctl/chat`'s translator forwards it verbatim on the
 *     `chat:tool_call` event;
 *   - reload: `@herdctl/core`'s history parser preserves tool `output` verbatim
 *     (it only summarizes tool *input*).
 * So the web renders from the tool call itself — no separate WS event, and a
 * refresh shows exactly what was there live. See ChatPane's `sentFileFromToolCall`.
 *
 * Two ways to send a file:
 *   - Inline / virtual: `content` + `filename` (a real-looking but possibly
 *     fictional name). The content rides IN the envelope, so it stays in the
 *     transcript and in the agent's context (the agent authored it and can
 *     revise it on a later turn). Nothing needs to exist on disk.
 *   - Real file: `file_path` (relative to the agent's working directory). Only
 *     the PATH goes in the envelope — never the bytes — so the transcript stays
 *     lean and Paddock loads the bytes on demand (sandboxed) when rendering.
 *
 * The optional `kind` selects the renderer; when omitted it's inferred from the
 * filename extension.
 */
import { basename, extname, relative, resolve } from "node:path";
import { readdir, realpath } from "node:fs/promises";
import type { InjectedMcpServerDef, McpToolCallResult } from "@herdctl/core";

/** The renderer the web side should use for a sent file. */
export type SentFileKind = "markdown" | "mermaid" | "code" | "text" | "html" | "image";

/**
 * The JSON envelope returned as the tool's result `output`. The web parses this
 * off the tool call (live + on reload). `paddockSendFile` is a version/discriminator
 * so the client can be sure a tool output is one of ours before parsing.
 */
export interface SentFileEnvelope {
  paddockSendFile: 1;
  filename: string;
  kind: SentFileKind;
  language?: string;
  /** "inline" carries `content`; "file" carries `path` and Paddock loads bytes. */
  source: "inline" | "file";
  content?: string;
  path?: string;
  message?: string;
}

/** Per-turn context: where to resolve + sandbox a real `file_path`. */
export interface SendFileContext {
  /** The agent's working directory — resolves + sandboxes `file_path`. */
  workingDirectory?: string;
}

const MARKDOWN_EXT = new Set([".md", ".mdx", ".markdown"]);
const MERMAID_EXT = new Set([".mmd", ".mermaid"]);
const HTML_EXT = new Set([".html", ".htm"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]);
/** Extension -> language label for the code-block filename chrome. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".sql": "sql",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".css": "css",
  ".scss": "scss",
  ".xml": "xml",
};

function inferKind(filename: string): SentFileKind {
  const ext = extname(filename).toLowerCase();
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (MERMAID_EXT.has(ext)) return "mermaid";
  if (HTML_EXT.has(ext)) return "html";
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext in LANGUAGE_BY_EXT) return "code";
  return "text";
}

function inferLanguage(filename: string): string | undefined {
  return LANGUAGE_BY_EXT[extname(filename).toLowerCase()];
}

function ok(envelope: SentFileEnvelope): McpToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
}

/**
 * A short listing of a directory's top-level entries, to append to a
 * file-not-found / escape error so the agent can immediately see the right
 * filename instead of shelling out to `ls`/`find` to hunt for it (the main
 * source of friction observed with screenshot flows). Files first, then dirs;
 * capped so a large dir doesn't flood the tool result.
 */
async function describeDir(dir: string): Promise<string> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`);
    const shown = [...files, ...dirs].slice(0, 40);
    if (shown.length === 0) return "It is currently empty.";
    const more = files.length + dirs.length > shown.length ? ", …" : "";
    return `Entries in it: ${shown.join(", ")}${more}.`;
  } catch {
    return "";
  }
}

function fail(text: string): McpToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

const TOOL_NAME = "send_file";
const SERVER_NAME = "paddock";

const TOOL_DESCRIPTION =
  "Render a file inline in the Paddock chat so the user sees it nicely formatted. " +
  "Use this to share a document, code snippet, or diagram. Two modes: (1) pass `content` " +
  "with a `filename` to render inline/virtual content that need not exist on disk (great " +
  "for a code snippet or a Markdown/Mermaid block — the filename can be illustrative, e.g. " +
  "`example.tsx` or `architecture.mmd`); or (2) pass `file_path` to render a real file from " +
  "your working directory. Markdown renders formatted, ```mermaid``` blocks (or a .mmd file / " +
  "kind:'mermaid') render as diagrams, and code renders with a filename header. Prefer this " +
  "over pasting long content into your text reply.";

const TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    content: {
      type: "string",
      description:
        "Inline file contents to render (for a virtual/illustrative file). Provide this OR file_path.",
    },
    file_path: {
      type: "string",
      description:
        "Path to a real file to render, relative to (or absolute within) your working directory. Provide this OR content.",
    },
    filename: {
      type: "string",
      description:
        "Display filename shown in the file header (e.g. `example.tsx`, `README.md`, `flow.mmd`). Required with `content`; defaults to the basename of `file_path`.",
    },
    kind: {
      type: "string",
      enum: ["markdown", "mermaid", "code", "text", "html", "image"],
      description:
        "Renderer to use. Optional — inferred from the filename extension when omitted.",
    },
    language: {
      type: "string",
      description: "Language hint for the `code` kind (e.g. `python`). Optional.",
    },
    message: {
      type: "string",
      description: "Optional note to show alongside the file.",
    },
  },
  required: ["filename"],
};

function createHandler(context: SendFileContext) {
  return async (args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      const rawContent = typeof args.content === "string" ? (args.content as string) : undefined;
      const filePath = typeof args.file_path === "string" ? (args.file_path as string) : undefined;
      const filenameArg = typeof args.filename === "string" ? (args.filename as string) : undefined;
      const kindArg = typeof args.kind === "string" ? (args.kind as SentFileKind) : undefined;
      const languageArg = typeof args.language === "string" ? (args.language as string) : undefined;
      const message = typeof args.message === "string" ? (args.message as string) : undefined;

      if (rawContent === undefined && filePath === undefined) {
        return fail("Error: provide either `content` (inline) or `file_path` (a real file).");
      }

      if (rawContent !== undefined) {
        // Inline / virtual file — content rides in the envelope.
        const filename = filenameArg ?? "snippet.txt";
        const kind = kindArg ?? inferKind(filename);
        if (kind === "image") {
          return fail("Error: inline `content` cannot be an image; use `file_path` for images.");
        }
        return ok({
          paddockSendFile: 1,
          filename,
          kind,
          language: kind === "code" ? (languageArg ?? inferLanguage(filename)) : undefined,
          source: "inline",
          content: rawContent,
          message,
        });
      }

      // Real file — resolve + sandbox to the working directory (symlink-safe).
      // Only the PATH is recorded; the bytes are loaded later by Paddock.
      const wd = context.workingDirectory;
      if (!wd) {
        return fail("Error: no working directory available to resolve `file_path`.");
      }
      const resolved = resolve(wd, filePath as string);
      let realPath: string;
      try {
        realPath = await realpath(resolved);
      } catch {
        return fail(
          `Error: file not found: ${filePath} (looked for ${resolved}). ` +
            `Your working directory is ${wd}. ${await describeDir(wd)} ` +
            `Pass a path relative to your working directory (screenshots from the ` +
            `browser tools are saved there).`,
        );
      }
      const realWd = await realpath(wd);
      const rel = relative(realWd, realPath);
      if (rel.startsWith("..") || rel.startsWith("/")) {
        return fail(
          `Error: file path escapes your working directory: ${filePath} resolves to ` +
            `${realPath}, outside ${wd}. Only files inside your working directory can be ` +
            `sent. ${await describeDir(wd)}`,
        );
      }
      const filename = filenameArg ?? basename(resolved);
      const kind = kindArg ?? inferKind(filename);
      return ok({
        paddockSendFile: 1,
        filename,
        kind,
        language: kind === "code" ? (languageArg ?? inferLanguage(filename)) : undefined,
        source: "file",
        path: rel,
        message,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return fail(`Error sending file: ${msg}`);
    }
  };
}

/**
 * Build the injected MCP server definition for the send-file tool, bound to a
 * per-turn context. Pass the returned value under a stable server key (`paddock`)
 * so the tool surfaces to the agent as `mcp__paddock__send_file`.
 */
export function sendFileServerDef(context: SendFileContext): InjectedMcpServerDef {
  return {
    name: SERVER_NAME,
    version: "0.1.0",
    tools: [
      {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        inputSchema: TOOL_INPUT_SCHEMA,
        handler: createHandler(context),
      },
    ],
  };
}

/** The record key + resulting fully-qualified tool name the agent sees. */
export const SEND_FILE_SERVER_KEY = SERVER_NAME;
export const SEND_FILE_TOOL_NAME = `mcp__${SERVER_NAME}__${TOOL_NAME}`;
