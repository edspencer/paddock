/**
 * scene3-prep.mjs — seed the parent chat Scene 3 is shot in.
 *
 * Scene 3 needs a chat that ALREADY looks like real work in progress: a human
 * opening message and a keeper reply. Recording that first turn would waste
 * footage, so it is seeded here, out of camera, over the same WS the UI uses.
 *
 * Writes $PADDOCK_VIDEO_OUT/tmp/scene3.json so the scene script (and any
 * re-take of a single shot) can find the chat again.
 *
 *   env -u NODE_ENV node video/videos/intro-90s/scenes/scene3-prep.mjs
 */
import WebSocket from "ws";
import fs from "node:fs/promises";
import path from "node:path";
import { TMP_DIR } from "../../../lib/paths.mjs";

const STATE = path.join(TMP_DIR, "scene3.json");

const WS_URL = "ws://127.0.0.1:5015/ws";
const HTTP = "http://127.0.0.1:5015";
const MODEL = "claude-haiku-4-5-20251001";
export const SLUG = "hushpod";

/** The opening message. Short, concrete, and sets up "split this three ways". */
const SEED =
  "We're shipping HushPod v0.4: a chapter-skip API, sharper ad detection, " +
  "and a self-hosting guide. Give me the shape of the work in three short bullets.";

/** What the parent chat is called in the sidebar. Kept short so it never truncates. */
const PARENT_NAME = "Ship HushPod v0.4";

export function sendTurn({ message, slug = SLUG, resume = null, model = MODEL }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let sessionId = resume;
    let text = "";
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("turn timeout"));
    }, 300000);
    ws.on("open", () => {
      const payload = { projectSlug: slug, message, model };
      if (resume) payload.sessionId = resume;
      ws.send(JSON.stringify({ type: "chat:send", payload }));
    });
    ws.on("message", (buf) => {
      let m;
      try {
        m = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (m.type === "chat:response" && typeof m.payload?.chunk === "string") text += m.payload.chunk;
      if (m.payload?.sessionId) sessionId = m.payload.sessionId;
      if (m.type === "chat:error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(m.payload?.error ?? "chat:error"));
      }
      if (m.type === "chat:complete") {
        clearTimeout(timer);
        ws.close();
        resolve({ sessionId, reply: text });
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function rename(slug, sessionId, name) {
  const res = await fetch(`${HTTP}/api/projects/${slug}/chats/${sessionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`rename ${res.status}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { sessionId, reply } = await sendTurn({ message: SEED });
  await rename(SLUG, sessionId, PARENT_NAME);
  await fs.mkdir(path.dirname(STATE), { recursive: true });
  await fs.writeFile(
    STATE,
    JSON.stringify({ slug: SLUG, parent: sessionId, name: PARENT_NAME }, null, 2),
  );
  console.log("parent chat:", sessionId);
  console.log("reply:", reply.slice(0, 400));
}
