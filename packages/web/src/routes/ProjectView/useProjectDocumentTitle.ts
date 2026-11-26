import type { Chat, Project } from "../../lib/types";
import { useProjects } from "../../lib/projects-context";
import { useDocumentTitle, type TitlePart } from "../../lib/documentTitle";
import { usePublishTabScope, type TabScope } from "../../lib/tabStatus";
import type { ProjectViewTab } from "./urls";

/**
 * The document title for every route `ProjectView` serves (#958):
 *
 *   home      `hushpod`
 *   chat      `Fix the leaking tap · hushpod` (a new, unsent chat: `New chat · hushpod`)
 *   files     `feed.ts · Files · hushpod` (bare `Files · hushpod` on the list)
 *   changes   `feed.ts · Changes · hushpod`
 *   other     `History · hushpod`, `Settings · hushpod`, `Triggers · hushpod`
 *
 * — each followed by ` — <brand>` (see `formatDocumentTitle`). The ROOT
 * workspace's name is always omitted — the brand already names the instance, and
 * since #921 the root defaults to "Home", which would read `Home — Paddock`. So
 * `/` is just the brand, `/chat/:id` is `Fix the leaking tap — Paddock`, `/files`
 * is `Files — Paddock`. A PROJECT always keeps its name, even one named like the
 * brand (`X · paddock — Paddock`), so its chats never read as root chats.
 */
export interface ProjectTitleInput {
  view: ProjectViewTab;
  /** Is this the ROOT workspace? Its name never appears in the title. */
  root: boolean;
  /**
   * The workspace's display name, best available: the loaded project's name,
   * else the sidebar's cached copy, else (for a project) its slug. Never
   * empty for a project; may be empty for the root before anything has loaded.
   */
  workspaceName: string;
  /** The open chat's session id; null on a fresh "new chat". */
  activeSession: string | null;
  /**
   * The open chat's DTO if known — the same row the sidebar labels it with, so
   * the tab and the sidebar can never disagree about a chat's name.
   */
  activeChat: Chat | null;
  /** A just-started chat that has an id but no list row yet. */
  pendingChat: string | null;
  /** Whether the workspace detail (and so its chat list) has loaded. */
  loaded: boolean;
  /** The files-tab subpath ("" = the list). */
  filesSubpath: string;
  /** The changes-tab file, if one is deep-linked. */
  changeFile?: string;
}

const TAB_LABEL: Record<Exclude<ProjectViewTab, "home" | "chat">, string> = {
  files: "Files",
  changes: "Changes",
  history: "History",
  settings: "Settings",
  triggers: "Triggers",
};

function basename(path: string | undefined): string {
  if (!path) return "";
  const segs = path.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? "";
}

/** The chat's segment of the title — null while it can't be known yet. */
function chatPart(input: ProjectTitleInput): TitlePart {
  const { activeSession, activeChat, pendingChat, loaded } = input;
  if (activeSession === null) return "New chat";
  // A blank name (never expected, but the field is free text) still says "Chat"
  // rather than collapsing the title to just the workspace.
  if (activeChat) return activeChat.name.trim() ? activeChat.name : "Chat";
  if (pendingChat === activeSession) return "New chat";
  // Still loading: show the workspace alone rather than a guess.
  if (!loaded) return null;
  // Loaded, and the id is in no list (a stale link, a deleted chat).
  return "Chat";
}

export function projectTitleParts(input: ProjectTitleInput): TitlePart[] {
  const { view, root } = input;
  const workspaceName = root ? "" : input.workspaceName;
  switch (view) {
    case "home":
      return [workspaceName];
    case "chat":
      return [chatPart(input), workspaceName];
    case "files":
      return [basename(input.filesSubpath), TAB_LABEL.files, workspaceName];
    case "changes":
      return [basename(input.changeFile), TAB_LABEL.changes, workspaceName];
    default:
      return [TAB_LABEL[view], workspaceName];
  }
}

/** What `ProjectView` hands over — raw state; the resolving happens here. */
export interface ProjectDocumentTitleState
  extends Omit<ProjectTitleInput, "workspaceName" | "activeChat" | "loaded"> {
  slug: string;
  project: Project | null;
  chats: readonly Chat[];
  /** The #154 last-seen copy of the open chat, for when it drops out of `chats`. */
  lastActiveChat: Chat | null;
  /**
   * The derived unread set (`useUnreadChats`). The open chat is only ever in it
   * while its mark-seen is deferred because the tab is hidden — exactly the
   * "finished while you were away" the chat page's `✓ ` reports.
   */
  unread?: ReadonlySet<string>;
}

/**
 * What this tab's live status is about (#958 part 3): the open chat on a chat
 * page; the whole instance on root Home; otherwise the workspace — a project's
 * slug, or the root's `""` for the root's own tabs, matching its sidebar row. A
 * fresh, unsent chat has no chat yet, so it reports its workspace.
 */
export function projectTabScope(input: {
  view: ProjectViewTab;
  root: boolean;
  slug: string;
  activeSession: string | null;
  unread?: ReadonlySet<string>;
}): TabScope {
  const { view, root, slug, activeSession, unread } = input;
  if (view === "chat" && activeSession) {
    return { kind: "chat", sessionId: activeSession, unread: unread?.has(activeSession) ?? false };
  }
  if (root && view === "home") return { kind: "instance" };
  return { kind: "workspace", key: slug };
}

export function useProjectDocumentTitle(state: ProjectDocumentTitleState): void {
  const { projects, rootWorkspace } = useProjects();
  const { root, slug, chats, lastActiveChat, activeSession } = state;
  // `ProjectView` stays mounted across a project switch and clears `project` in
  // an effect, so for at least one commit (longer if the old fetch lands late)
  // it still holds the PREVIOUS project. Only trust it when it is this route's.
  const project = state.project?.slug === slug ? state.project : null;
  // Best available name: the loaded detail, else the sidebar's cached copy
  // (present before the detail lands), else the slug itself.
  const cached = root ? rootWorkspace : projects.find((p) => p.slug === slug);
  const workspaceName = project?.name ?? cached?.name ?? slug;
  const activeChat =
    chats.find((c) => c.sessionId === activeSession) ??
    (lastActiveChat?.sessionId === activeSession ? lastActiveChat : null);
  // Publishing still drives the favicon dot. The title deliberately takes no
  // status prefix (`● ` / `✓ ` / `(n) `): the dot says the same thing, and the
  // glyphs crowd the tab label.
  usePublishTabScope(projectTabScope(state));
  useDocumentTitle(
    projectTitleParts({
      ...state,
      workspaceName,
      activeChat,
      loaded: project !== null,
    }),
  );
}
