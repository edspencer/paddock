import type { ChatVerdict } from "./types";

/**
 * Apply a `chat:verdict` frame to a list of chat rows: the row for `sessionId`
 * (and, when given, `projectSlug` — Home's fleet-wide rows span projects) gets the
 * new verdict. Returns `rows` itself when no row matches, so a frame for a chat
 * this list does not show causes no re-render.
 */
export function withVerdict<T extends { sessionId: string; projectSlug?: string }>(
  rows: T[],
  sessionId: string,
  verdict: ChatVerdict,
  projectSlug?: string,
): T[] {
  const matches = (c: T) =>
    c.sessionId === sessionId && (projectSlug === undefined || c.projectSlug === projectSlug);
  if (!rows.some(matches)) return rows;
  return rows.map((c) => (matches(c) ? { ...c, verdict } : c));
}
