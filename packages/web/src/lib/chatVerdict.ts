import type { ChatVerdict } from "./types";

/**
 * Apply a `chat:verdict` frame to a list of chat rows: the row for `sessionId`
 * (and, when given, `projectSlug` — Home's fleet-wide rows span projects) gets the
 * new verdict. Returns `rows` itself when no row matches, so a frame for a chat
 * this list does not show causes no re-render.
 *
 * A frame that judged an older message than the row already shows (its
 * `turnCompletedAt` is before the row's `updatedAt`, both the chat's last-message
 * time) is ignored: it lost a race with a newer turn, and the server's list would
 * not carry it either (`currentVerdict` in the server's `chat-verdict.ts`).
 */
export function withVerdict<
  T extends { sessionId: string; projectSlug?: string; updatedAt?: string },
>(rows: T[], sessionId: string, verdict: ChatVerdict, projectSlug?: string): T[] {
  const judged = Date.parse(verdict.turnCompletedAt);
  const matches = (c: T) =>
    c.sessionId === sessionId &&
    (projectSlug === undefined || c.projectSlug === projectSlug) &&
    !(c.updatedAt !== undefined && judged < Date.parse(c.updatedAt));
  if (!rows.some(matches)) return rows;
  return rows.map((c) => (matches(c) ? { ...c, verdict } : c));
}
