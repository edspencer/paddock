import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PermissionDecisionNote, PermissionPromptCard } from "./PermissionPromptCard";
import type { PendingPermission, PermissionDecision } from "../../lib/types";

const EDIT: PendingPermission = {
  id: "r1",
  projectSlug: "proj",
  sessionId: "s1",
  toolName: "Edit",
  input: { file_path: "/home/u/.claude/CLAUDE.md", old_string: "a", new_string: "b" },
  subject: "/home/u/.claude/CLAUDE.md",
  alwaysAllowed: true,
  requestedAt: 0,
};

describe("PermissionPromptCard (#971)", () => {
  it("shows the tool and the file it wants to touch", () => {
    render(<PermissionPromptCard request={EDIT} onAnswer={() => {}} />);
    expect(screen.getByRole("alertdialog", { name: "Approve Edit?" })).toBeInTheDocument();
    expect(screen.getByText("/home/u/.claude/CLAUDE.md")).toBeInTheDocument();
  });

  it("reports each answer", async () => {
    const onAnswer = vi.fn();
    render(<PermissionPromptCard request={EDIT} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await userEvent.click(screen.getByRole("button", { name: "Always allow" }));
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onAnswer.mock.calls).toEqual([["once"], ["always"], ["deny"]]);
  });

  it("offers no Always allow when the server says no exact rule exists", () => {
    render(<PermissionPromptCard request={{ ...EDIT, alwaysAllowed: false }} onAnswer={() => {}} />);
    expect(screen.queryByRole("button", { name: "Always allow" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("shows the subject the server sent, not one of its own", () => {
    const bash = { ...EDIT, toolName: "Bash", input: { command: "x" }, subject: "rm -rf build" };
    render(<PermissionPromptCard request={bash} onAnswer={() => {}} />);
    expect(screen.getByText("rm -rf build")).toBeInTheDocument();
  });
});

describe("PermissionDecisionNote (#971)", () => {
  const decision: PermissionDecision = {
    toolUseId: "toolu_1",
    toolName: "Bash",
    subject: "rm -rf build",
    outcome: "once",
    requestedAt: 0,
    decidedAt: 0,
  };

  it("says approval was asked, for what, and the outcome", () => {
    render(<PermissionDecisionNote decision={decision} />);
    const note = screen.getByTestId("permission-decision");
    expect(note).toHaveTextContent("Approval asked to use Bash");
    expect(note).toHaveTextContent("rm -rf build");
    expect(note).toHaveTextContent("Allowed once");
  });

  it.each([
    ["always", undefined, "Always allowed"],
    ["deny", undefined, "Denied"],
    ["cancelled", "the turn ended", "Cancelled · the turn ended"],
  ] as const)("labels %s", (outcome, reason, label) => {
    render(<PermissionDecisionNote decision={{ ...decision, outcome, reason }} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
