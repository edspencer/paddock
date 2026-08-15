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
 *
 * ── Stills, then clips, and the order matters ───────────────────────────────
 * SHOTS are read-only; CLIPS drive the UI and CHANGE the instance (the fork clip
 * really does fork a chat, which adds a row to a chat list two stills also
 * photograph). So clips run last, and a second run in the same server wants a
 * re-seed first or it films a world with yesterday's fork already in it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DEFAULT = path.join(HERE, "..", "src", "assets", "landing");
/** Clips are served from /public, not bundled through astro:assets. */
const CLIP_OUT = path.join(HERE, "..", "public", "demo");

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
		id: "project-grouping",
		block: "Chats, grouped by project",
		// Trail Atlas rather than Lumen CLI, for two reasons: it is the last item
		// in the rail, so the selected row sits below BOTH group headings and the
		// crop can show the whole grouped list above it; and its chat list is where
		// the cross-project children landed, so two rows carry the spawned badge.
		url: () => `${BASE}/projects/trail-atlas/chat/${chat("trail-atlas:tiles")}`,
		viewport: { width: 1280, height: 900 },
		// Cuts the two left columns out of the app whole — the project rail and the
		// chat list — and nothing else. An explicit rectangle rather than a locator
		// union because the subject is those two COLUMNS, which are a slice through
		// the layout rather than any element that can be pointed at.
		//
		// x ends on the divider between the chat list and the transcript. y starts
		// below the project header: including it means the header's tag chips run
		// off the right edge mid-chip, which reads as a botched crop rather than a
		// deliberate one — and the selected row in the rail already says which
		// project this is.
		clip: { x: 0, y: 108, width: 544, height: 492 },
		async prepare(page) {
			// Waiting on the list's own "CHATS" heading looks obvious and does not
			// work: it resolves first to a `hidden sm:inline` span in the responsive
			// nav, which never becomes visible at this viewport. Wait on a row
			// instead — the last one, so the whole list has rendered.
			await page.getByText(/^Why is the elevation over/).first().waitFor({ timeout: 20_000 });
			await page.waitForTimeout(1_200);
		},
	},
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
		block: "Point a project at a git repo",
		url: () => `${BASE}/projects/lumen-cli/changes`,
		viewport: { width: 1280, height: 900 },
		// An explicit rectangle rather than a locator union, and the one shot here
		// that needs one: the region worth showing is "the changed-files panel and
		// the diff beside it, without the sidebar or the project header", which is
		// a slice through the layout rather than any single element. Framing on
		// `main` pulls in the chat list and the tab bar and lands back at a
		// full-window screenshot.
		//
		// Cut below the tab bar and above the commit box: the file list with its
		// checkboxes and "3/3 selected" plus a readable red/green diff is the
		// story ("stage what you want"), and including the Commit button as well
		// runs to ~730px, which would set the stage height for all eight blocks.
		// x starts at the left edge of the CHANGED FILES panel — left of that is
		// the chat list, which is not what this block is about. Width runs to the
		// viewport edge so the diff is not clipped mid-line.
		// y starts BELOW the tab bar. At 150 the crop caught the active tab's
		// underline as a stray orange sliver along the top edge.
		clip: { x: 544, y: 172, width: 736, height: 452 },
		async prepare(page) {
			const file = page.getByText("src/render.ts").first();
			await file.waitFor({ timeout: 20_000 });
			await file.click();
			await page.waitForTimeout(1_500);
		},
	},
];

/**
 * Recorded clips.
 *
 * Same framing discipline as the stills — crop to ONE feature at close to 1:1 —
 * but these drive the UI, so they also change it. See the note at the top about
 * why they run last.
 *
 * `drive` returns the offset (in seconds, from the start of the recording) that
 * the trim should begin at, MEASURED rather than guessed: a hard-coded offset
 * drifts the moment the page takes a beat longer to settle, and the clip then
 * silently starts halfway through the thing it was meant to show.
 */
