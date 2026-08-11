#!/usr/bin/env node
/**
 * Drive real turns into the rig so the chat list has texture.
 *
 * seed.mjs creates projects and adoptable transcripts; it cannot create CHATS,
 * because a chat is the product of a turn. This runs those turns through the
 * fake `claude` on the rig's PATH, so it costs nothing and is deterministic:
 * replies come from $PADDOCK_FAKE_SCRIPT (a prompt -> reply JSON map), which is
 * how the on-camera text is authored rather than improvised.
 *
 * Env:
 *   PADDOCK_RIG_HOME   required — same var as serve.sh (identity guard)
 *   PADDOCK_RIG_BASE   instance URL (default http://127.0.0.1:4000)
 *
 * Usage:  node drive.mjs [--base http://127.0.0.1:PORT]
 */
import WebSocket from "ws";

const RIG = process.env.PADDOCK_RIG_HOME;
if (!RIG) {
  console.error("set PADDOCK_RIG_HOME (the rig scratch root — the same value serve.sh uses)");
  process.exit(1);
}
const argBase = process.argv.indexOf("--base");
const BASE =
  argBase > -1 ? process.argv[argBase + 1] : process.env.PADDOCK_RIG_BASE || "http://127.0.0.1:4000";
const API = `${BASE}/api`;
const WS = BASE.replace(/^http/, "ws") + "/ws";

// Same identity guard as seed.mjs. Driving turns into a stale squatter would
// write real chats into somebody else's instance — and on a `session` instance
// it would bill real money.
async function assertIsRig() {
  const r = await fetch(`${API}/instance-config`);
  if (!r.ok) throw new Error(`no instance at ${BASE} (${r.status})`);
  const cfg = await r.json();
  const field = (k) => cfg.groups?.flatMap((g) => g.fields ?? []).find((f) => f.key === k)?.value;
  if (field("dataDir") !== `${RIG}/data`) {
    throw new Error(`REFUSING TO DRIVE: ${BASE} reports dataDir=${field("dataDir")}, not ${RIG}/data`);
  }
  if (field("driveMode") !== "batch") {
    throw new Error(`REFUSING TO DRIVE: driveMode=${field("driveMode")} (real credit risk)`);
  }
  console.log(`✓ verified ${BASE} is the rig`);
}

/**
 * Send one message and resolve when the turn completes.
 *
 * `slug` is the WORKSPACE KEY, and the root workspace's key is the EMPTY
 * STRING — so this takes it verbatim and never tests it for truthiness. A
 * `if (!slug)` here would silently redirect every root chat to a project.
 */
function send(slug, message, sessionId = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout waiting for chat:complete (${String(message).slice(0, 40)}…)`));
    }, 120000);
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "chat:send", payload: { projectSlug: slug, sessionId, message } })),
    );
    ws.on("message", (buf) => {
      let f;
      try {
        f = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (f.type === "chat:complete") {
        clearTimeout(timer);
        ws.close();
        resolve(f.payload);
      }
      if (f.type === "chat:error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(JSON.stringify(f.payload)));
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const patch = (slug, sessionId, body) =>
  fetch(`${API}/${slug === "" ? "root" : `projects/${slug}`}/chats/${sessionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// The script. Each entry is one chat: a workspace, the prompt to send, and the
// display name to give the resulting chat. The prompts are KEYS into
// fixtures.json, so the reply on camera is authored, not improvised.
// ---------------------------------------------------------------------------
const CHATS = [
  ["tidepool", "Why do cold starts take 40s on the ingest worker?", "Why cold starts take 40s on the ingest worker"],
  ["tidepool", "Add a staleness alert for silent gauges.", "Add a staleness alert for silent gauges"],
  ["tidepool", "Normalise the Dover sensor's timestamp drift.", "Normalise the Dover sensor's timestamp drift"],
  ["tidepool", "Backfill 2024 readings from the archive bucket.", "Backfill 2024 readings from the archive bucket"],
  ["lanternfish", "The overnight run missed its window again.", "Overnight run missed its window again"],
  ["lanternfish", "Split the batch queue by priority.", "Split the batch queue by priority"],
  ["harbour-notes", "Compare the two survey methods.", "Compare the two survey methods"],
  ["", "Compare the two survey methods.", "Compare the two survey methods"],
  ["", "Draft the release note for the tide model review.", "Notes from the tide model review"],
];

async function main() {
  await assertIsRig();
  const made = [];
  for (const [slug, prompt, name] of CHATS) {
    const where = slug === "" ? "(root)" : slug;
    try {
      const res = await send(slug, prompt);
      const id = res?.sessionId;
      if (id) {
        made.push({ slug, id, name });
        console.log(`✓ ${where}: turn complete`);
      } else {
        console.log(`! ${where}: completed without a sessionId`);
      }
    } catch (e) {
      console.log(`✗ ${where}: ${String(e).split("\n")[0]}`);
    }
  }

  // Rename in a SECOND PASS, after every turn has finished.
  //
  // Renaming immediately after `chat:complete` loses the race: the transcript's
  // own title resolution (ai-title, else the first user message) lands after the
  // turn completes and overwrites the custom name. The symptom is subtle — the
  // chat is named the prompt you sent rather than the name you set, which looks
  // like a name you chose badly rather than a write that was clobbered.
  for (const m of made) {
    const r = await patch(m.slug, m.id, { name: m.name });
    console.log(`${r.ok ? "✓" : "✗"} named: ${m.name}`);
  }

  // Texture: one starred, one left unread. Both are shots in their own right
  // (starred-chats, mark-unread) and both make the sidebar look like an
  // instance somebody actually uses rather than a fresh seed.
  const tide = made.filter((m) => m.slug === "tidepool");
  if (tide[0]) {
    // Starring is its OWN route (POST …/star), not a field on the rename PATCH
    // — whose body schema accepts `name` only, so a `starred` key there is
    // accepted and silently dropped.
    await fetch(`${API}/projects/tidepool/chats/${tide[0].id}/star`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ starred: true }),
    });
    console.log(`✓ starred: ${tide[0].name}`);
  }
  if (tide[1]) {
    await fetch(`${API}/projects/tidepool/chats/${tide[1].id}/unread`, { method: "POST" }).catch(
      () => {},
    );
    console.log(`✓ marked unread: ${tide[1].name}`);
  }

  console.log(`\ndrove ${made.length} chats`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
