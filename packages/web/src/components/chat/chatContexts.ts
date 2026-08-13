import { createContext } from "react";
import type { HistoryMessage } from "../../lib/types";

/**
 * Fetches a sub-agent's nested steps by its parent tool_use id (issue #37).
 * Provided per-chat (bound to slug + session); consumed by ToolBlock so every
 * depth of nesting can lazy-load through the same call. Null outside a chat.
 */
export const SubagentFetchContext = createContext<
  ((toolUseId: string) => Promise<HistoryMessage[]>) | null
>(null);

/**
 * Whether this chat currently has a live turn in flight (issue #429). Threaded to
 * the tool cards so a sub-agent card can show a running/spinner state and poll its
 * (growing) nested-step transcript WHILE the sub-agent works — including a
 * background sub-agent whose launching `Task` tool_call already completed (the
 * launch-ack) but whose own run continues on the still-active session. Flips false
 * when the turn (or the trailing background stream) ends, settling the card.
 */
export const SubagentLiveContext = createContext<boolean>(false);

/**
 * Live per-sub-agent activity (steps so far + the latest one), keyed by the
 * launching tool_use id, polled ONCE per sub-agent by the chat and shared with
 * both the running-sub-agents bar and the cards. A card reads its steps from here
 * when present, so expanding one costs no extra request; it falls back to its own
 * lazy fetch for a FINISHED sub-agent (history), which nothing is polling.
 */
export const SubagentActivityContext = createContext<Map<
  string,
  import("./useSubagentActivity").SubagentActivity
> | null>(null);

/**
 * Reveal-a-sub-agent wiring: the running-sub-agents bar asks the transcript to
 * bring one into view, and the matching card responds by expanding, scrolling
 * itself into view, and flashing a highlight so the eye lands on it.
 *
 * `focused` is a REQUEST token, not persistent selection state: it carries a
 * `nonce` so that re-tapping the SAME sub-agent re-triggers the flash (a plain id
 * would be an unchanged value the card could not distinguish from a re-render).
 */
export interface SubagentFocusValue {
  focused: { toolUseId: string; nonce: number } | null;
  focus: (toolUseId: string) => void;
}
export const SubagentFocusContext = createContext<SubagentFocusValue | null>(null);

/**
 * Builds a raw-file URL for an image `Read` rendered inline (issue #239). Bound to
 * the project slug; null when there is no servable project-file endpoint, so
 * ToolBlock falls back to the generic block there.
 */
export const ToolImageUrlContext = createContext<((relPath: string) => string) | null>(null);

/**
 * Keeper-chat recovery affordance wiring (issue #301, Layer 2), provided per-chat
 * and consumed by the `notification` turn renderer so a KILLED/STOPPED background
 * task can offer a one-click "Continue". `enabled` is the resolved
 * `recovery.surfaceKilledTask` (project override else instance default); `onContinue`
 * re-drives the hung keeper via the WS `chat:continue` action; `busy` disables the
 * button while a turn is already streaming (or the session id isn't known yet).
 * Null when there is no keeper session to recover.
 */
export interface RecoveryContextValue {
  enabled: boolean;
  busy: boolean;
  onContinue: () => void;
}
export const RecoveryContext = createContext<RecoveryContextValue | null>(null);

/**
 * Per-message fork/revert affordances (issue #451), provided per-chat and
 * consumed by the transcript's hover rail. `onFork`/`onRevert` receive the
 * anchor message's transcript `uuid`; `contextLimit` is the running model's
 * context window (for the hover fill %). Null outside a resumable chat (e.g. a
 * brand-new chat with no session id yet).
 */
export interface TurnActionsValue {
  onFork: (uuid: string) => void;
  onRevert: (uuid: string) => void;
  contextLimit?: number;
  /**
   * Absolute deep link to one message — the href behind the hover rail's
   * time/context pill. Built by the route (which owns URL shape) rather than
   * here, exactly like `onFork`/`onRevert`, so the root workspace's flat URLs
   * and a project's `/projects/:slug` URLs share one implementation.
   */
  linkTo: (uuid: string) => string;
  /**
   * A request to bring one message into view, or null. Carries a `nonce` for the
   * same reason {@link SubagentFocusValue} does: re-following the SAME link must
   * replay the flash, and a bare uuid is an unchanged value the row could not
   * distinguish from a re-render.
   */
  focused: { uuid: string; nonce: number } | null;
}
export const TurnActionsContext = createContext<TurnActionsValue | null>(null);