const CLIPS = [
	{
		id: "fork-rewind",
		block: "Fork it, or rewind it",
		// 1030 wide is chosen, not incidental. The two panes this clip needs — the
		// chat list (so the forked child appears nested under its parent) and the
		// transcript (so you see the rail it was forked from) — are a fixed 255px
		// and "the rest". At the 1280 the stills use, "the rest" is 737px and the
		// pair crops to 992, which would land at 0.7x in the page's ~700px media
		// column. At 1030 the same two panes crop to 742 and render at about 1:1.
		viewport: { width: 1030, height: 760 },
		// Slightly under what `drive` actually yields, so the trim never runs off
		// the end of the recording and leaves a frozen tail.
		seconds: 7.8,
		// x starts on the chat list's left edge — left of it is the project rail,
		// which block 2 is about. y starts below the tab bar. The bottom cuts the
		// transcript mid-message on purpose: the composer and its context meter are
		// another 180px down, and including them would make this the tallest item
		// in the stage and set the frame height for all seven other blocks.
		crop: { x: 288, y: 176, width: 742, height: 424 },
		/** Frame to lift the poster from, as a fraction of the trimmed clip. */
		posterAt: 0.28,
		async drive(page, mouse) {
			const anchorText = "emitColor";
			await page.goto(`${BASE}/projects/lumen-cli/chat/${chat("lumen-cli:star")}`, {
				waitUntil: "networkidle",
			});
			const msg = page.locator("div.group.relative").filter({ hasText: anchorText }).first();
			await msg.waitFor({ timeout: 20_000 });
			// Put the anchor about a third of the way down the crop, so the rail
			// (which floats ABOVE the bubble, on `-top-3`) is comfortably inside it.
			await msg.evaluate((el) => {
				const sc = el.closest(".overflow-y-auto");
				if (sc) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 250;
			});
			await page.waitForTimeout(900);

			// Park the pointer somewhere neutral before the clip's window opens, so
			// the first thing the viewer sees is a still frame rather than a cursor
			// already mid-flight.
			await mouse.move(690, 620);
			await page.waitForTimeout(600);
			const startedAt = Date.now();

			const box = await msg.boundingBox();
			await mouse.move(box.x + 220, box.y + 40, { steps: 34 });
			// The rail fades in on hover. Hold long enough to read it: "3h ago · 84K
			// · 8%" is the whole first half of the block's copy.
			await page.waitForTimeout(1_900);

			// Scoped to the hovered message, NOT picked by index off the page. Every
			// message has one of these buttons and the rail is `pointer-events-none`
			// until ITS message is hovered — so an nth() that lands on a different
			// message's button clicks straight through to the bubble underneath and
			// nothing happens, which is exactly how this failed the first time.
			const fork = msg.getByRole("button", { name: /Fork a new chat from here/i }).first();
			const fbox = await fork.boundingBox();
			// Travel to the icon in one move and pause on it: the rail is revealed by
			// `group-hover`, so the pointer must stay inside the message the whole
			// way or it vanishes mid-clip.
			await mouse.move(fbox.x + fbox.width / 2, fbox.y + fbox.height / 2, { steps: 26 });
			await page.waitForTimeout(900);
			await mouse.down();
			await page.waitForTimeout(120);
			await mouse.up();

			// The payoff, and the reason this beat is a clip rather than a still: a
			// new chat appears INDENTED under the one it came from, and the
			// transcript it opens on ends exactly where the fork was taken.
			await page.getByText(/^Fork of /).first().waitFor({ timeout: 15_000 });
			await page.waitForTimeout(3_200);
			return startedAt;
		},
	},
];

/**
 * A drawn pointer, injected into the page.
 *
 * Playwright's mouse moves the real input point but renders nothing, so a clip
 * of a hover-revealed control shows things appearing for no visible reason — the
 * rail this clip is about would just blink into existence. This draws an arrow
 * that follows the actual pointer and a ring on mousedown, so the cause is on
 * screen. It is the only thing in any of this media that is not the app's own
 * pixels, which is why it is drawn as a plain OS-style arrow rather than
 * anything that could be mistaken for Paddock's UI.
 */
