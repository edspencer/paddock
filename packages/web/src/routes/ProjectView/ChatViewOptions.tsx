import { SlidersIcon } from "../../components/icons";
import type { ChatViewPrefs } from "./useChatViewPrefs";

/**
 * The chat list's view-options control: a toolbar toggle plus the small panel it
 * opens. One option today (nested vs flat); built as a form so a second row can
 * be added without relayout.
 *
 * An INLINE panel, not a dropdown. A dropdown would need a portal, click-outside
 * dismissal, escape handling and focus return, all to end up less controllable
 * and harder to test — and it would close itself every time you changed
 * something. This just pushes the list down and stays where you left it, so its
 * open/closed state can be sticky like the options themselves.
 */
export function ChatViewOptionsButton({
  optionsOpen,
  toggleOptionsOpen,
}: Pick<ChatViewPrefs, "optionsOpen" | "toggleOptionsOpen">) {
  return (
    <button
      type="button"
      onClick={toggleOptionsOpen}
      aria-label="Chat list view options"
      aria-expanded={optionsOpen}
      aria-controls="chat-view-options"
      title="View options"
      className={`btn-subtle h-9 w-9 shrink-0 p-0 ${
        optionsOpen ? "bg-paddock-200 text-paddock-700 dark:bg-paddock-700 dark:text-paddock-100" : ""
      }`}
    >
      <SlidersIcon width={16} height={16} className="mx-auto" />
    </button>
  );
}

export function ChatViewOptionsPanel({
  nested,
  setNested,
  runningOnly,
}: Pick<ChatViewPrefs, "nested" | "setNested" | "runningOnly">) {
  return (
    <div
      id="chat-view-options"
      className="mx-3 mb-2 rounded-lg border border-paddock-200 bg-paddock-100/60 p-2 dark:border-paddock-800 dark:bg-paddock-800/40"
    >
      <div role="radiogroup" aria-label="Chat list layout">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-medium text-paddock-500 dark:text-paddock-400">
            Layout
          </span>
          {/* Running-only forces flat, so say so rather than letting the control
              sit there looking broken. The preference itself is untouched — turn
              the filter off and the user's nesting comes straight back. */}
          {runningOnly && (
            <span className="text-[10px] text-paddock-400">flat while filtered</span>
          )}
        </div>
        <div className="flex gap-1">
          {(
            [
              [true, "Nested", "Nest chats under the chat that created them"],
              [false, "Flat", "One flat list, newest first"],
            ] as const
          ).map(([value, label, title]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={nested === value}
              disabled={runningOnly}
              title={runningOnly ? "Running-only view is always flat" : title}
              onClick={() => setNested(value)}
              className={`flex-1 rounded-md px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                nested === value
                  ? "bg-white font-medium text-paddock-800 shadow-sm dark:bg-paddock-700 dark:text-paddock-100"
                  : "text-paddock-500 hover:bg-paddock-200/60 dark:text-paddock-400 dark:hover:bg-paddock-700/60"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
