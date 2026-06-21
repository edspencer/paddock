// Areas — a project's single, exclusive "home" (one level of grouping above the
// project, below the fleet). Distinct from `domain` tags, which are many and
// cross-cutting. Areas structure the landing page into collapsible sections.
//
// The canonical set is intentionally small and curated (Homelab / House / Side
// Projects). The server stores `group` as a free-form slug, so a project can
// carry an area not listed here — it renders in its own section, ordered after
// the canonical ones. An empty/absent group is "Unsorted".

export interface AreaDef {
  /** Stored slug (lowercase, kebab). */
  slug: string;
  /** Display label. */
  label: string;
  /** Short blurb shown under the section heading. */
  blurb?: string;
}

/** The canonical areas, in display order. */
export const AREAS: AreaDef[] = [
  { slug: "homelab", label: "Homelab", blurb: "Servers, networking, self-hosted services." },
  { slug: "house", label: "House", blurb: "Physical home systems — water, climate, power, garden." },
  { slug: "side-projects", label: "Side Projects", blurb: "Apps and ideas of your own." },
];

/** The slug used for projects with no area set. Always rendered last. */
export const UNSORTED_SLUG = "";

/** The synthetic "area" for one-off chats shown at the foot of the landing page. */
export const INBOX = { slug: "inbox", label: "Inbox", blurb: "One-off chats not yet tied to a project." };

const BY_SLUG = new Map(AREAS.map((a) => [a.slug, a]));

/** Human label for an area slug (falls back to a title-cased slug, or "Unsorted"). */
export function areaLabel(slug: string): string {
  if (!slug) return "Unsorted";
  const known = BY_SLUG.get(slug);
  if (known) return known.label;
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Blurb for an area slug, when one is defined. */
export function areaBlurb(slug: string): string | undefined {
  return BY_SLUG.get(slug)?.blurb;
}

/**
 * Given the set of area slugs actually present on the projects, return them in
 * display order: canonical areas first (in their defined order, only if present),
 * then any non-canonical slugs alphabetically, then Unsorted ("") last.
 */
export function orderAreaSlugs(present: Iterable<string>): string[] {
  const set = new Set(present);
  const ordered: string[] = [];
  for (const a of AREAS) {
    if (set.has(a.slug)) {
      ordered.push(a.slug);
      set.delete(a.slug);
    }
  }
  const hasUnsorted = set.delete(UNSORTED_SLUG);
  ordered.push(...[...set].sort());
  if (hasUnsorted) ordered.push(UNSORTED_SLUG);
  return ordered;
}
