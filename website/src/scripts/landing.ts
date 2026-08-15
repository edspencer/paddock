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

function dotGrid() {
	const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-dot-grid]');
	if (!canvas || reduceMotion) return;

	const ctx = canvas.getContext('2d');
	if (!ctx) return;

	const SPACING = 26; // px between dots
	const REACH = 190; // px radius of the cursor's influence
	// The first pass used 0.07/0.5 and was invisible in a screenshot — the
	// resting field vanished against the ground and the cursor's flare read as a
	// compression artefact. These are the values that survive being looked at on
	// a normal monitor rather than a colour-managed one.
	const BASE_ALPHA = 0.14;
	const PEAK_ALPHA = 0.85;
	const BASE_R = 1.1;
	const PEAK_R = 2.8;

	let dpr = 1;
	let cols = 0;
	let rows = 0;
	// Pointer position in CSS px, parked far off-canvas so the grid starts calm
	// rather than with a bright patch at 0,0.
	let px = -9999;
	let py = -9999;
	let raf = 0;
	let running = false;

	function resize() {
		const rect = canvas!.getBoundingClientRect();
		dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas!.width = Math.floor(rect.width * dpr);
		canvas!.height = Math.floor(rect.height * dpr);
		cols = Math.ceil(rect.width / SPACING) + 1;
		rows = Math.ceil(rect.height / SPACING) + 1;
	}

	function draw(t: number) {
		const rect = canvas!.getBoundingClientRect();
		ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx!.clearRect(0, 0, rect.width, rect.height);

		for (let i = 0; i < cols; i++) {
			for (let j = 0; j < rows; j++) {
				const x = i * SPACING;
				const y = j * SPACING;

				// A slow diagonal wave, so the field breathes even with no cursor on
				// the page — on a phone or a laptop the reader never touches, a
				// completely static grid reads as a background image.
				const wave = 0.5 + 0.5 * Math.sin((x + y) * 0.012 + t * 0.0004);

				const dx = x - px;
				const dy = y - py;
				const dist = Math.hypot(dx, dy);
				// Smoothstep falloff — a linear ramp gives the cursor a visible hard
				// edge where its influence stops.
				const n = dist < REACH ? 1 - dist / REACH : 0;
				const near = n * n * (3 - 2 * n);

				const alpha = BASE_ALPHA * (0.55 + 0.45 * wave) + (PEAK_ALPHA - BASE_ALPHA) * near;
				const r = BASE_R + (PEAK_R - BASE_R) * near;

				// Dots warm towards the accent as the cursor approaches; the resting
				// field stays neutral so it never looks like a stain.
				ctx!.fillStyle =
					near > 0.02
						? `rgba(${222 - 28 * (1 - near)}, ${170 - 74 * (1 - near)}, ${140 - 80 * (1 - near)}, ${alpha})`
						: `rgba(226, 220, 212, ${alpha})`;

				ctx!.beginPath();
				ctx!.arc(x, y, r, 0, Math.PI * 2);
				ctx!.fill();
			}
		}

		raf = requestAnimationFrame(draw);
	}

	function start() {
		if (running) return;
		running = true;
		raf = requestAnimationFrame(draw);
	}

	function stop() {
		running = false;
		cancelAnimationFrame(raf);
	}

	window.addEventListener('pointermove', (e) => {
		const rect = canvas.getBoundingClientRect();
		px = e.clientX - rect.left;
		py = e.clientY - rect.top;
	});

	// Leaving the window should relax the grid, not freeze it mid-flare.
	window.addEventListener('pointerleave', () => {
		px = -9999;
		py = -9999;
	});

	window.addEventListener('resize', resize);

	// The hero scrolls away long before the page ends; without this the rAF loop
	// keeps painting an off-screen canvas for the entire rest of the document.
	new IntersectionObserver(
		([entry]) => (entry.isIntersecting ? start() : stop()),
		{ threshold: 0 },
	).observe(canvas);

	resize();
	start();
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
