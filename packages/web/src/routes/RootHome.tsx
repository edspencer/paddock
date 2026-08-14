import { useInstanceEmpty } from "../lib/useInstanceEmpty";
import { ProjectView } from "./ProjectView";

/**
 * `/` — the instance's front door (#745, rebuilt in #865).
 *
 * It is the root workspace. Always, including on an instance with nothing in it
 * at all. This file used to branch: an empty instance rendered `DiscoverView`
 * INSTEAD of the workspace, on the theory that an empty Home *is* Discovery and
 * so there was deliberately nothing to dismiss.
 *
 * The instinct was right and the consequence was not. The takeover is only ever
 * correct when there is something to adopt, and by the time we know that we have
 * already replaced the page. On a machine with no Claude Code history — a fresh
 * install, a container, anyone whose first Claude Code this is — Discovery has
 * nothing to offer, its import footer and its "Get started" exit are both gated
 * on things that can never happen, and the result was a front door with no
 * button anywhere on it, under copy asserting the machine's history was "already
 * a project, or was filtered out".
 *
 * So the branch is gone. `HomePane` carries the first-run content as a SECTION
 * of the root's Home (see its `root` / `instanceEmpty` props), which means the
 * page always has the sidebar, the tab bar, a New chat button and the two
 * onboarding cards on it, whatever Discovery finds. The undecided state no
 * longer blanks the screen either — Home mounts immediately and holds back only
 * the one slot whose contents depend on the answer.
 *
 * Discovery stays reachable at `/discover`, unchanged.
 *
 * The emptiness question is still asked HERE rather than inside `ProjectView`,
 * even though Home is what consumes the answer. `/chat` and `/projects/:slug`
 * mount the same `ProjectView`, and asking there would buy an answer they never
 * read — a request per project visit for a fact about the instance. `/` is the
 * one route where it means anything, and this is `/`.
 */
export function RootHome() {
  const { empty, recheck } = useInstanceEmpty();
  return <ProjectView root instanceEmpty={empty} onInstanceRecheck={recheck} />;
}
