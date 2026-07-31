import WebSocket from "ws";

const URL = "ws://127.0.0.1:5015/ws";
const MODEL = "claude-haiku-4-5-20251001";
const slug = process.env.PV_SLUG ?? "";
const message = process.argv[2];
if (!message) { console.error("usage: send.mjs <message>"); process.exit(2); }

const ws = new WebSocket(URL);
let sessionId = null;
let text = "";
const timer = setTimeout(() => { console.error("TIMEOUT"); process.exit(3); }, 240000);

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "chat:send",
    payload: { projectSlug: slug, message, model: MODEL },
  }));
});
ws.on("message", (buf) => {
  let m; try { m = JSON.parse(buf.toString()); } catch { return; }
  if (m.type === "chat:response" && typeof m.payload?.chunk === "string") text += m.payload.chunk;
  if (m.payload?.sessionId) sessionId = m.payload.sessionId;
  if (m.type === "chat:error") {
    clearTimeout(timer);
    console.log(JSON.stringify({ ok: false, error: m.payload?.error, sessionId }));
    ws.close(); process.exit(1);
  }
  if (m.type === "chat:complete") {
    clearTimeout(timer);
    console.log(JSON.stringify({
      ok: m.payload?.success !== false, raw_success: m.payload?.success, error: m.payload?.error,
      sessionId: m.payload?.sessionId ?? sessionId,
      model: m.payload?.model,
      reply: text.slice(0, 400),
    }));
    ws.close(); process.exit(0);
  }
});
ws.on("error", (e) => { clearTimeout(timer); console.error("WSERR", e.message); process.exit(4); });
