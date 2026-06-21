// One-shot WS chat driver for paddock (run ON the LXC, from packages/server so
// `ws` resolves). Drives a real keeper turn and streams the result to stdout.
//
//   node scripts/ws-drive.mjs '<projectSlug>' '<sessionId-or-null>' '<message-file-path>'
//
// Reads the message body from a file (avoids shell-quoting hell for long prompts).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/opt/paddock/packages/server/");
const WebSocket = require("ws");

const [, , projectSlug, sessionArg, msgFile] = process.argv;
const sessionId = sessionArg === "null" || !sessionArg ? null : sessionArg;
const message = readFileSync(msgFile, "utf8");

const url = "ws://localhost:4000/ws";
const ws = new WebSocket(url);

let finalSessionId = null;
let toolCalls = 0;
let textChunks = 0;
let done = false;

const hardTimeout = setTimeout(() => {
  console.error("TIMEOUT after 600s");
  process.exit(2);
}, 600_000);

ws.on("open", () => {
  console.error(`[open] -> ${projectSlug} (resume=${sessionId ?? "new"})`);
  ws.send(
    JSON.stringify({
      type: "chat:send",
      payload: { projectSlug, sessionId, message },
    }),
  );
});

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const p = msg.payload ?? {};
  switch (msg.type) {
    case "chat:response":
      textChunks++;
      process.stdout.write(p.chunk ?? "");
      break;
    case "chat:tool_call":
      toolCalls++;
      console.error(
        `\n[tool] ${p.toolName} ${p.inputSummary ?? ""} isError=${p.isError} ${p.durationMs ?? "?"}ms`,
      );
      break;
    case "chat:message_boundary":
      process.stdout.write("\n---\n");
      break;
    case "chat:complete":
      finalSessionId = p.sessionId ?? finalSessionId;
      console.error(
        `\n[complete] success=${p.success} sessionId=${p.sessionId} jobId=${p.jobId} error=${p.error ?? ""}`,
      );
      console.error(`SESSION_ID=${finalSessionId}`);
      console.error(`STATS textChunks=${textChunks} toolCalls=${toolCalls}`);
      done = true;
      clearTimeout(hardTimeout);
      ws.close();
      break;
    case "chat:error":
      console.error(`\n[error] ${p.error}`);
      done = true;
      clearTimeout(hardTimeout);
      ws.close();
      process.exitCode = 3;
      break;
    case "pong":
      break;
    default:
      console.error(`[?] ${msg.type}`);
  }
});

ws.on("close", () => {
  clearTimeout(hardTimeout);
  process.exit(done ? (process.exitCode ?? 0) : 4);
});
ws.on("error", (e) => {
  console.error("[ws error]", e.message);
  process.exit(5);
});
