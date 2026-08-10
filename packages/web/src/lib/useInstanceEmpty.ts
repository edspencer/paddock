import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useProjects } from "./projects-context";
import { ROOT_KEY } from "../routes/ProjectView/urls";

/**
 * Is this instance still EMPTY? (#745)
 *
 * > Empty = zero non-root projects AND the root workspace has zero chats.
 * > Not empty = the root has ≥1 chat, OR ≥1 non-root project exists.
 *
 * The root workspace deliberately does not count as a project. It always exists
 * — it is the instance's own directory — so counting it would mean no instance
 * is ever empty and the Discover empty state would be unreachable. Its CHATS do
 * count, because someone who has started a conversation here has used the thing,
 * and replacing their front door with an import screen would be rude.
 *
 * ## Three states, not two
 *
 * `null` is "not known yet", and it is not the same as `false`. Home mounts on
 * this, so collapsing the unknown into "not empty" renders the ordinary project
 * home for a beat and then swaps it for a completely different screen — the
 * flash being worst precisely on the fresh install this exists for.
 *
 * ## Why the chat fetch is conditional
 *
 * Having any project at all settles it, and that is the overwhelmingly common
 * case, so the extra request is issued only by an instance with no projects. A
 * populated instance pays nothing for this hook beyond a render.
 *
 * ## The answer is LATCHED, and {@link recheck} is how it is released (#808)
 *
 * The instance's emptiness is live data — but Home's *front door* must not be.
 * Discovery is rendered instead of Home while the instance is empty, and
 * importing is precisely the act that makes it non-empty, so an unlatched answer
 * means the import run destroys the screen reporting it: the success headline
 * and every per-row outcome vanish mid-read, replaced by the root workspace.
 * That is why the refresh used to be deferred all the way to "Get started", and
 * deferring it is what left the sidebar stale until a manual browser reload.
 *
 * So the question is asked once per mount and the answer held until someone asks
 * again. `recheck` is that ask, and "Get started" is the only caller — the user
 * saying they have finished reading. Latching only pins the answer, never the
 * data: `projects` stays live underneath, which is the whole point (the sidebar
 * populates the moment the run ends, while this screen stays put).
 */
export function useInstanceEmpty(): {
  empty: boolean | null;
  /** Re-ask. The import run creates projects, so Home has to re-evaluate. */
  recheck: () => void;
} {
  const { projects, loading } = useProjects();
  const [rootHasChats, setRootHasChats] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState(0);
  /**
   * Bumping the nonce is not enough on its own: it releases the latch below in
   * the SAME render that still holds the pre-recheck `rootHasChats`, which would
   * re-pin the very answer we are trying to discard and never move again. The
   * effect clears it too, but a frame later — so clear it here, where the two
   * halves of "forget what you knew" cannot come apart.
   */
  const recheck = useCallback(() => {
    setRootHasChats(null);
    setNonce((n) => n + 1);
  }, []);
  const noProjects = !loading && projects.length === 0;

  useEffect(() => {
    if (!noProjects) return;
    let live = true;
    setRootHasChats(null);
    api
      .listProjectChats(ROOT_KEY)
      .then((chats) => {
        if (live) setRootHasChats(chats.length > 0);
      })
      // An unreadable root is not an empty one. Failing CLOSED here keeps the
      // ordinary home on screen rather than offering to import over the top of a
      // workspace we could not read.
      .catch(() => {
        if (live) setRootHasChats(true);
      });
    return () => {
      live = false;
    };
  }, [noProjects, nonce]);

  const answer = loading
    ? null
    : projects.length > 0
      ? false
      : rootHasChats === null
        ? null
        : !rootHasChats;

  /**
   * The latch: the first non-null answer of each generation, kept.
   *
   * Adjusted during render rather than in an effect, deliberately. An effect
   * lands a frame late, and this hook's contract is that the undecided state is
   * `null` — a one-frame `false` before the effect catches up is exactly the
   * flash the tri-state exists to prevent, on exactly the fresh install it exists
   * for. React re-runs the component immediately on a set-during-render, so the
   * committed render is the latched one.
   */
  const [latched, setLatched] = useState<{ gen: number; value: boolean } | null>(null);
  if (answer !== null && latched?.gen !== nonce) setLatched({ gen: nonce, value: answer });
  const empty = latched?.gen === nonce ? latched.value : null;

  return { empty, recheck };
}
