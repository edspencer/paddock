// Generate the social-share (Open Graph / Twitter) image for the docs site.
//
// Starlight sets `twitter:card: summary_large_image` but ships no default image,
// so unfurls render empty. This produces a branded 1200×630 PNG at
// `public/og-image.png`, referenced as an absolute `og:image` in astro.config.mjs.
//
// Run: `node scripts/generate-og-image.mjs` (uses `sharp`, already a build dep).
// It's deterministic — re-run it if the wordmark, tagline, or brand colours change.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const outFile = fileURLToPath(new URL('../public/og-image.png', import.meta.url));

// Brand tokens (mirror astro theme-color + the logo's accent).
const BG = '#141210';
const ACCENT = '#c2603c';
const INK = '#faf7f4';
const INK_MUTED = '#c8beb4';
// DejaVu Sans / Liberation Sans are present on the build box (see fc-list); both
// render cleanly via sharp's SVG rasteriser. List a web-safe fallback chain.
const FONT = 'Liberation Sans, DejaVu Sans, Arial, sans-serif';

// The logo glyph (from src/assets/paddock-logo.svg), embedded as a scalable
// nested <svg> so it rasterises crisply at any size.
const logo = `
  <svg x="96" y="205" width="220" height="220" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="7" fill="${ACCENT}"/>
    <path d="M11 24.5c-3-2-4.2-5.4-4.2-9C6.8 10.9 10.4 7.5 16 7.5s9.2 3.4 9.2 8c0 3.6-1.2 7-4.2 9"
          stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"/>
    <circle cx="9.6" cy="22.6" r="1.35" fill="#fff"/>
    <circle cx="22.4" cy="22.6" r="1.35" fill="#fff"/>
    <circle cx="8.4" cy="16" r="1.25" fill="#fff"/>
    <circle cx="23.6" cy="16" r="1.25" fill="#fff"/>
  </svg>`;

const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="${BG}"/>
  <rect x="0" y="0" width="1200" height="8" fill="${ACCENT}"/>
  <rect x="0" y="622" width="1200" height="8" fill="${ACCENT}"/>
  ${logo}
  <g font-family="${FONT}">
    <text x="360" y="300" font-size="120" font-weight="700" fill="${INK}">Paddock</text>
    <text x="364" y="372" font-size="42" font-weight="400" fill="${INK_MUTED}">Your Claude Code agents,</text>
    <text x="364" y="426" font-size="42" font-weight="400" fill="${INK_MUTED}">hosted and organized by project.</text>
    <text x="364" y="500" font-size="30" font-weight="400" fill="${ACCENT}">paddock.edspencer.net</text>
  </g>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(outFile);
console.log(`Wrote ${path.relative(process.cwd(), outFile)} (1200×630)`);
