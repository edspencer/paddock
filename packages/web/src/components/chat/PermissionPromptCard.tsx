import type { PendingPermission, PermissionAnswer, PermissionDecision } from "../../lib/types";
import { AlertIcon, CheckIcon, XIcon } from "../icons";
import { Button, Callout, Chip, type ChipTone } from "../ui";

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
    <Callout
      tone="neutral"
      role="alertdialog"
      aria-label={`Approve ${request.toolName}?`}
      data-testid="permission-prompt"
      className="w-full"
      icon={<AlertIcon width={16} height={16} className="text-fg-muted" />}
    >
      <div className="text-fg">
        Claude wants to use <span className="font-medium">{request.toolName}</span>
      </div>
      <code className="mt-0.5 block break-all text-xs text-fg-muted">
        {permissionSubject(request)}
      </code>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <Button variant="subtle" size="sm" onClick={() => onAnswer("deny")}>
          Deny
        </Button>
        {request.alwaysAllowed && (
          <Button variant="ghost" size="sm" onClick={() => onAnswer("always")}>
            Always allow
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={() => onAnswer("once")}>
          Allow once
        </Button>
      </div>
    </Callout>
  );
}

/** How each outcome reads in the transcript, and its chip colour. */
const DECISION_LOOK: Record<
  PermissionDecision["outcome"],
  { label: string; tone: ChipTone; allowed: boolean }
> = {
  once: { label: "Allowed once", tone: "success", allowed: true },
  always: { label: "Always allowed", tone: "success", allowed: true },
  deny: { label: "Denied", tone: "danger", allowed: false },
  cancelled: { label: "Cancelled", tone: "neutral", allowed: false },
};

/**
 * The record of one settled permission prompt (#971), shown above the tool call
 * it was about. The pinned {@link PermissionPromptCard} leaves once answered;
 * this line is what stays in the transcript: that approval was asked, for what,
 * and the outcome. The subject is a code span for the same reason as the card's.
 */
export function PermissionDecisionNote({ decision }: { decision: PermissionDecision }) {
  const look = DECISION_LOOK[decision.outcome];
  const Icon = look.allowed ? CheckIcon : XIcon;
  const when = new Date(decision.decidedAt).toLocaleString();
  return (
    <div
      data-testid="permission-decision"
      className="flex w-full max-w-[92%] min-w-0 items-center gap-1.5 px-1 text-2xs text-fg-muted"
      title={`${look.label}${decision.reason ? ` (${decision.reason})` : ""}, ${when}`}
    >
      <Icon
        width={12}
        height={12}
        className={`shrink-0 ${look.allowed ? "text-success" : "text-fg-subtle"}`}
      />
      <span className="shrink-0">
        Approval asked to use <span className="font-medium text-fg">{decision.toolName}</span>
      </span>
      <code className="min-w-0 truncate font-mono text-fg-subtle">{decision.subject}</code>
      <Chip tone={look.tone} size="sm" className="ml-auto shrink-0 whitespace-nowrap">
        {look.label}
        {decision.reason ? ` · ${decision.reason}` : ""}
      </Chip>
    </div>
  );
}