const CURSOR_SCRIPT = `(() => {
	const add = () => {
		if (document.getElementById('cap-cursor')) return;
		const c = document.createElement('div');
		c.id = 'cap-cursor';
		c.style.cssText = 'position:fixed;left:-60px;top:-60px;width:22px;height:22px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))';
		c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 17 L7 13.2 L9.6 19 L12.4 17.7 L9.8 12.1 L15 12.1 Z" fill="#fff" stroke="rgba(0,0,0,.65)" stroke-width="1.1" stroke-linejoin="round"/></svg>';
		document.documentElement.appendChild(c);
		addEventListener('mousemove', (e) => {
			c.style.left = e.clientX + 'px';
			c.style.top = e.clientY + 'px';
		}, true);
		addEventListener('mousedown', (e) => {
			const r = document.createElement('div');
			r.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;width:0;height:0;border:2px solid rgba(255,255,255,.9);border-radius:50%;z-index:2147483646;pointer-events:none;transform:translate(-50%,-50%);transition:width .4s ease-out,height .4s ease-out,opacity .4s ease-out;opacity:1';
			document.documentElement.appendChild(r);
			requestAnimationFrame(() => {
				r.style.width = '38px';
				r.style.height = '38px';
				r.style.opacity = '0';
			});
			setTimeout(() => r.remove(), 500);
		}, true);
	};
	if (document.documentElement) add();
	else addEventListener('DOMContentLoaded', add);
})()`;

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

	// A shot may declare an explicit rectangle instead of framing from locators.
	if (shot.clip) {
		const file = path.join(OUT, `${shot.id}.png`);
		await page.screenshot({ path: file, clip: shot.clip });
		const { size } = fs.statSync(file);
		console.log(
			`[capture] ${shot.id.padEnd(22)} ${shot.clip.width}x${shot.clip.height} CSS  ` +
				`(${(size / 1024).toFixed(0)} KB)  — ${shot.block}`,
		);
		await context.close();
		continue;
	}

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

// ── clips ───────────────────────────────────────────────────────────────────
fs.mkdirSync(CLIP_OUT, { recursive: true });
const RAW = path.join("/data/tmp", "landing-clips-raw");

for (const clip of CLIPS) {
	if (ONLY && clip.id !== ONLY) continue;
	fs.rmSync(RAW, { recursive: true, force: true });
	fs.mkdirSync(RAW, { recursive: true });

	const context = await browser.newContext({
		viewport: clip.viewport,
		deviceScaleFactor: 2,
		colorScheme: "dark",
		// The one place motion is wanted rather than frozen: the whole point of
		// this beat is the rail fading in under the pointer.
		reducedMotion: "no-preference",
		// `size` is the FINAL frame, not the capture resolution. The page still
		// renders at deviceScaleFactor 2 and Playwright downsamples device pixels
		// into this frame, so the clip is supersampled exactly like the stills.
		// Setting it larger does not upscale — it pads with grey.
		recordVideo: { dir: RAW, size: clip.viewport },
	});
	// Recording begins with the CONTEXT, not with `drive`, so the trim offset is
	// measured from here.
	const t0 = Date.now();
	await context.addInitScript(CURSOR_SCRIPT);
	const page = await context.newPage();

	const startedAt = await clip.drive(page, page.mouse);
	const trimFrom = Math.max(0, (startedAt - t0) / 1000);

	await context.close(); // finalises the .webm

	const webm = fs
		.readdirSync(RAW)
		.map((f) => path.join(RAW, f))
		.filter((f) => f.endsWith(".webm"))
		.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
	if (!webm) throw new Error(`${clip.id}: playwright wrote no video`);

	const mp4 = path.join(CLIP_OUT, `${clip.id}.mp4`);
	const { x, y, width, height } = clip.crop;
	// The crop rectangle is in CSS pixels and needs no conversion: `recordVideo.size`
	// above is the OUTPUT frame size, so the .webm is already 1x — the 2x render
	// was downsampled into it on the way in, which is where the sharpness comes
	// from. Cropping in device pixels here would frame the wrong quadrant.
	execFileSync("ffmpeg", [
		"-y", "-hide_banner", "-loglevel", "error",
		"-ss", trimFrom.toFixed(3), "-t", String(clip.seconds),
		"-i", webm,
		"-vf", `crop=${width}:${height}:${x}:${y}`,
		// yuv420p + faststart: without the pixel format Safari refuses the file
		// outright, and without faststart the moov atom lands at the end and the
		// clip will not begin until the whole thing has downloaded.
		"-c:v", "libx264", "-crf", "22", "-preset", "slow",
		"-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
		mp4,
	]);

	const poster = path.join(CLIP_OUT, `${clip.id}-poster.jpg`);
	execFileSync("ffmpeg", [
		"-y", "-hide_banner", "-loglevel", "error",
		"-ss", String((clip.posterAt ?? 0.25) * clip.seconds), "-i", mp4,
		"-frames:v", "1", "-q:v", "3", poster,
	]);

	console.log(
		`[capture] ${clip.id.padEnd(22)} ${width}x${height} CSS  ` +
			`(${(fs.statSync(mp4).size / 1024).toFixed(0)} KB video)  — ${clip.block}`,
	);
}

await browser.close();
console.log(`\nWrote stills to ${OUT}`);
if (CLIPS.length) console.log(`Wrote clips to  ${CLIP_OUT}`);
