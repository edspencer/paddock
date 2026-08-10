import { DiscoverView } from "../components/DiscoverView";
import { useInstanceEmpty } from "../lib/useInstanceEmpty";
import { ProjectView } from "./ProjectView";

/**
 * `/` — the instance's front door (#745).
 *
 * An EMPTY instance's Home *is* Discovery. That is the whole design: not a modal
 * over Home, not a banner on Home, but the page itself, so there is deliberately
 * nothing to dismiss and therefore no "don't ask again" flag to get wrong. The
 * same reasoning as #660's live count over a dismissed one — an empty home page
 * showing what it found is not interrupting anything.
 *
 * Once anything exists (see {@link useInstanceEmpty} for what "empty" means, and
 * why the root workspace is not a project but its chats do count) this is the
 * ordinary root Home, unchanged. Discovery stays reachable at `/discover`.
 *
 * The undecided state renders NOTHING rather than guessing. `ProjectView` is a
 * heavy mount that opens sockets and fetches a workspace; rendering it for a beat
 * and then replacing it with a completely different screen is worse than a blank
 * moment, and the flash would land squarely on the fresh install this is for.
 *
 * The choice is made once per mount and released only by `recheck` (#808), which
 * is what lets Discovery refresh the project list the moment its run ends —
 * populating the sidebar — without that refresh yanking its own success screen
 * off the page. See {@link useInstanceEmpty} for why the answer is latched.
 */
export function RootHome() {
  const { empty, recheck } = useInstanceEmpty();
  if (empty === null) return <div className="flex-1" aria-busy="true" />;
  if (empty) return <DiscoverView firstRun onLeave={recheck} />;
  return <ProjectView root />;
}
