/**
 * Landing-page behaviour. One module, five small features, no framework.
 *
 *   1. dotGrid()        the mouse-reactive hero background
 *   2. revealOnScroll() fade-up as sections enter
 *   3. stickyNav()      frost the header once the hero is behind it
 *   4. scrollFeatures() the sticky screenshot that swaps as you read
 *   5. commandTabs()    quick-start / deploy tabs, and copy-to-clipboard
 *   6. videoFacade()    click-to-load the YouTube embed
 *
 * Every one of them is progressive: with JS off or broken, the page still
 * renders completely and every link still works. The reveal animation in
 * particular sets its own starting opacity from here rather than from CSS, so a
 * reader without JS gets the whole page instead of a blank one. (Load
 * deepseek.com/harness with JS disabled — or screenshot it before the observers
 * fire, as I did — and you get an almost entirely black document. That's the
 * failure mode being avoided.)
 */

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* -------------------------------------------------------------------------- */
/* 1. dot grid                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Draws ONLY the bright dots near the cursor. The resting grid is a tiled CSS
 * radial-gradient (see HeroBackdrop.astro) because it never changes and so has
 * no business being in a per-frame loop.
 *
 * The first version of this drew every dot on the page every frame and cost
 * 104% of a core, measured with scripts/measure-cpu.sh — on a page that was
 * otherwise idle. Three things were wrong with it, and all three are fixed here:
 *
 *   1. It painted the whole canvas. Now it paints a dirty rectangle around the
 *      cursor — about 15×15 dots instead of 55×35, roughly 9× less work.
 *   2. It ran forever. Now the loop stops as soon as the highlight has settled
 *      and nothing is moving, and restarts on the next pointermove. An idle
 *      page costs exactly nothing.
 *   3. It built two template strings per dot per frame — ~114,000 short-lived
 *      strings a second, all of which the GC then had to collect. Now fillStyle
 *      values come from a small precomputed table.
 *
 * The idle "breathing" wave is gone deliberately. It was the reason the old
 * version could never stop animating: a wave over every dot means every dot
 * changes every frame by definition. The resting CSS grid is static instead,
 * and the motion comes from the cursor — which is the part anyone notices.
 */
