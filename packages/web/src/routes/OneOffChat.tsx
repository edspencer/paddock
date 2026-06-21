import { useParams } from "react-router-dom";
import { ChatPane } from "../components/ChatPane";
import { ADHOC_TARGET } from "../lib/types";

/**
 * One-off (scratch) chat — secondary to projects. Uses the "__adhoc__" target,
 * which the server routes to the scratch keeper agent. `:id` is "new" for a
 * fresh session or an existing session id to resume.
 */
export function OneOffChat() {
  const { id = "new" } = useParams();
  const sessionId = id === "new" ? undefined : id;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-paddock-200 px-6 py-4 dark:border-paddock-800">
        <h1 className="text-xl font-semibold tracking-tight">One-off chat</h1>
        <p className="mt-1 text-sm text-paddock-500">
          A scratch conversation not tied to a project. Create a project to keep work organized.
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <ChatPane
          key={sessionId ?? "new"}
          target={ADHOC_TARGET}
          initialSessionId={sessionId}
          title={sessionId ? "Resumed one-off chat" : "New one-off chat"}
        />
      </div>
    </div>
  );
}
