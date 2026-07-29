import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromoteChatModal } from "./PromoteChatModal";
import { makeProject } from "../test/factories";

const promoteChat = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { promoteChat: (...a: unknown[]) => promoteChat(...a) } };
});

describe("PromoteChatModal", () => {
  beforeEach(() => {
    promoteChat.mockReset();
    promoteChat.mockResolvedValue({ project: makeProject({ slug: "promoted" }), promoted: true });
  });

  it("prefills the name from defaultName", () => {
    render(
      <PromoteChatModal
        open
        slug=""
        sessionId="sess-9"
        defaultName="Heater chat"
        onClose={() => {}}
        onPromoted={() => {}}
      />,
    );
    expect(screen.getByDisplayValue("Heater chat")).toBeInTheDocument();
  });

  it("disables Promote until a name is present", async () => {
    render(
      <PromoteChatModal open sessionId="s" onClose={() => {}} onPromoted={() => {}} />,
    );
    const submit = screen.getByRole("button", { name: /promote to project/i });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "P");
    expect(submit).toBeEnabled();
  });

  it("calls promoteChat with slug + sessionId + built payload and reports the promoted flag", async () => {
    const onPromoted = vi.fn();
    render(
      <PromoteChatModal
        open
        slug=""
        sessionId="sess-9"
        defaultName="Heater"
        onClose={() => {}}
        onPromoted={onPromoted}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText(/One line on what/i), "promoted project");
    await userEvent.type(screen.getByPlaceholderText(/home, plumbing/i), " home , plumbing ");
    fireEvent.change(screen.getByDisplayValue("Unsorted"), { target: { value: "side-projects" } });

    fireEvent.click(screen.getByRole("button", { name: /promote to project/i }));

    await waitFor(() => expect(promoteChat).toHaveBeenCalledTimes(1));
    expect(promoteChat).toHaveBeenCalledWith("", "sess-9", {
      name: "Heater",
      group: "side-projects",
      summary: "promoted project",
      domain: ["home", "plumbing"],
    });
    await waitFor(() =>
      expect(onPromoted).toHaveBeenCalledWith(expect.objectContaining({ slug: "promoted" }), true),
    );
  });

  it("surfaces an API error and stays open", async () => {
    const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    promoteChat.mockRejectedValueOnce(new ApiError("boom", 500));
    const onPromoted = vi.fn();
    render(
      <PromoteChatModal open sessionId="s" defaultName="X" onClose={() => {}} onPromoted={onPromoted} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /promote to project/i }));
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
    expect(onPromoted).not.toHaveBeenCalled();
  });

  /**
   * Reset-on-open, and ONLY on open (#566).
   *
   * The reset used to share an effect with the Escape listener, so `busy` and
   * `onClose` were in its dependency list and it re-ran on almost anything. Both
   * of the tests below failed before that split, and neither failure was
   * theoretical — `onClose` is an inline arrow at the only call site and
   * `ProjectView` re-renders on every WS frame.
   */
  describe("does not reset itself on unrelated re-renders (#566)", () => {
    /** A parent that re-renders on demand, handing down a FRESH `onClose` each time. */
    function Parent({ onPromoted = () => {} }: { onPromoted?: () => void }) {
      const [tick, bump] = useState(0);
      return (
        <>
          <button onClick={() => bump(tick + 1)}>re-render parent</button>
          <PromoteChatModal
            open
            slug=""
            sessionId="s"
            defaultName="Root chat"
            onClose={() => {}}
            onPromoted={onPromoted}
          />
        </>
      );
    }

    it("keeps what the user typed when the parent re-renders", async () => {
      render(<Parent />);
      const name = screen.getByPlaceholderText(/Garage Water Heater/i);
      fireEvent.change(name, { target: { value: "Garage Water Heater Replacement" } });
      fireEvent.click(screen.getByRole("button", { name: "re-render parent" }));
      // Reverting to the chat's name mid-sentence is what this used to do, and it
      // looked like the field randomly undoing itself.
      expect(screen.getByPlaceholderText(/Garage Water Heater/i)).toHaveValue(
        "Garage Water Heater Replacement",
      );
    });

    it("keeps the error on screen after a failed submit settles", async () => {
      const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
      promoteChat.mockRejectedValueOnce(new ApiError("disk on fire", 500));
      render(<Parent />);
      fireEvent.click(screen.getByRole("button", { name: /promote to project/i }));
      const err = await screen.findByText("disk on fire");
      expect(err).toBeInTheDocument();
      // The old effect's `setError(null)` re-ran the moment `busy` went back to
      // false — i.e. one render after the catch set it. So the message existed
      // for a single frame and the dialog looked like it had done nothing at all.
      // A parent re-render must not clear it either.
      fireEvent.click(screen.getByRole("button", { name: "re-render parent" }));
      expect(screen.getByText("disk on fire")).toBeInTheDocument();
    });
  });
});