function dotGrid() {
	const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-dot-grid]');
	if (!canvas || reduceMotion) return;

	// Match the CSS media query that displays the canvas: below this width there
	// is no cursor to react to and the element is `display: none` anyway.
	const desktop = window.matchMedia('(min-width: 768px)');

	const ctx = canvas.getContext('2d', { alpha: true });
	if (!ctx) return;

	// The aurora rides the same loop rather than owning one. Two independent rAF
	// loops for one pointer position is two wake-ups per frame for no benefit.
	const aurora = document.querySelector<HTMLElement>('.aurora');
	const PARALLAX = 26; // px of travel at the extremes, before per-blob depth

	const SPACING = 26; // must match .dots background-size
	const REACH = 190; // px radius of the cursor's influence
	const PEAK_ALPHA = 0.85;
	const PEAK_R = 2.8;
	const PAD = 6; // dirty-rect slack, so antialiased edges are fully cleared

	// Precomputed fillStyle strings, 24 steps of nearness. Building these per dot
	// per frame was a measurable share of the old cost.
	const STEPS = 24;
	const STYLES: string[] = [];
	for (let i = 0; i < STEPS; i++) {
		const near = (i + 1) / STEPS;
		const a = PEAK_ALPHA * near;
		const r = Math.round(222 - 28 * (1 - near));
		const g = Math.round(170 - 74 * (1 - near));
		const b = Math.round(140 - 80 * (1 - near));
		STYLES.push(`rgba(${r},${g},${b},${a.toFixed(3)})`);
	}

	let dpr = 1;
	let w = 0;
	let h = 0;

	// Target = where the pointer is. Current = where the highlight has eased to.
	let tx = -9999;
	let ty = -9999;
	let cx = -9999;
	let cy = -9999;

	let raf = 0;
	let running = false;
	let onScreen = true;
	// The rectangle painted last frame, which is what must be cleared next.
	let dirty: [number, number, number, number] | null = null;

	function resize() {
		const rect = canvas!.getBoundingClientRect();
		dpr = Math.min(window.devicePixelRatio || 1, 2);
		w = rect.width;
		h = rect.height;
		canvas!.width = Math.floor(w * dpr);
		canvas!.height = Math.floor(h * dpr);
		ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
		dirty = null;
	}

	function draw() {
		ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
		if (dirty) ctx!.clearRect(dirty[0], dirty[1], dirty[2], dirty[3]);

		// Ease toward the pointer. Without this the highlight teleports and the
		// dirty rect has to cover both positions on fast moves.
		cx += (tx - cx) * 0.2;
		cy += (ty - cy) * 0.2;

		const settled = Math.abs(tx - cx) < 0.4 && Math.abs(ty - cy) < 0.4;
		if (settled) {
			cx = tx;
			cy = ty;
		}

		// Off-canvas target means the pointer has left: nothing to draw.
		const alive = cx > -1000;

		if (alive) {
			const x0 = Math.max(0, Math.floor((cx - REACH) / SPACING) * SPACING);
			const y0 = Math.max(0, Math.floor((cy - REACH) / SPACING) * SPACING);
			const x1 = Math.min(w, cx + REACH);
			const y1 = Math.min(h, cy + REACH);

			for (let x = x0; x <= x1; x += SPACING) {
				for (let y = y0; y <= y1; y += SPACING) {
					const dx = x - cx;
					const dy = y - cy;
					const d2 = dx * dx + dy * dy;
					if (d2 > REACH * REACH) continue; // cheaper than Math.hypot
					const n = 1 - Math.sqrt(d2) / REACH;
					const near = n * n * (3 - 2 * n); // smoothstep
					const step = (near * STEPS) | 0;
					if (step < 1) continue; // invisible; skip the draw entirely
					ctx!.fillStyle = STYLES[Math.min(step, STEPS - 1)];
					ctx!.beginPath();
					ctx!.arc(x, y, PEAK_R * near, 0, Math.PI * 2);
					ctx!.fill();
				}
			}

			dirty = [
				Math.max(0, cx - REACH - PAD),
				Math.max(0, cy - REACH - PAD),
				REACH * 2 + PAD * 2,
				REACH * 2 + PAD * 2,
			];
		} else {
			dirty = null;
		}

		// Aurora parallax, from the same eased position. Normalised to -1..1 about
		// the centre of the hero so the field shifts symmetrically.
		if (aurora && alive && w > 0) {
			const nx = (cx / w - 0.5) * 2;
			const ny = (cy / h - 0.5) * 2;
			aurora.style.setProperty('--mx', `${(nx * PARALLAX).toFixed(1)}px`);
			aurora.style.setProperty('--my', `${(ny * PARALLAX).toFixed(1)}px`);
		}

		// The whole point: stop when there is nothing left to animate. The next
		// pointermove starts it again.
		if (settled) {
			running = false;
			return;
		}
		raf = requestAnimationFrame(draw);
	}

	function start() {
		if (running || !onScreen || !desktop.matches) return;
		running = true;
		raf = requestAnimationFrame(draw);
	}

	function stop() {
		running = false;
		cancelAnimationFrame(raf);
	}

	window.addEventListener(
		'pointermove',
		(e) => {
			const rect = canvas.getBoundingClientRect();
			tx = e.clientX - rect.left;
			ty = e.clientY - rect.top;
			if (cx < -1000) {
				// First move, or re-entry: appear where the pointer is rather than
				// sliding in from the corner.
				cx = tx;
				cy = ty;
			}
			start();
		},
		{ passive: true },
	);

	window.addEventListener('pointerleave', () => {
		tx = -9999;
		ty = -9999;
		cx = -9999;
		cy = -9999;
		start(); // one final frame to clear the last highlight
	});

	window.addEventListener('resize', () => {
		resize();
		start();
	});

	// A backgrounded tab should not be animating anything.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) stop();
	});

	// The hero scrolls away long before the page ends.
	new IntersectionObserver(
		([entry]) => {
			onScreen = entry.isIntersecting;
			if (!onScreen) stop();
		},
		{ threshold: 0 },
	).observe(canvas);

	resize();
}

/* -------------------------------------------------------------------------- */
/* 2. reveal on scroll                                                        */
/* -------------------------------------------------------------------------- */

function revealOnScroll() {
	const targets = document.querySelectorAll<HTMLElement>('[data-reveal]');
	if (!targets.length) return;

	if (reduceMotion) {
		targets.forEach((el) => el.classList.add('reveal', 'is-in'));
		return;
	}

	// The hidden state is added HERE, not in the template, so that the page is
	// fully visible if this script never runs.
	targets.forEach((el) => el.classList.add('reveal'));

	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				e.target.classList.add('is-in');
				io.unobserve(e.target); // reveal once; re-animating on scroll-up is noise
			}
		},
		{ rootMargin: '0px 0px -12% 0px', threshold: 0.05 },
	);

	targets.forEach((el) => io.observe(el));
}

/* -------------------------------------------------------------------------- */
/* 3. sticky nav                                                              */
/* -------------------------------------------------------------------------- */

function stickyNav() {
	const nav = document.querySelector('.nav');
	if (!nav) return;
	const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 24);
	window.addEventListener('scroll', onScroll, { passive: true });
	onScroll();
}

/* -------------------------------------------------------------------------- */
/* 4. scroll-swap feature section                                             */
/* -------------------------------------------------------------------------- */

