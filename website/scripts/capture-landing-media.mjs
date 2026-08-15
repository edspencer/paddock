#!/usr/bin/env node
/**
 * capture-landing-media.mjs — the landing page's feature crops, as a script.
 *
 * The "How it works" section needs media framed on ONE feature at close to 1:1,
 * not full-window screenshots (a 1280x800 capture renders at about half scale in
 * the ~700px media column and every label turns to mush). Some of those crops
 * exist already in website/src/assets; the ones that do not are captured here.
 *
 * This is a script rather than a list of clicks for the same reason
 * tools/docs-media/capture.mjs is: a visual-design change makes every crop stale
 * at once, and re-shooting has to be one command rather than a human
 * re-deriving a dozen navigation paths and framings from memory.
 *
 * ── Why not just extend scripts/demo-gif/shoot.mjs ──────────────────────────
 * That rig exists to make the README reel and renders at a fixed 1200x750,
 * because that is the reel's frame. Two of these shots need a taller viewport to
 * get both cards in — the send_file shot in particular looked almost empty at
 * 750px, with a small diagram stranded in a tall card. Rather than distort the
 * reel's framing to serve the website, this drives the same seeded server at its
 * own viewport.
 *
 * ── Running it ──────────────────────────────────────────────────────────────
 *   # 1. seed and boot the synthetic demo instance (four minutes, throwaway)
 *   env -u NODE_ENV node scripts/demo-gif/shoot.mjs --out /tmp/paddock-demo --port 7311
 *   env -u NODE_ENV node scripts/demo-gif/serve.mjs --data /tmp/paddock-demo/data --port 5099
 *
 *   # 2. capture
 *   env -u NODE_ENV node website/scripts/capture-landing-media.mjs \
 *     --base http://127.0.0.1:5099 --manifest /tmp/paddock-demo/manifest.json
 *
 * Everything it photographs is SYNTHETIC — invented projects, invented chats, an
 * invented git repo, seeded by scripts/demo-gif/seed.mjs. That is a hard
 * constraint: these ship on a public marketing page. Never point `--base` at a
 * real instance.
 *
 * Shots are written at deviceScaleFactor 2, so a 1400px-wide capture is 700 CSS
 * px on the page and stays crisp on a retina display.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DEFAULT = path.join(HERE, "..", "src", "assets", "landing");

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? dflt : argv[i + 1];
};

const BASE = arg("base", "http://127.0.0.1:5099").replace(/\/$/, "");
const MANIFEST = arg("manifest", "/tmp/paddock-demo/manifest.json");
const OUT = path.resolve(arg("out", OUT_DEFAULT));
const ONLY = arg("only", null);

if (!fs.existsSync(MANIFEST)) {
	console.error(
		`No manifest at ${MANIFEST}. Run scripts/demo-gif/shoot.mjs first — it seeds the instance and writes the chat ids this script navigates by.`,
	);
	process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const chat = (key) => {
	const id = manifest.chats[key];
	if (!id) throw new Error(`manifest has no chat "${key}" — did seed.mjs change?`);
	return id;
};

/**
 * Each shot names the landing-page block it serves, so a stale crop can be
 * traced back to the copy that depends on it (same contract as
 * tools/docs-media/capture.mjs).
 *
 * `frame` returns the locators the crop must contain. The clip is their union
 * plus `pad`, which keeps the framing declarative — no hand-tuned pixel
 * rectangles that silently drift when the UI's spacing changes.
 */
