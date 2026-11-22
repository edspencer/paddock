import type { Chat } from "../../lib/types";
import type { ChatNode } from "../../lib/chatTree";
import { Tooltip } from "../../components/Tooltip";
import { type ChatActionContext, chatActionItems } from "./chatActionItems";

/** The 24px icon button every action shares — the size of the sidebar's. */
const ICON_BUTTON = "flex h-6 w-6 items-center justify-center rounded-md transition";

/**
 * The open chat's actions, rendered beside the composer's input box
 * (ChatPane's `composerActions` slot). They used to be the sidebar row's hover
 * strip. Which actions apply, and what they say and do, is `chatActionItems`;
 * every handler is owned by ProjectView — this only renders buttons.
 */
export function ChatActions({
  chat,
  node,
  ctx,
}: {
  chat: Chat;
  /** See `chatActionItems`. */
  node?: ChatNode;
  ctx: ChatActionContext;
}) {
  // Always visible here, unlike the hover-revealed strip they came from.
  // `contents`: the buttons are laid out by ChatPane's slot, which decides
  // where they sit relative to the input box and how they wrap.
  return (
    <div role="group" aria-label="Chat actions" className="contents">
      {chatActionItems(chat, node, ctx).map((item) => (
        <Tooltip key={item.id} content={item.tooltip}>
          <button
            type="button"
            aria-label={item.ariaLabel}
            aria-pressed={item.pressed}
            onClick={item.onActivate}
            className={`${ICON_BUTTON} ${item.className}`}
          >
            {item.icon}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
