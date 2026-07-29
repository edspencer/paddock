import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

const noop = () => {};

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ConfirmDialog open={false} title="Delete?" message="Gone." onConfirm={noop} onClose={noop} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("confirms", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open title="Delete?" message="Gone." onConfirm={onConfirm} onClose={noop} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("cancels", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmDialog open title="Delete?" message="Gone." onConfirm={onConfirm} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // On success the dialog deliberately stays busy rather than resetting: the
  // parent is expected to unmount it, and re-enabling the buttons in between
  // would offer a second click on an action that already succeeded.
  it("stays busy after a successful confirm, so it can't be double-fired", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open title="Delete?" message="Gone." onConfirm={onConfirm} onClose={noop} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(await screen.findByRole("button", { name: /working/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeDisabled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<ConfirmDialog open title="Delete?" message="Gone." onConfirm={noop} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed confirm in place and stays open", async () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Gone."
        onConfirm={() => Promise.reject(new Error("Could not revert this chat."))}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(await screen.findByText("Could not revert this chat.")).toBeInTheDocument();
    // Still open, and still retryable — a failure must not silently dismiss.
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  describe("backdrop dismissal (#541)", () => {
    // The default stays click-to-dismiss so the existing short confirmations
    // are unchanged by this prop being added.
    it("closes on backdrop click by default", () => {
      const onClose = vi.fn();
      const { container } = render(
        <ConfirmDialog open title="Delete?" message="Gone." onConfirm={noop} onClose={onClose} />,
      );
      fireEvent.click(container.firstElementChild!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("ignores backdrop clicks when dismissOnBackdrop is false", () => {
      const onClose = vi.fn();
      const { container } = render(
        <ConfirmDialog
          open
          dismissOnBackdrop={false}
          title="Revert?"
          message="Long warning."
          onConfirm={noop}
          onClose={onClose}
        />,
      );
      fireEvent.click(container.firstElementChild!);
      expect(onClose).not.toHaveBeenCalled();
      // Escape and Cancel still work — the dialog isn't a trap.
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("renders structured message content, not just strings", () => {
    render(
      <ConfirmDialog
        open
        title="Revert?"
        message={
          <>
            <p>3 messages will be removed.</p>
            <p data-testid="caveat">Those actions are not undone.</p>
          </>
        }
        onConfirm={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByTestId("caveat")).toHaveTextContent("Those actions are not undone.");
  });
});
