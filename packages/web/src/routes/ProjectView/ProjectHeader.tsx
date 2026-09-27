import type { ReactNode } from "react";
import { ChatIcon, MenuIcon, PlusIcon } from "../../components/icons";

/**
 * The workspace header (#919): the project name and, on desktop, the tab strip —
 * one row, nothing else.
 *
 * It used to be two bands: a header carrying the name, a status pill, domain
 * tags, Overview / Repo / Linked badges, an "updated Nw ago" stamp, the summary
 * and a `⋯` menu — then the tab strip as a second full-width row under it. The
 * badges were low-value in the most valuable row on the screen, the `⋯` menu's
 * "Edit details" only switched to the Settings tab sitting right below it, and
 * its "Delete project" now lives in Settings' danger zone (#923). So the badges
 * and the menu are gone, the summary moved to the Home tab, and the tabs move up
 * into the space they left — reclaiming a whole band of vertical space.
 *
 * **Desktop** (`tabs` supplied): the header's own bottom border IS the tab
 * rule, so the header carries no vertical padding and the tab scroller's `-mb-px`
 * lands each tab's active underline on it — the same geometry `ProjectTabs`
 * gets from its own rule on mobile (see the note there and in `TabButton`).
 *
 * **Mobile** (`tabs` omitted): a compact single row that also HOSTS the global
 * nav hamburger (#372) — the shell drops its separate brand row on project
 * routes so the two collapse into one. The tab strip stays a second row inside
 * the main column there: the row is already full, and the strip alone is wider
 * than the viewport. `pt-safe` clears the status bar/notch now that the shell's
 * bar is gone.
 */
export function ProjectHeader({
  name,
  onHome,
  openNav,
  onShowChats,
  chatCount,
  onNewChat,
  tabs,
}: {
  name: string;
  /** The name doubles as a breadcrumb up to the Home tab. */
  onHome: () => void;
  openNav: () => void;
  onShowChats: () => void;
  chatCount: number;
  onNewChat: () => void;
  /** The tab strip, when it belongs in the header row (desktop). */
  tabs?: ReactNode;
}) {
  return (
    <header className={`pt-safe border-b border-edge px-3 sm:px-6 ${tabs ? "" : "pb-2.5"}`}>
      <div className={`flex items-center ${tabs ? "gap-6" : "gap-2"}`}>
        {/* Global project-nav drawer — inline on mobile only (the shell's own
            hamburger row is suppressed on project routes). */}
        <button
          type="button"
          onClick={openNav}
          className="btn-subtle -ml-1 shrink-0 px-2 py-1.5 lg:hidden"
          aria-label="Open menu"
        >
          <MenuIcon width={20} height={20} />
        </button>
        <button
          type="button"
          onClick={onShowChats}
          className="btn-subtle shrink-0 gap-1.5 px-2 py-1.5 lg:-ml-2 lg:hidden"
          aria-label="Show chats"
        >
          <ChatIcon width={16} height={16} />
          <span className="hidden sm:inline">Chats</span>
          {chatCount > 0 && <span className="text-2xs text-fg-subtle">{chatCount}</span>}
        </button>
        {/* Capped on desktop so a long name can't squeeze the tabs off the row;
            the tabs are what you came to the header for. */}
        <h1 className="min-w-0 text-lg font-semibold tracking-tight lg:max-w-xs lg:shrink-0 lg:text-xl xl:max-w-sm">
          <button
            type="button"
            onClick={onHome}
            // The name leads because the cap above can truncate it — this is
            // the only place the rest of a long name can be read.
            title={`${name} — project home`}
            className="block max-w-full truncate rounded transition-colors hover:text-accent"
          >
            {name}
          </button>
        </h1>
        {tabs}
        {/* Mobile-only shortcut to start a new chat (desktop has it in the
            session-list column). */}
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
          className="btn-subtle ml-auto shrink-0 px-2 py-1.5 lg:hidden"
        >
          <PlusIcon width={16} height={16} />
        </button>
      </div>
    </header>
  );
}
