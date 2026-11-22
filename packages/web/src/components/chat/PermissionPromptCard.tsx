import type { PendingPermission, PermissionAnswer } from "../../lib/types";
import { AlertIcon } from "../icons";
import { Button } from "../ui";

/**
 * What the request is about, in one line: the file for an edit tool, the
 * command for Bash, else the input as JSON. Shown verbatim in a code span so a
 * crafted path cannot pass for UI text.
 */
export function permissionSubject(req: PendingPermission): string {
  const { input } = req;
  for (const key of ["file_path", "notebook_path", "path", "command", "url"]) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return JSON.stringify(input);
}

/**
 * One tool use waiting for approval (#971). Pinned above the composer while the
 * turn waits on it. The card leaves when the server's next `chat:permissions`
 * frame drops the request, so it holds no state of its own.
 *
 * TODO: no diff preview for Edit/Write, and no "answered by another tab" note.
 */
export function PermissionPromptCard({
  request,
  onAnswer,
}: {
  request: PendingPermission;
  onAnswer: (answer: PermissionAnswer) => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={`Approve ${request.toolName}?`}
      data-testid="permission-prompt"
      className="flex w-full flex-col gap-2 rounded-lg border border-edge bg-surface-hover px-3 py-2 text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertIcon width={16} height={16} className="mt-0.5 shrink-0 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-fg">
            Claude wants to use <span className="font-medium">{request.toolName}</span>
          </div>
          <code className="mt-0.5 block break-all text-xs text-fg-muted">
            {permissionSubject(request)}
          </code>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="subtle" size="sm" onClick={() => onAnswer("deny")}>
          Deny
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onAnswer("always")}>
          Always allow
        </Button>
        <Button variant="primary" size="sm" onClick={() => onAnswer("once")}>
          Allow once
        </Button>
      </div>
    </div>
  );
}
