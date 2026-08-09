#!/usr/bin/env node
/**
 * Stage a real composer attachment so `using/sending-files-and-images.md` can be
 * photographed.
 *
 * WHY THIS EXISTS
 * seed.mjs writes transcripts directly to `.chats/*.jsonl`, which is fine for
 * chat *lists* but cannot produce an attachment: an attachment is a row in the
 * attachment store plus an `attachments` array on the sent frame, and the store
 * is only written by the upload route. Hand-writing the JSONL would fabricate a
 * shape and risk photographing something the UI renders only by accident.
 *
 * So this drives the two real steps a browser takes:
 *   1. POST multipart `file` parts to /chats/:sessionId/upload  -> { files: [{id, filename, size, kind}] }
 *   2. chat:send over the WS with `attachments: [{id, filename, kind}]`
 * (routes/meta.ts:444, ws-protocol.ts:270-281)
 *
 * The rig runs the fake `claude` on driveMode: batch with the credentials
 * unset, so the reply costs nothing.
 *
 * Run: node stage-attachments.mjs [--base URL] [--slug SLUG]   (or $PADDOCK_RIG_BASE)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import WebSocket from "ws";

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : d;
};
const BASE = arg("--base", process.env.PADDOCK_RIG_BASE || "http://127.0.0.1:4000");
const SLUG = arg("--slug", "tidepool");
const TMP = process.env.PADDOCK_STAGE_TMP || "./.stage-attachments";

/**
 * A plausible thing to drop into this project's chat. Deliberately plain: it is
 * a prop inside a screenshot of the *composer*, not a chart anyone reads. One
 * series, no gridlines, no legend — nothing to misread at thumbnail size.
 */
const CHART_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420">
  <rect width="720" height="420" fill="#ffffff"/>
  <text x="32" y="44" font-family="Helvetica,Arial,sans-serif" font-size="19" fill="#1c1c1c">Dover gauge — residual after drift correction</text>
  <text x="32" y="68" font-family="Helvetica,Arial,sans-serif" font-size="13" fill="#6b6b6b">metres, 30-day window</text>
  <line x1="72" y1="360" x2="672" y2="360" stroke="#c9c9c9" stroke-width="1"/>
  <line x1="72" y1="110" x2="72" y2="360" stroke="#c9c9c9" stroke-width="1"/>
  <polyline fill="none" stroke="#2f6f8f" stroke-width="2.5"
    points="72,300 122,286 172,304 222,268 272,282 322,236 372,254 422,214 472,232 522,190 572,206 622,172 672,188"/>
  <text x="60" y="366" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#6b6b6b">0.00</text>
  <text x="60" y="116" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#6b6b6b">0.25</text>
  <text x="72" y="384" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#6b6b6b">1 Jul</text>
  <text x="672" y="384" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#6b6b6b">30 Jul</text>
</svg>`;

const CSV = `station,captured_at,reading_m,flag
dover,2026-07-28T04:00:00Z,2.184,ok
dover,2026-07-28T04:15:00Z,2.201,ok
dover,2026-07-28T04:30:00Z,2.219,suspect
dover,2026-07-28T04:45:00Z,2.240,ok
newhaven,2026-07-28T04:00:00Z,1.902,ok
newhaven,2026-07-28T04:15:00Z,1.911,ok
`;

async function makePng() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 720, height: 420 } });
  await page.setContent(
    `<body style="margin:0">${CHART_SVG}</body>`,
  );
  await page.screenshot({ path: `${TMP}/dover-residual.png` });
  await browser.close();
}

async function upload(files) {
  const fd = new FormData();
  for (const f of files) {
    fd.append(
      "file",
      new Blob([readFileSync(f.path)], { type: f.type }),
      f.name,
    );
  }
  // sessionId is accepted for a not-yet-created chat — it only scopes the
  // request (routes/meta.ts:441-443), so a fresh uuid is correct here.
  const sid = crypto.randomUUID();
  const res = await fetch(`${BASE}/api/projects/${SLUG}/chats/${sid}/upload`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text()}`);
  const { files: out } = await res.json();
  console.log(`uploaded ${out.length}:`, out.map((f) => `${f.filename} (${f.kind})`).join(", "));
  return out;
}

function send(attachments, message) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws`);
    const t = setTimeout(() => reject(new Error("no chat:complete in 120s")), 120000);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "chat:send",
          payload: {
            projectSlug: SLUG,
            sessionId: null,
            message,
            attachments: attachments.map((f) => ({
              id: f.id,
              filename: f.filename,
              kind: f.kind,
            })),
          },
        }),
      ),
    );
    ws.on("message", (b) => {
      const f = JSON.parse(b.toString());
      if (f.type === "chat:complete") {
        clearTimeout(t);
        ws.close();
        resolve(f.payload);
      }
      if (f.type === "chat:error") {
        clearTimeout(t);
        reject(new Error(JSON.stringify(f.payload)));
      }
    });
    ws.on("error", reject);
  });
}

async function main() {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(TMP, { recursive: true });
  await makePng();
  writeFileSync(`${TMP}/gauge-readings.csv`, CSV);

  const files = await upload([
    { path: `${TMP}/dover-residual.png`, name: "dover-residual.png", type: "image/png" },
    { path: `${TMP}/gauge-readings.csv`, name: "gauge-readings.csv", type: "text/csv" },
  ]);

  const done = await send(
    files,
    "Here's the residual after the drift fix, plus the raw rows it came from. The 04:30 sample is the one that keeps tripping the validator.",
  );
  console.log("COMPLETE", JSON.stringify(done));
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
