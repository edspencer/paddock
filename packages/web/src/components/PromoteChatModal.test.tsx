import { describe, it, expect, vi, beforeEach } from "vitest";
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

  it("calls promoteChat with sessionId + built payload and reports the promoted flag", async () => {
    const onPromoted = vi.fn();
    render(
      <PromoteChatModal
        open
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
    expect(promoteChat).toHaveBeenCalledWith("sess-9", {
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
});
