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
 * Builds a raw-file URL for an image `Read` rendered inline (issue #239). Bound to
 * the project slug; null for a scratch chat (no servable project-file endpoint), so
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
 * Null for a scratch chat (no keeper session to recover).
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
 * context window (for the hover fill %). Null outside a resumable project chat
 * (a scratch chat, or a brand-new chat with no session id yet).
 */
export interface TurnActionsValue {
  onFork: (uuid: string) => void;
  onRevert: (uuid: string) => void;
  contextLimit?: number;
}
export const TurnActionsContext = createContext<TurnActionsValue | null>(null);
