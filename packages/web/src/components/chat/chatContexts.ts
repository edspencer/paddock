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
