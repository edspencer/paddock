/**
 * scene4-prep.mjs — seed the two chats Scene 4's LIVE shots are filmed in.
 *
 * Same rationale as scene3-prep: a chat that already looks like work in progress
 * reads better than an empty one, and recording the setup turn would waste
 * footage. Both chats are created HERE, out of camera, over the same WS the UI
 * uses, so nothing from the copied production transcripts ends up on screen.
 *
 * Writes $PADDOCK_VIDEO_OUT/tmp/scene4.json for scene4.mjs (and for any
 * re-take of a single shot).
 *
 *   env -u NODE_ENV node video/videos/intro-90s/scenes/scene4-prep.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { TMP_DIR } from "../../../lib/paths.mjs";
import { sendTurn } from "./scene3-prep.mjs";

const STATE = path.join(TMP_DIR, "scene4.json");
const HTTP = "http://127.0.0.1:5015";
const SLUG = "hushpod";

/** The chat s4-sendfile is shot in. */
const FILE_SEED =
  "We're cutting HushPod v0.4 this week. What's on the release checklist?";
const FILE_NAME = "v0.4 release checklist";

/** The chat s4-crossproject is shot in. */
const CROSS_SEED =
  "The chapter-skip API is shipped. Who else should hear about it?";
const CROSS_NAME = "Announce chapter-skip";

async function rename(slug, sessionId, name) {
  const res = await fetch(`${HTTP}/api/projects/${slug}/chats/${sessionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`rename ${res.status}`);
}

const out = {};
for (const [key, message, name] of [
  ["file", FILE_SEED, FILE_NAME],
  ["cross", CROSS_SEED, CROSS_NAME],
]) {
  const { sessionId, reply } = await sendTurn({ message, slug: SLUG });
  await rename(SLUG, sessionId, name);
  out[key] = sessionId;
  console.log(`${key}: ${sessionId}\n  ${reply.slice(0, 200).replace(/\n/g, " ")}\n`);
}

await fs.mkdir(path.dirname(STATE), { recursive: true });
await fs.writeFile(STATE, JSON.stringify({ slug: SLUG, ...out }, null, 2));
console.log("wrote", STATE);
