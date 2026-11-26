// Ordering for the left nav's project list. Projects are grouped by area, and
// the areas keep their fixed order (`orderAreaSlugs`); the sort mode only orders
// the projects WITHIN each area:
//
//  - `recent` (the default): by the most recent reply in any of the project's
//    chats — the newest `lastTurnCompletedAt` in its `chatTurns` — falling back
//    to the project's `updated` date when it has none (`chatTurns` comes from
//    job records and leaves out archived chats; session-mode chats may have
//    none). Name breaks ties.
//  - `created`: by `project.yaml`'s `started` date, newest first; name breaks
//    ties, and orders projects whose date does not parse.
//  - `manual`: the user's drag order for that area. A project the order does not
//    name yet — a new project, or one just moved in from another area — goes at
//    the top, ordered as `recent`, until it is placed.

import { orderAreaSlugs } from "./areas";
import type { ListOrder, Project } from "./types";

/** When any of the project's chats last got a reply, as epoch ms (0 if never). */
export function projectReplyAt(p: Project): number {
  let max = 0;
  for (const t of p.chatTurns ?? []) {
    const at = Date.parse(t.lastTurnCompletedAt);
    if (Number.isFinite(at) && at > max) max = at;
  }
  return max || Date.parse(p.updated) || 0;
}

/** When the project was started, as epoch ms (0 if the date does not parse). */
export function projectStartedAt(p: Project): number {
  return Date.parse(p.started) || 0;
}

const byName = (a: Project, b: Project) => a.name.localeCompare(b.name);
const byRecent = (a: Project, b: Project) => projectReplyAt(b) - projectReplyAt(a) || byName(a, b);

/** One area's projects, ordered by `order` (see the module comment). */
export function orderProjects(
  projects: readonly Project[],
  area: string,
  order: ListOrder,
): Project[] {
  const out = [...projects];
  if (order.mode === "manual") {
    const rank = new Map((order.orders[area] ?? []).map((slug, i) => [slug, i]));
    return out.sort(
      (a, b) => (rank.get(a.slug) ?? -1) - (rank.get(b.slug) ?? -1) || byRecent(a, b),
    );
  }
  if (order.mode === "created") {
    return out.sort((a, b) => projectStartedAt(b) - projectStartedAt(a) || byName(a, b));
  }
  return out.sort(byRecent);
}

/** The project list grouped by area — areas in their fixed order, each one sorted. */
export function projectSections(
  projects: readonly Project[],
  order: ListOrder,
): [string, Project[]][] {
  const map = new Map<string, Project[]>();
  for (const p of projects) {
    const g = p.group ?? "";
    const bucket = map.get(g);
    if (bucket) bucket.push(p);
    else map.set(g, [p]);
  }
  return orderAreaSlugs(map.keys()).map((slug) => [
    slug,
    orderProjects(map.get(slug) ?? [], slug, order),
  ]);
}

/** Each area's CURRENT order, for seeding Manual so nothing moves at the switch. */
export function currentProjectOrders(
  sections: ReadonlyArray<readonly [string, readonly Project[]]>,
): Record<string, string[]> {
  return Object.fromEntries(sections.map(([area, ps]) => [area, ps.map((p) => p.slug)]));
}
