/**
 * Paddock-native "send file" MCP tool.
 *
 * Exposes a single `paddock_send_file` tool to keeper/scratch agents via
 * herdctl's `injectedMcpServers` mechanism. The keeper runs as a `claude -p`
 * subprocess (CLI runtime), which can't reach an in-process SDK MCP server
 * directly — so herdctl's CLI runtime stands up a localhost HTTP MCP bridge for
 * each injected server and auto-allowlists its `mcp__<name>__*` tools. This
 * handler therefore runs IN the Paddock Node process, capturing the current
 * chat turn via closure (`context.onFile`) so it can push a `chat:file` frame
 * straight into the live WS stream.
 *
 * Two ways to send a file:
 *   - Inline / virtual: pass `content` + `filename` (a real-looking but possibly
 *     fictional name, MDX ```filename-chrome style). Nothing needs to exist on
 *     disk.
 *   - Real file: pass `file_path` (relative to the agent's working directory, or
 *     absolute within it). Read with a symlink-escape guard, mirroring herdctl's
 *     own file-sender.
 *
 * The optional `kind` selects the renderer; when omitted it's inferred from the
 * filename extension. This is the injected-server half of issue #112; the web
 * side renders the emitted `chat:file` frame with the existing Markdown / Mermaid
 * / image componentry.
 */
import { readFile, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import type { InjectedMcpServerDef, McpToolCallResult } from "@herdctl/core";

/** The renderer the web side should use for a sent file. */
export type SentFileKind = "markdown" | "mermaid" | "code" | "text" | "html" | "image";

/** The payload handed to the WS layer (and forwarded to the browser). */
export interface SentFile {
  filename: string;
  kind: SentFileKind;
  /** Language hint for the `code` kind (drives the filename-chrome label). */
  language?: string;
  /** UTF-8 text for text-ish kinds (markdown/mermaid/code/text/html). */
  content?: string;
  /** `data:` URL for the `image` kind (binary files are base64-inlined). */
  dataUrl?: string;
  /** Optional note the agent attached to the file. */
  message?: string;
}

/** Per-turn context: where to resolve real files, and where to route the result. */
export interface SendFileContext {
  /** The agent's working directory — resolves + sandboxes `file_path`. */
  workingDirectory?: string;
  /** Sink for a produced file (implemented by the WS layer as a `turn.emit`). */
  onFile: (file: SentFile) => void;
}

const MARKDOWN_EXT = new Set([".md", ".mdx", ".markdown"]);
const MERMAID_EXT = new Set([".mmd", ".mermaid"]);
const HTML_EXT = new Set([".html", ".htm"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};
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
  if (ext in IMAGE_MIME) return "image";
  if (ext in LANGUAGE_BY_EXT) return "code";
  return "text";
}

function inferLanguage(filename: string): string | undefined {
  return LANGUAGE_BY_EXT[extname(filename).toLowerCase()];
}

function ok(text: string): McpToolCallResult {
  return { content: [{ type: "text", text }] };
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

      let filename: string;
      let kind: SentFileKind;
      let content: string | undefined;
      let dataUrl: string | undefined;

      if (rawContent !== undefined) {
        // Inline / virtual file.
        filename = filenameArg ?? "snippet.txt";
        kind = kindArg ?? inferKind(filename);
        if (kind === "image") {
          return fail("Error: inline `content` cannot be an image; use `file_path` for images.");
        }
        content = rawContent;
      } else {
        // Real file — resolve + sandbox to the working directory (symlink-safe).
        const wd = context.workingDirectory;
        if (!wd) {
          return fail("Error: no working directory available to resolve `file_path`.");
        }
        const resolved = resolve(wd, filePath as string);
        let realPath: string;
        try {
          realPath = await realpath(resolved);
        } catch {
          return fail(`Error: file not found: ${filePath}`);
        }
        const realWd = await realpath(wd);
        const rel = relative(realWd, realPath);
        if (rel.startsWith("..") || rel.startsWith("/")) {
          return fail(`Error: file path escapes working directory: ${filePath}`);
        }
        filename = filenameArg ?? basename(resolved);
        kind = kindArg ?? inferKind(filename);
        if (kind === "image") {
          const ext = extname(filename).toLowerCase();
          const mime = IMAGE_MIME[ext] ?? "application/octet-stream";
          const buf = await readFile(realPath);
          dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
        } else {
          content = await readFile(realPath, "utf8");
        }
      }

      const language = kind === "code" ? (languageArg ?? inferLanguage(filename)) : undefined;

      context.onFile({ filename, kind, language, content, dataUrl, message });

      return ok(`Rendered "${filename}" in the chat (kind: ${kind}).`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return fail(`Error sending file: ${msg}`);
    }
  };
}

/**
 * Build the injected MCP server definition for the send-file tool, bound to a
 * per-turn context. Pass the returned record value under a stable server key
 * (`paddock`) so the tool surfaces to the agent as `mcp__paddock__send_file`.
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
