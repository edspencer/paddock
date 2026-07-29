import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenameChatModal } from "./RenameChatModal";

describe("RenameChatModal", () => {
  it("prefills with the current name and selects it on open", () => {
    render(
      <RenameChatModal open chatName="Heater chat" onClose={() => {}} onRename={() => {}} />,
    );
    const input = screen.getByDisplayValue("Heater chat") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    // Auto-selected so the first keystroke replaces the old name.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Heater chat".length);
  });

  it("renames with the trimmed name on Enter", async () => {
    const onRename = vi.fn();
    render(<RenameChatModal open chatName="Heater" onClose={() => {}} onRename={onRename} />);
    const input = screen.getByDisplayValue("Heater");
    await userEvent.clear(input);
    await userEvent.type(input, "  Pod tuning  {Enter}");
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("Pod tuning");
  });

  // The tri-state that `window.prompt` gave us for free, and the whole reason
  // this modal can't just report "closed" vs "submitted a string": clearing the
  // box is a deliberate RESET, distinct from cancelling.
  it("reports null — not an empty string — when the name is cleared", () => {
    const onRename = vi.fn();
    render(<RenameChatModal open chatName="Heater" onClose={() => {}} onRename={onRename} />);
    const input = screen.getByDisplayValue("Heater");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.submit(input.closest("form")!);
    expect(onRename).toHaveBeenCalledWith(null);
  });

  it("treats a whitespace-only name as a reset, not a rename to spaces", () => {
    const onRename = vi.fn();
    render(<RenameChatModal open chatName="Heater" onClose={() => {}} onRename={onRename} />);
    const input = screen.getByDisplayValue("Heater");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect(onRename).toHaveBeenCalledWith(null);
  });

  it("advertises the reset — naming the fallback and relabelling the button", () => {
    render(
      <RenameChatModal
        open
        chatName="Heater"
        resetName="Fix the heater loop"
        onClose={() => {}}
        onRename={() => {}}
      />,
    );
    // Before clearing, the hint just says the reset exists.
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("Heater"), { target: { value: "" } });

    // Once cleared it names what you'd get, and the button stops lying.
    expect(screen.getByTestId("rename-hint")).toHaveTextContent("Fix the heater loop");
    expect(screen.getByRole("button", { name: "Reset name" })).toBeInTheDocument();
  });

  it("closes on Escape without renaming", () => {
    const onClose = vi.fn();
    const onRename = vi.fn();
    render(<RenameChatModal open chatName="Heater" onClose={onClose} onRename={onRename} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("closes on Cancel without renaming", () => {
    const onClose = vi.fn();
    const onRename = vi.fn();
    render(<RenameChatModal open chatName="Heater" onClose={onClose} onRename={onRename} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <RenameChatModal open={false} chatName="Heater" onClose={() => {}} onRename={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
