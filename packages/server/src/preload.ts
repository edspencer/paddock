/**
 * The project-context "preload" wrapper (issue #1) — single-sourced here so the
 * WS layer that BUILDS it and the chat-list that STRIPS it for display can't
 * drift (issue #62).
 *
 * On the first turn of a new project chat with preload enabled, the server
 * prepends the project's OVERVIEW.md to the user's message as a delimited block:
 *
 *   <project-context>
 *   …OVERVIEW.md…
 *   </project-context>
 *
 *   My request:
 *   <the user's actual message>
 *
 * That block becomes the session's first user message, so Claude Code's derived
 * preview (and thus the sidebar name) is the overview text, not the request —
 * exactly the #62 complaint. {@link stripPreloadWrapper} recovers the request.
 */

export const PRELOAD_CONTEXT_OPEN = "<project-context>";
/** The literal boundary between the context block and the user's real request. */
export const PRELOAD_REQUEST_MARKER = "</project-context>\n\nMy request:\n";

/** Build the preload-wrapped prompt for a new project chat's first turn. */
export function wrapPreload(overview: string, message: string): string {
  return `${PRELOAD_CONTEXT_OPEN}\n${overview.trim()}\n${PRELOAD_REQUEST_MARKER}${message}`;
}

/**
 * Recover the user's real request from a (possibly) preload-wrapped message. If
 * `text` isn't the wrapper it's returned unchanged; if it is, everything after
 * the `My request:` marker is returned. Returns the input unchanged when the
 * marker is absent (e.g. the wrapper was truncated before it).
 */
export function stripPreloadWrapper(text: string): string {
  if (!text.startsWith(PRELOAD_CONTEXT_OPEN)) return text;
  const i = text.indexOf(PRELOAD_REQUEST_MARKER);
  return i === -1 ? text : text.slice(i + PRELOAD_REQUEST_MARKER.length);
}
