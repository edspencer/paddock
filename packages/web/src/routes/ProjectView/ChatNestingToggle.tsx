import { Tooltip } from "../../components/Tooltip";
import { ListIcon, TreeIcon } from "../../components/icons";
import type { ChatViewPrefs } from "./useChatViewPrefs";

/**
 * Toolbar toggle for the chat list's layout: nested tree or flat list.
 *
 * One button, one job. It shows the layout you will GET, matching the theme
 * toggle in AppShell (dark mode shows a sun labelled "Switch to light mode") —
 * the icon is the destination and the label is the action, so the two toolbar
 * toggles in this app never mean opposite things.
 *
 * The running-only filter forces flat, and this reports that by disabling
 * rather than by silently disagreeing with the list: a button offering "switch
 * to flat" while the list is ALREADY flat would be lying about the state. The
 * preference underneath is untouched, so turning the filter off restores it.
 */
export function ChatNestingToggle({
  nested,
  setNested,
  runningOnly,
}: Pick<ChatViewPrefs, "nested" | "setNested" | "runningOnly">) {
  const label = nested ? "Show chats as a flat list" : "Nest chats under the chat that created them";
  return (
    // Tooltip, not `title=` (#508 replaced the native ones). Note it wraps the
    // button rather than living inside it: a disabled button fires no pointer
    // events, and "why is this greyed out?" is exactly when the hint is needed.
    <Tooltip content={runningOnly ? "Running-only view is always flat" : label}>
      <button
        type="button"
        onClick={() => setNested(!nested)}
        disabled={runningOnly}
        aria-label={label}
        aria-pressed={nested}
        className="btn-subtle h-9 w-9 shrink-0 p-0 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {nested ? (
          <ListIcon width={16} height={16} className="mx-auto" />
        ) : (
          <TreeIcon width={16} height={16} className="mx-auto" />
        )}
      </button>
    </Tooltip>
  );
}
