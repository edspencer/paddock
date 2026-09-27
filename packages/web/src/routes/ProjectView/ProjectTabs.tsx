import type { ReactNode } from "react";
import type { GitProjectStatus } from "../../lib/types";
import { BoltIcon, WrenchIcon } from "../../components/icons";
import { TabButton } from "./TabButton";
import { PinnedTab } from "./PinnedTab";
import type { ProjectViewTab } from "./urls";

/**
 * The workspace tab strip — Home / Chat / Files / Changes / History / Settings /
 * Triggers, then any pinned-file sibling tabs. Lifted out of `ProjectView`
 * (#919); every tab is still URL-driven, the callbacks just navigate.
 */
export function ProjectTabs({
  view,
  filesTabActive,
  gitStatus,
  newRunCount,
  pinned,
  activePinnedFile,
  goHome,
  goChat,
  goFiles,
  goChanges,
  goHistory,
  goSettings,
  goTriggers,
  goToFilesPath,
  unpinTab,
}: {
  view: ProjectViewTab;
  filesTabActive: boolean;
  gitStatus: GitProjectStatus | null;
  newRunCount: number;
  pinned: string[];
  activePinnedFile: string | null;
  goHome: () => void;
  goChat: () => void;
  goFiles: () => void;
  goChanges: () => void;
  goHistory: () => void;
  goSettings: () => void;
  goTriggers: () => void;
  goToFilesPath: (path: string) => void;
  unpinTab: (file: string) => Promise<void> | void;
}): ReactNode {
  return (
    <>
    {/* On mobile the chat view hides the tab bar — the compact header
        breadcrumb (name → Home) is the way back to the tabbed hub, so the
        chat gets the full height. Tabs stay visible on Home/Files/Changes
        and on lg+ everywhere. */}
    {/* The tab bar is TWO elements on purpose (see TabButton). The outer
        one draws the 1px rule under the tabs; the inner one is the
        horizontal scroller. They cannot be the same element: `overflow-x:
        auto` promotes `overflow-y: visible` to `auto` (CSS Overflow §3),
        so the strip becomes a vertical scroll container too — and a
        scroll container's scrollable area is the union of its
        descendants' BORDER boxes, which negative margins do not shrink.
        The tabs' active underline has to overlap that rule by 1px, so
        with the rule on the scroller itself the overlap showed up as 1px
        of scrollable overflow and a spurious vertical scrollbar. Hanging
        the -1px off the scroller (whose parent is not a scroll container)
        instead of off each tab gives the identical geometry with none of
        the overflow. */}
    <div
      className={`border-b border-edge ${
        view === "chat" ? "hidden lg:block" : "block"
      }`}
    >
    {/* Tagged for the e2e specs: at the ROOT the workspace name is "Home"
        (#921), which is also a tab label, so `main` alone no longer names
        the tab strip's Home button unambiguously — the header breadcrumb
        carries the same text. */}
    <div
      data-testid="workspace-tabs"
      className="-mb-px flex items-center gap-1 overflow-x-auto px-4"
    >
      <TabButton active={view === "home"} onClick={goHome}>
        Home
      </TabButton>
      <TabButton active={view === "chat"} onClick={goChat}>
        Chat
      </TabButton>
      <TabButton active={filesTabActive} onClick={goFiles}>
        Files
      </TabButton>
      {/* The Changes tab appears ONLY when the projects dir is a git repo.
          It carries a subtle "N uncommitted" badge so pending work is
          visible without opening it. At the ROOT that status is the WHOLE
          backing repo, which is the point — the root is where you commit
          across the instance. */}
      {gitStatus && (
        <TabButton active={view === "changes"} onClick={goChanges}>
          <span className="inline-flex items-center gap-1.5">
            Changes
            {gitStatus.files.length > 0 && (
              <span
                title={`${gitStatus.files.length} uncommitted change${
                  gitStatus.files.length === 1 ? "" : "s"
                }`}
                className="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-warn-soft px-1 text-3xs font-semibold text-warn"
              >
                {gitStatus.files.length}
              </span>
            )}
          </span>
        </TabButton>
      )}
      {/* The History tab — the "while you were away" run view (#268). Its
          badge counts unattended (scheduled + spawned) runs that finished
          since the user last opened it, so unattended work is visible
          without opening the tab. */}
      <TabButton active={view === "history"} onClick={goHistory}>
        <span className="inline-flex items-center gap-1.5">
          History
          {newRunCount > 0 && (
            <span
              title={`${newRunCount} new unattended run${newRunCount === 1 ? "" : "s"} since your last visit`}
              className="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-accent-soft px-1 text-3xs font-semibold text-accent"
            >
              {newRunCount}
            </span>
          )}
        </span>
      </TabButton>
      {/* The workspace's own settings — its `project.yaml`. At the root
          this is `/settings`; the instance-wide config it used to sit
          above is its own screen at `/config`. */}
      <TabButton active={view === "settings"} onClick={goSettings}>
        <span className="inline-flex items-center gap-1.5">
          <WrenchIcon width={13} height={13} />
          Settings
        </span>
      </TabButton>
      {/* The Triggers tab (Epic T / T4): per-project triggers — an agent turn
          that fires on a schedule, a lifecycle event, or a webhook (reserved),
          with a precise type + capability picker. Folds in the former Hooks tab
          and the Settings→Schedules section. */}
      <TabButton active={view === "triggers"} onClick={goTriggers}>
        <span className="inline-flex items-center gap-1.5">
          <BoltIcon width={13} height={13} />
          Triggers
        </span>
      </TabButton>
      {/* Pinned file tabs (sibling tabs), order preserved by the server.
          Each links to /files/:name so the tab is deep-linkable. Pinning is
          driven FROM the Files tab, so these come with Phase 4 rather than
          Phase 5 — a Files tab that can pin, next to a tab bar that won't
          show the pin, would just be incoherent. */}
      {pinned.map((f) => (
        <PinnedTab
          key={f}
          file={f}
          active={activePinnedFile === f}
          onSelect={() => goToFilesPath(f)}
          onUnpin={() => void unpinTab(f)}
        />
      ))}
    </div>
    </div>
    </>
  );
}