/**
 * The mechanic, which is much simpler than it looks on the reference page:
 * the left column is a stack of tall text blocks, the right column holds one
 * `position: sticky` media frame, and an observer decides which block is
 * "current". The frame cross-fades to the matching image; the other blocks dim.
 *
 * Deliberately NOT scroll-jacking. The page scrolls at its natural rate and
 * nothing is intercepted, so trackpads, keyboards, find-in-page and screen
 * readers all behave normally.
 */
function scrollFeatures() {
	const section = document.querySelector<HTMLElement>('[data-features]');
	if (!section) return;

	const blocks = [...section.querySelectorAll<HTMLElement>('[data-feature-block]')];
	const shots = [...section.querySelectorAll<HTMLElement>('[data-feature-shot]')];
	if (!blocks.length || !shots.length) return;

	let current = -1;

	function select(index: number) {
		if (index === current) return;
		current = index;
		blocks.forEach((b, i) => b.classList.toggle('is-current', i === index));
		shots.forEach((s, i) => s.classList.toggle('is-current', i === index));
	}

	// A band across the middle of the viewport: whichever block's centre is
	// nearest it wins. Cheaper and far steadier than per-element thresholds,
	// which flicker when two tall blocks are on screen at once.
	function pick() {
		const mid = window.innerHeight * 0.42;
		let best = 0;
		let bestDist = Infinity;
		blocks.forEach((b, i) => {
			const r = b.getBoundingClientRect();
			const d = Math.abs(r.top + r.height / 2 - mid);
			if (d < bestDist) {
				bestDist = d;
				best = i;
			}
		});
		select(best);
	}

	let ticking = false;
	window.addEventListener(
		'scroll',
		() => {
			if (ticking) return;
			ticking = true;
			requestAnimationFrame(() => {
				pick();
				ticking = false;
			});
		},
		{ passive: true },
	);
	window.addEventListener('resize', pick);

	// Clicking a dimmed block promotes it, matching the reference page's
	// `cursor-pointer` affordance.
	blocks.forEach((b, i) =>
		b.addEventListener('click', () => {
			select(i);
			b.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
		}),
	);

	pick();
}

/* -------------------------------------------------------------------------- */
/* 5. command tabs + copy                                                     */
/* -------------------------------------------------------------------------- */

function commandTabs() {
	for (const group of document.querySelectorAll<HTMLElement>('[data-tabs]')) {
		const tabs = [...group.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
		const panels = [...group.querySelectorAll<HTMLElement>('[role="tabpanel"]')];

		function activate(i: number) {
			tabs.forEach((t, n) => {
				t.setAttribute('aria-selected', String(n === i));
				t.tabIndex = n === i ? 0 : -1;
			});
			panels.forEach((p, n) => p.toggleAttribute('hidden', n !== i));
		}

		tabs.forEach((tab, i) => {
			tab.addEventListener('click', () => activate(i));
			// Arrow-key navigation is part of the tabs pattern, not a nicety.
			tab.addEventListener('keydown', (e) => {
				const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
				if (!dir) return;
				e.preventDefault();
				const next = (i + dir + tabs.length) % tabs.length;
				activate(next);
				tabs[next].focus();
			});
		});

		activate(0);
	}

	for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
		btn.addEventListener('click', async () => {
			const text = btn.getAttribute('data-copy') ?? '';
			try {
				await navigator.clipboard.writeText(text);
			} catch {
				// Clipboard access is refused on insecure origins and by some
				// privacy settings. Say so rather than showing a false "Copied!".
				btn.dataset.state = 'error';
				setTimeout(() => delete btn.dataset.state, 1800);
				return;
			}
			btn.dataset.state = 'ok';
			setTimeout(() => delete btn.dataset.state, 1800);
		});
	}
}

/* -------------------------------------------------------------------------- */
/* 6. video facade                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A poster plus a play button that swaps in the real iframe on click. The
 * point is not weight so much as privacy: embedding YouTube up front sets
 * cookies and pings Google for every visitor who never presses play. Loading it
 * on demand means only people who actually watch are exposed to that, and the
 * page's largest paint stops depending on a third party.
 */
function videoFacade() {
	for (const el of document.querySelectorAll<HTMLElement>('[data-video]')) {
		el.addEventListener('click', () => {
			const id = el.getAttribute('data-video');
			const title = el.getAttribute('data-video-title') ?? 'Video';
			const frame = document.createElement('iframe');
			frame.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
			frame.title = title;
			frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture';
			frame.allowFullscreen = true;
			frame.loading = 'lazy';
			el.replaceChildren(frame);
			el.classList.add('is-playing');
		});
	}
}

/* -------------------------------------------------------------------------- */

dotGrid();
revealOnScroll();
stickyNav();
scrollFeatures();
commandTabs();
videoFacade();
