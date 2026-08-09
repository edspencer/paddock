import { DiscoverView } from "../components/DiscoverView";

/**
 * `/discover` — Discovery as an ordinary page (#745).
 *
 * The whole screen lives in {@link DiscoverView}, which the empty instance's
 * Home renders too. This file exists so the code-split route has something to
 * import, and so the two mount points differ by exactly one prop rather than by
 * two copies of a table.
 */
export function DiscoverPage() {
  return <DiscoverView />;
}
