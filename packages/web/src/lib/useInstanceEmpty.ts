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
 */
export function useInstanceEmpty(): {
  empty: boolean | null;
  /** Re-ask. The import run creates projects, so Home has to re-evaluate. */
  recheck: () => void;
} {
  const { projects, loading } = useProjects();
  const [rootHasChats, setRootHasChats] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState(0);
  const recheck = useCallback(() => setNonce((n) => n + 1), []);
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

  const empty = loading
    ? null
    : projects.length > 0
      ? false
      : rootHasChats === null
        ? null
        : !rootHasChats;

  return { empty, recheck };
}
