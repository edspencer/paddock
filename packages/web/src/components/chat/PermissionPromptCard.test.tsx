import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PermissionPromptCard, permissionSubject } from "./PermissionPromptCard";
import type { PendingPermission } from "../../lib/types";

const EDIT: PendingPermission = {
  id: "r1",
  projectSlug: "proj",
  sessionId: "s1",
  toolName: "Edit",
  input: { file_path: "/home/u/.claude/CLAUDE.md", old_string: "a", new_string: "b" },
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

  it("summarises Bash by its command and anything else as JSON", () => {
    expect(permissionSubject({ ...EDIT, toolName: "Bash", input: { command: "ls -la" } })).toBe(
      "ls -la",
    );
    expect(permissionSubject({ ...EDIT, toolName: "X", input: { a: 1 } })).toBe('{"a":1}');
  });
});
