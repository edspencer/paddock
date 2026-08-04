/**
 * Mermaid bootstrap for the docs site.
 *
 * Loaded as a module from astro.config.mjs's `head`. It does three things that
 * the old one-line `mermaid.initialize({ theme: 'dark' })` did not:
 *
 *  1. Themes from Starlight instead of pinning dark. Starlight writes the
 *     RESOLVED theme to <html data-theme> (including when Auto follows a system
 *     change), so that attribute is the source of truth, and a MutationObserver
 *     re-renders on every change to it.
 *
 *  2. Tightens sequence-diagram spacing. A sequenceDiagram's width is
 *     actorCount x width + gaps; the defaults (150/50) put the one on
 *     /architecture/overview/ at 1557px inside a ~658px column. Unlike a wide
 *     flowchart, there is no direction knob to fix it.
 *
 *  3. Stops diagrams being scaled into illegibility. Mermaid emits
 *     `width: 100%; max-width: <natural>px`, so anything wider than the column
 *     silently shrinks with no floor -- that page's first diagram was 2915px in
 *     a 658px column, i.e. 4.4x down, rendering 16px labels at ~3.6px.
 *
 * On (3): the rule is "shrink a little, scroll a lot". A diagram within
 * MIN_SCALE of fitting is allowed to shrink (imperceptible, and much nicer than
 * a scrollbar for a 30px overshoot); anything worse renders at natural size and
 * the container scrolls. CSS cannot express this on its own -- an SVG carrying
 * only a viewBox resolves `width: auto` to 100% of its container, so the pixel
 * value has to be read off the viewBox here.
 */
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

/** Smallest downscale we accept before preferring a scrollbar. 16px -> 13.6px. */
const MIN_SCALE = 0.85;

const nodes = [...document.querySelectorAll('pre.mermaid')];

if (nodes.length) {
	// Mermaid REPLACES each <pre>'s text with the rendered SVG and marks it
	// data-processed, so stash the source first or a re-render has nothing to draw.
	for (const node of nodes) node.dataset.src = node.textContent;

	/** Decide, per diagram, between fitting and scrolling. Also runs on resize. */
	const fit = () => {
		for (const node of nodes) {
			const svg = node.querySelector('svg');
			const box = svg?.viewBox?.baseVal;
			if (!box?.width) continue;

			const style = getComputedStyle(node);
			const available =
				node.clientWidth -
				parseFloat(style.paddingLeft || '0') -
				parseFloat(style.paddingRight || '0');

			if (available > 0 && box.width > available / MIN_SCALE) {
				svg.style.width = `${box.width}px`; // natural size; the <pre> scrolls
				svg.style.maxWidth = 'none';
			} else {
				svg.style.width = '100%'; // shrink to fit, but never past MIN_SCALE
				svg.style.maxWidth = `${box.width}px`; // and never stretch past natural
			}
		}
	};

	let drawn;
	const draw = async () => {
		const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
		if (theme === drawn) return;
		drawn = theme;

		for (const node of nodes) {
			node.textContent = node.dataset.src;
			node.removeAttribute('data-processed');
		}

		mermaid.initialize({
			startOnLoad: false,
			theme,
			sequence: { actorMargin: 36, width: 120, boxMargin: 8 },
		});
		await mermaid.run({ nodes });
		fit();
	};

	await draw();

	new MutationObserver(draw).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['data-theme'],
	});

	let resizeTimer;
	addEventListener('resize', () => {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(fit, 150);
	});
}
