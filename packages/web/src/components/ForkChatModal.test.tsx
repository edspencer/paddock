import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForkChatModal } from "./ForkChatModal";

describe("ForkChatModal", () => {
  it("prefills the name with 'Fork of <chat>' and selects it on open", () => {
    render(
      <ForkChatModal open chatName="Heater chat" onClose={() => {}} onFork={() => {}} />,
    );
    const input = screen.getByDisplayValue("Fork of Heater chat") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    // Auto-selected so the first keystroke replaces the default.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Fork of Heater chat".length);
  });

  it("forks with the entered name on Enter", async () => {
    const onFork = vi.fn();
    render(<ForkChatModal open chatName="Heater" onClose={() => {}} onFork={onFork} />);
    const input = screen.getByDisplayValue("Fork of Heater");
    // Selection means typing replaces the default (assert the outcome directly
    // by clearing + typing, then submitting via Enter).
    await userEvent.clear(input);
    await userEvent.type(input, "My experiment{Enter}");
    expect(onFork).toHaveBeenCalledTimes(1);
    expect(onFork).toHaveBeenCalledWith("My experiment");
  });

  it("falls back to the default name when the input is whitespace-only", () => {
    const onFork = vi.fn();
    render(<ForkChatModal open chatName="Heater" onClose={() => {}} onFork={onFork} />);
    const input = screen.getByDisplayValue("Fork of Heater");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect(onFork).toHaveBeenCalledWith("Fork of Heater");
  });

  it("closes on Escape without forking", () => {
    const onClose = vi.fn();
    const onFork = vi.fn();
    render(<ForkChatModal open chatName="Heater" onClose={onClose} onFork={onFork} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onFork).not.toHaveBeenCalled();
  });

  it("closes on Cancel without forking", () => {
    const onClose = vi.fn();
    const onFork = vi.fn();
    render(<ForkChatModal open chatName="Heater" onClose={onClose} onFork={onFork} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onFork).not.toHaveBeenCalled();
  });
});
