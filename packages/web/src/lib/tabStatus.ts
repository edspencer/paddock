import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Live status in the browser tab (#958 part 3): a coloured dot on the favicon,
 * so a tab says "working" or "something landed" without being looked at. The
 * title itself carries no status; it is only the page's name.
 *
 * | Page          | Running (orange dot)         | Unread (green dot)                        |
 * |---------------|------------------------------|-------------------------------------------|
 * | Chat page     | this chat's turn in flight   | this chat is unread while you're on it    |
 * |               |                              | in a background tab                       |
 * | Project pages | any chat in the project      | replies landed while the tab was hidden   |
 * | Root `/`      | anything on the instance     | same, instance-wide                       |
 *
 * Running wins the dot.
 *
 * Project/root unread is "NEW since you last looked at THIS tab", not the unread
 * backlog. Backlog never expires, so counting it would leave the root tab
 * permanently green on any real instance — noise, not signal. Only a
 * reply that landed after the tab was last visible counts: nothing counts while
 * the tab IS visible (the sidebar and fleet strip are right there), and a tab
 * loaded hidden starts its baseline at load. The sidebar and fleet-strip counts
 * are untouched — they still show the whole backlog.
 *
 * The data lives in two places, so the plumbing is a round trip through one
 * context, provided by `AppShell`:
 *  - the ROUTE knows what the tab is about (a {@link TabScope}) and, for a chat,
 *    whether its reply is unseen — it publishes that with {@link usePublishTabScope};
 *  - the SHELL knows the running set, the unread list and the tab's visibility
 *    baseline, so it resolves the scope into a {@link TabStatus} and draws the
 *    favicon from it.
 * A route that publishes nothing (Discover, Config, the grid) shows no status.
 * Outside an `AppShell` (component tests) the context is inert: idle, no-op.
 */

/** What the current tab is about. */
export type TabScope =
  | { kind: "chat"; sessionId: string; unread: boolean }
  | { kind: "workspace"; key: string }
  | { kind: "instance" };

/** What the tab should say. */
export interface TabStatus {
  running: boolean;
  /** Unread replies in scope. A chat page uses 0/1. */
  unread: number;
  /** The scope's kind. */
  kind: TabScope["kind"] | "none";
}

export const IDLE_TAB_STATUS: TabStatus = { running: false, unread: 0, kind: "none" };

/** A chat holding an unread reply, as the shell's badge derivation lists them. */
export interface TabFinished {
  /** Workspace key; the root's is `""`. */
  projectSlug: string;
  /** When its reply landed, epoch ms. */
  at: number;
}

export interface TabStatusInputs {
  /** sessionId → workspace key, every turn running right now. */
  active: ReadonlyMap<string, string>;
  /** Every chat with an unread reply (the sidebar's backlog). */
  finished: readonly TabFinished[];
  /**
   * When the tab was last visible (epoch ms), or null while it IS visible. Only
   * replies landed after this count toward a project/root unread dot.
   */
  hiddenSince: number | null;
}

/** Resolve a scope against the shell's live data. Pure. */
export function computeTabStatus(
  scope: TabScope | null,
  { active, finished, hiddenSince }: TabStatusInputs,
): TabStatus {
  if (!scope) return IDLE_TAB_STATUS;
  if (scope.kind === "chat") {
    const running = active.has(scope.sessionId);
    // A new turn in flight supersedes "finished while you were away".
    return { kind: "chat", running, unread: !running && scope.unread ? 1 : 0 };
  }
  // Compare keys with ===, never truthiness: the root workspace's key is "".
  const inScope = (key: string) => scope.kind === "instance" || key === scope.key;
  let running = false;
  for (const key of active.values()) if (inScope(key)) running = true;
  let unread = 0;
  if (hiddenSince !== null) {
    for (const f of finished) if (f.at > hiddenSince && inScope(f.projectSlug)) unread += 1;
  }
  return { kind: scope.kind, running, unread };
}

export type TabDot = "running" | "unread";

/** Which dot the favicon carries: running beats unread. */
export function tabStatusDot(s: TabStatus): TabDot | null {
  if (s.running) return "running";
  if (s.unread > 0) return "unread";
  return null;
}

/** Equality on what is rendered — the key a publisher compares to skip no-op updates. */
export function tabScopeKey(scope: TabScope | null): string {
  if (!scope) return "none";
  if (scope.kind === "chat") return `chat:${scope.sessionId}:${scope.unread ? 1 : 0}`;
  if (scope.kind === "workspace") return `ws:${scope.key}`;
  return "instance";
}

export interface TabStatusContextValue {
  status: TabStatus;
  /** Publish (or, with null, withdraw) the mounted route's scope. */
  setScope: (scope: TabScope | null) => void;
}

export const TabStatusContext = createContext<TabStatusContextValue>({
  status: IDLE_TAB_STATUS,
  setScope: () => {},
});

/**
 * Publish this route's scope for as long as it is mounted. Re-publishes only
 * when the scope's key changes; withdraws on unmount so the next route starts
 * idle.
 */
export function usePublishTabScope(scope: TabScope | null): void {
  const { setScope } = useContext(TabStatusContext);
  const key = tabScopeKey(scope);
  // The scope object is rebuilt every render; its key is what matters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => scope, [key]);
  useEffect(() => {
    setScope(stable);
  }, [stable, setScope]);
  useEffect(() => () => setScope(null), [setScope]);
}

/**
 * When this tab was last visible, or null while it is. Initialised to load time
 * for a tab loaded hidden; set to "now" each time it is hidden.
 */
export function useHiddenSince(): number | null {
  const [since, setSince] = useState<number | null>(() =>
    typeof document !== "undefined" && document.visibilityState === "hidden" ? Date.now() : null,
  );
  useEffect(() => {
    const sync = () =>
      setSince((prev) =>
        document.visibilityState === "hidden" ? (prev ?? Date.now()) : null,
      );
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return since;
}

/**
 * The shell's side: hold the published scope, resolve it against the live
 * running set + unread list and this tab's visibility baseline, and produce the
 * context value. The value's identity changes only when what it renders
 * changes, so a recompute that moves nothing in scope re-renders no consumer
 * and redraws no favicon.
 */
export function useTabStatusState(inputs: Omit<TabStatusInputs, "hiddenSince">): TabStatusContextValue {
  const [scope, setScopeState] = useState<TabScope | null>(null);
  const setScope = useCallback((next: TabScope | null) => {
    setScopeState((prev) => (tabScopeKey(prev) === tabScopeKey(next) ? prev : next));
  }, []);
  const hiddenSince = useHiddenSince();
  const computed = computeTabStatus(scope, { ...inputs, hiddenSince });
  const scopeKey = tabScopeKey(scope);
  const statusKey = `${scopeKey}|${computed.kind}|${computed.running ? 1 : 0}|${computed.unread}`;
  return useMemo(
    () => ({ status: computed, setScope }),
    // `computed` is fresh every render; `statusKey` is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusKey, setScope],
  );
}
