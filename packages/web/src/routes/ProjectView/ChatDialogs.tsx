import type { NavigateFunction } from "react-router-dom";
import type { Chat, Project } from "../../lib/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ForkChatModal } from "../../components/ForkChatModal";
import { RenameChatModal } from "../../components/RenameChatModal";
import { PromoteChatModal } from "../../components/PromoteChatModal";
import { AdoptChatsModal } from "../../components/AdoptChatsModal";
import { Toast } from "../../components/Toast";
import type { useChatActions } from "./useChatActions";
import type { useChatAdoption } from "./useChatAdoption";

/**
 * Every chat-level dialog the workspace route raises — the count-aware delete
 * confirmation, promote-into-a-project, rename, the shared fork-naming dialog,
 * the adoption confirmation — plus the route's one toast. Rendered at the route
 * level rather than inside the sidebar so none of them is clipped by the
 * sidebar's own scroll containers. Lifted out of `ProjectView` verbatim (#919).
 */
export function ChatDialogs({
  actions,
  adoption,
  slug,
  upsert,
  navigate,
  promotingChat,
  setPromotingChat,
  forkRequest,
  setForkRequest,
  commitFork,
}: {
  actions: ReturnType<typeof useChatActions>;
  adoption: ReturnType<typeof useChatAdoption>;
  slug: string;
  upsert: (project: Project) => void;
  navigate: NavigateFunction;
  promotingChat: Chat | null;
  setPromotingChat: (chat: Chat | null) => void;
  forkRequest: { chat: Chat; fromUuid?: string } | null;
  setForkRequest: (req: { chat: Chat; fromUuid?: string } | null) => void;
  commitFork: (chat: Chat, name: string, fromUuid?: string) => Promise<void>;
}) {
  const {
    deletingChat,
    setDeletingChat,
    confirmDeleteChat,
    renamingChat,
    setRenamingChat,
    commitRename,
  } = actions;
  const { adoptOpen, adoptable, adopting, setAdoptOpen, confirmAdopt, toast, dismissToast } =
    adoption;

  return (
    <>
    {/* Chat delete confirmation. The copy is COUNT-AWARE (#508): a Shift-click
        on a parent deletes its whole subtree, and a collapsed parent means
        those chats aren't even on screen — so the dialog names the number
        rather than saying "this chat" and taking out twenty-one. */}
    <ConfirmDialog
      open={deletingChat !== null}
      title={
        deletingChat && deletingChat.ids.length > 1
          ? `Delete ${deletingChat.ids.length} chats?`
          : "Delete chat?"
      }
      message={
        deletingChat && (
          <>
            {deletingChat.ids.length > 1 ? (
              <>
                <span className="font-medium text-fg">
                  {deletingChat.chat.name}
                </span>{" "}
                and its {deletingChat.ids.length - 1} nested chat
                {deletingChat.ids.length - 1 === 1 ? "" : "s"} will be permanently removed —
                their transcripts too.
              </>
            ) : (
              "This chat's transcript will be permanently removed."
            )}
            {/* Survivors, named. Reachable two ways: a plain click on a parent
                (which never takes its children), and a Shift-click while a
                search has narrowed the tree to a few matching children. Either
                way the rest are re-homed to the top level by an action that
                can't be undone, so the dialog says it out loud. */}
            {deletingChat.orphanCount > 0 && (
              <>
                {" "}
                Its {deletingChat.orphanCount} other nested chat
                {deletingChat.orphanCount === 1 ? "" : "s"} will be kept and moved to the top
                level.
              </>
            )}{" "}
            This cannot be undone.
          </>
        )
      }
      confirmLabel={
        deletingChat && deletingChat.ids.length > 1
          ? `Delete ${deletingChat.ids.length} chats`
          : "Delete chat"
      }
      onConfirm={confirmDeleteChat}
      onClose={() => setDeletingChat(null)}
    />
    {promotingChat && (
      <PromoteChatModal
        open
        slug={slug}
        sessionId={promotingChat.sessionId}
        defaultName={promotingChat.name}
        onClose={() => setPromotingChat(null)}
        onPromoted={(project) => {
          setPromotingChat(null);
          // Put the new project in the sidebar NOW (#566). Nothing else would:
          // the project list has no push channel (`ws.ts` carries only
          // `chat:*`), so without this it stays missing until a full reload or
          // an unrelated `refreshProjects()` — which is why the row used to
          // appear only after you sent a turn in the new project.
          //
          // `upsert` and not `refresh()`: refetching flips the context's
          // `loading` flag, and AppShell swaps the whole project list for
          // skeletons while it is set — so a round-trip would trade a missing
          // row for a visible flash of the entire nav. This is the same local
          // insert the New Project path already does (`ProjectsGrid`).
          upsert(project);
          // The transcript moved, so the chat is gone from this list and lives
          // in the new project — land the user where it went.
          navigate(`/projects/${project.slug}/chat`);
        }}
      />
    )}
    {renamingChat && (
      <RenameChatModal
        open
        chatName={renamingChat.name}
        resetName={renamingChat.preview}
        onClose={() => setRenamingChat(null)}
        onRename={(name) => {
          const chat = renamingChat;
          setRenamingChat(null);
          void commitRename(chat, name);
        }}
      />
    )}
    {/* One naming dialog for both fork paths — the sidebar's whole-chat fork
        and the transcript rail's fork-from-here (#451). The request object is
        read into a local BEFORE it is cleared, so `fromUuid` survives the
        close: dropping it here would fork the entire transcript under the
        right name, with nothing in the UI to show for it. */}
    {forkRequest && (
      <ForkChatModal
        open
        chatName={forkRequest.chat.name}
        onClose={() => setForkRequest(null)}
        onFork={(name) => {
          const { chat, fromUuid } = forkRequest;
          setForkRequest(null);
          void commitFork(chat, name, fromUuid);
        }}
      />
    )}
    {/* Transient outcome of the native-chat adoption (#588). Rendered
        unconditionally — `Toast` is a no-op while there is no message — and at
        the route level rather than inside the sidebar so it is not clipped by
        the sidebar's own scroll containers. */}
    {/* Confirm what an adoption would bring in, before it brings it in (#660). */}
    <AdoptChatsModal
      open={adoptOpen}
      adoptable={adoptable}
      busy={adopting}
      onClose={() => setAdoptOpen(false)}
      onAdopt={(sessionIds) => void confirmAdopt(sessionIds)}
    />
    <Toast
      message={toast?.message ?? null}
      tone={toast?.tone}
      onDismiss={dismissToast}
      action={toast?.action}
      // Longer than the default 6s when an Undo is on offer: six seconds is
      // enough to read an outcome, not to decide to reverse it.
      durationMs={toast?.action ? 12000 : undefined}
    />
    </>
  );
}
