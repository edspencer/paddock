// Deterministic, stable colors for domain tags.
//
// A tag's color must be a pure function of the tag STRING — never of which
// projects happen to exist — so a given tag (e.g. "garden") always renders the
// same hue across the cards, the sidebar, the project view, and the /tags/:tag
// filter chip. We hash the tag string (FNV-1a) to a palette index, which gives
// the "round-robin through the palette" look Ed asked for while staying 100%
// consistent regardless of the project set.
//
// Tailwind v3 PURGE NOTE: every class string below is written out in full and
// literally present in the source, so Tailwind's content scanner sees them.
// We never build a color class via interpolation (e.g. `bg-${hue}-100`), which
// the scanner cannot see and would purge. `tagColor()` only ever RETURNS one of
// these pre-declared, statically-visible objects.

export interface TagColor {
  /** Combined background + text + (light/dark) classes for a tag pill. */
  className: string;
  /** Soft accent classes for an active-filter chip (slightly stronger). */
  chipClassName: string;
}

// ~10 visually-distinct hues, each tuned to read well in BOTH light and dark
// mode (soft tinted background + readable text). Order is fixed; the hash maps
// into it, so adding/removing a hue would reshuffle colors — keep it stable.
const PALETTE: readonly TagColor[] = [
  {
    className:
      "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
    chipClassName:
      "bg-blue-100 text-blue-800 ring-1 ring-blue-300/60 dark:bg-blue-950/60 dark:text-blue-200 dark:ring-blue-800/60",
  },
  {
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
    chipClassName:
      "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300/60 dark:bg-emerald-950/60 dark:text-emerald-200 dark:ring-emerald-800/60",
  },
  {
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
    chipClassName:
      "bg-amber-100 text-amber-900 ring-1 ring-amber-300/60 dark:bg-amber-950/60 dark:text-amber-200 dark:ring-amber-800/60",
  },
  {
    className:
      "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300",
    chipClassName:
      "bg-violet-100 text-violet-800 ring-1 ring-violet-300/60 dark:bg-violet-950/60 dark:text-violet-200 dark:ring-violet-800/60",
  },
  {
    className:
      "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
    chipClassName:
      "bg-rose-100 text-rose-800 ring-1 ring-rose-300/60 dark:bg-rose-950/60 dark:text-rose-200 dark:ring-rose-800/60",
  },
  {
    className:
      "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-300",
    chipClassName:
      "bg-cyan-100 text-cyan-800 ring-1 ring-cyan-300/60 dark:bg-cyan-950/60 dark:text-cyan-200 dark:ring-cyan-800/60",
  },
  {
    className:
      "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
    chipClassName:
      "bg-orange-100 text-orange-800 ring-1 ring-orange-300/60 dark:bg-orange-950/60 dark:text-orange-200 dark:ring-orange-800/60",
  },
  {
    className:
      "bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300",
    chipClassName:
      "bg-teal-100 text-teal-800 ring-1 ring-teal-300/60 dark:bg-teal-950/60 dark:text-teal-200 dark:ring-teal-800/60",
  },
  {
    className:
      "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/50 dark:text-fuchsia-300",
    chipClassName:
      "bg-fuchsia-100 text-fuchsia-800 ring-1 ring-fuchsia-300/60 dark:bg-fuchsia-950/60 dark:text-fuchsia-200 dark:ring-fuchsia-800/60",
  },
  {
    className:
      "bg-lime-100 text-lime-800 dark:bg-lime-950/50 dark:text-lime-300",
    chipClassName:
      "bg-lime-100 text-lime-900 ring-1 ring-lime-300/60 dark:bg-lime-950/60 dark:text-lime-200 dark:ring-lime-800/60",
  },
];

/** FNV-1a hash → unsigned 32-bit. Stable across runs/builds. */
function hash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Map a tag to a palette entry deterministically and stably. Case-insensitive
 * (so "Garden" and "garden" share a color); trimmed for robustness.
 */
export function tagColor(tag: string): TagColor {
  const key = tag.trim().toLowerCase();
  return PALETTE[hash(key) % PALETTE.length];
}