const SHOTS = [
	{
		id: "spawn-cross-project",
		block: "Chats spawn chats",
		url: () => `${BASE}/projects/lumen-cli/chat/${chat("lumen-cli:star")}`,
		viewport: { width: 1280, height: 1000 },
		// Both create_chat cards. They are expanded by default and each names the
		// OTHER project it created a chat in, which is the whole point of the shot.
		//
		// `..` climbs to the card CONTAINER. The matched <button> is only the
		// card's header row — framing on it crops to a 33px strip and loses the
		// body, which is where "Created chat X in trail-atlas" and the kickoff
		// prompt actually live.
		frame: (page) => [
			page.locator("button").filter({ hasText: /Create chat/i }).first().locator(".."),
			page.locator("button").filter({ hasText: /Create chat/i }).last().locator(".."),
		],
		async prepare(page) {
			const first = page.locator("button").filter({ hasText: /Create chat/i }).first();
			await first.waitFor({ timeout: 20_000 });
			await first.scrollIntoViewIfNeeded();
			await page.waitForTimeout(1_200);
		},
	},
	{
		id: "sendfile-inline",
		block: "The agent sends you things",
		url: () => `${BASE}/projects/lumen-cli/chat/${chat("lumen-cli:handoff")}`,
		// Taller than the reel's frame on purpose: at 750px the markdown card is
		// pushed off-screen and the shot reduces to one small diagram in a lot of
		// empty card.
		viewport: { width: 1280, height: 1000 },
		// ⚠️ Mermaid lays out WRONG under `reducedMotion: "reduce"`, and this cost
		// an hour to find. Measured on this very diagram, same page, same viewport,
		// changing only that flag:
		//
		//   default            viewBox "0 0 1250.5 247.75"        svg 590x117
		//   reducedMotion      viewBox "-110.5 -76.5 2118.5 2084.5"  svg 590x580
		//
		// It is not a timing problem — it is stable across a 9-second wait, a
		// reload with warm font cache, and a forced theme re-render, all of which
		// were tried first. The inflated viewBox leaves the diagram stranded in the
		// top fifth of a card five times too tall, which then swallows the markdown
		// card below it and makes the union crop mostly empty.
		reducedMotion: "no-preference",
		// Both cards in full run to ~700px, which would set the stage height for
		// all eight blocks. This keeps the diagram whole and the document's title
		// and opening paragraph, and lets the rest run off the bottom.
		maxHeight: 520,
		// `pipeline.md` is NOT a substring of `pipeline.mmd` (…e.m-m-d vs …e.m-d),
		// so a plain match picks out the markdown card unambiguously. Anchoring it
		// instead does not work: the card's textContent runs the filename and the
		// kind badge together as "pipeline.mdmarkdown".
		// `..` for the same reason as the spawn shot: the match is the card's
		// header row, and the body underneath is the part worth photographing.
		frame: (page) => [
			page.locator("button").filter({ hasText: /pipeline\.mmd/ }).first().locator(".."),
			page.locator("button").filter({ hasText: /pipeline\.md/ }).first().locator(".."),
		],
		async prepare(page) {
			// Mermaid draws client-side from a code-split chunk, so the diagram
			// arrives a beat after the page is otherwise idle. Wait for the actual
			// <svg>, not the card: mermaid stamps its own ids (`mmd-r24-svg`), so
			// `svg[id^="mermaid"]` never matches and the wait times out even though
			// the diagram drew fine.
			await page.locator(".mermaid-host svg").first().waitFor({ timeout: 30_000 });
			await page.locator("button").filter({ hasText: /pipeline\.mmd/ }).first().scrollIntoViewIfNeeded();
			await page.waitForTimeout(1_500);
		},
	},
	{
		id: "git-changes",
		block: "Projects are git repos",
		url: () => `${BASE}/projects/lumen-cli/changes`,
		viewport: { width: 1280, height: 900 },
		frame: (page) => [page.locator("main, [role='main']").first()],
		async prepare(page) {
			const file = page.getByText("src/render.ts").first();
			await file.waitFor({ timeout: 20_000 });
			await file.click();
			await page.waitForTimeout(1_500);
		},
	},
];

const browser = await chromium.launch();
fs.mkdirSync(OUT, { recursive: true });

for (const shot of SHOTS) {
	if (ONLY && shot.id !== ONLY) continue;

	const context = await browser.newContext({
		viewport: shot.viewport,
		deviceScaleFactor: 2,
		colorScheme: "dark",
		// Every still should be frame-for-frame reproducible; the only motion here
		// would be spinners and carets. A shot can opt out — see the Mermaid note
		// on `sendfile-inline`, which has to.
		reducedMotion: shot.reducedMotion ?? "reduce",
	});
	const page = await context.newPage();

	await page.goto(shot.url(), { waitUntil: "networkidle" });
	await shot.prepare(page);

	// Union of the framed locators, plus padding, clamped to the viewport.
	const boxes = [];
	for (const loc of shot.frame(page)) {
		const b = await loc.boundingBox();
		if (b) boxes.push(b);
	}
	if (!boxes.length) throw new Error(`${shot.id}: nothing to frame`);

	const pad = 14;
	const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
	const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
	const right = Math.min(shot.viewport.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
	let bottom = Math.min(shot.viewport.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);

	// `maxHeight` deliberately cuts a card off mid-content. All eight crops share
	// one sticky stage on the landing page, and the stage takes the height of the
	// TALLEST of them — so one 700px-tall shot makes every other block's frame
	// that tall and pushes the whole section past a laptop viewport. Truncating
	// mid-paragraph also reads correctly here: it says "there is more document
	// below", which is true.
	if (shot.maxHeight) bottom = Math.min(bottom, y + shot.maxHeight);

	const file = path.join(OUT, `${shot.id}.png`);
	await page.screenshot({ path: file, clip: { x, y, width: right - x, height: bottom - y } });

	const { size } = fs.statSync(file);
	console.log(
		`[capture] ${shot.id.padEnd(22)} ${Math.round(right - x)}x${Math.round(bottom - y)} CSS  ` +
			`(${(size / 1024).toFixed(0)} KB)  — ${shot.block}`,
	);

	await context.close();
}

await browser.close();
console.log(`\nWrote to ${OUT}`);
