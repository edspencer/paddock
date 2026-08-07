import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AdoptChatsModal } from "./AdoptChatsModal";
import type { AdoptableChats } from "../lib/types";

/**
 * The adoption confirmation dialog (#660).
 *
 * ProjectView's own suite covers the flow (click → dialog → confirm → toast →
 * undo). What is pinned here is the dialog's own behaviour: what it shows, what
 * it sends, and how it copes with a server that predates it.
 */
describe("AdoptChatsModal (#660)", () => {
  const offer = (over: Partial<AdoptableChats> = {}): AdoptableChats => ({
    count: 3,
    sources: [
      {
        sourceCwd: "/home/ed/code/api",
        sessionIds: ["a1", "a2"],
        sessions: [
          {
            sessionId: "a1",
            mtime: "2026-07-02T09:00:00.000Z",
            preview: "fix the auth refactor",
            sizeBytes: 8192,
          },
          {
            sessionId: "a2",
            mtime: "2026-07-03T09:00:00.000Z",
            autoName: "Rework the token cache",
            preview: "ignored when autoName is present",
            sizeBytes: 2_400_000,
          },
        ],
      },
      {
        sourceCwd: "/data/scratch/qa-copy/api",
        sessionIds: ["b1"],
        sessions: [
          { sessionId: "b1", mtime: "2026-06-30T09:00:00.000Z", sizeBytes: 700 },
        ],
      },
    ],
    ...over,
  });

  const setup = (props: Partial<Parameters<typeof AdoptChatsModal>[0]> = {}) => {
    const onAdopt = vi.fn();
    const onClose = vi.fn();
    render(
      <AdoptChatsModal
        open
        adoptable={offer()}
        busy={false}
        onClose={onClose}
        onAdopt={onAdopt}
        {...props}
      />,
    );
    return { onAdopt, onClose };
  };

  it("renders nothing while closed", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("groups candidates under the source directory they came from", () => {
    setup();
    // The whole point of the dialog: an unrecognised origin is visible BEFORE
    // anything is adopted. Shown in full, not truncated to a basename.
    expect(screen.getByText("/home/ed/code/api")).toBeInTheDocument();
    expect(screen.getByText("/data/scratch/qa-copy/api")).toBeInTheDocument();
  });

  it("labels a session by autoName, falling back to preview and then the id", () => {
    setup();
    expect(screen.getByText("Rework the token cache")).toBeInTheDocument();
    expect(screen.getByText("fix the auth refactor")).toBeInTheDocument();
    // Neither name nor preview — still a real transcript, so it must render as
    // something clickable rather than a blank row.
    expect(screen.getByText("b1")).toBeInTheDocument();
  });

  it("starts with everything selected and adopts the lot on confirm", () => {
    const { onAdopt } = setup();
    expect(screen.getByText("3 of 3 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Adopt 3 chats$/ }));
    expect(onAdopt).toHaveBeenCalledWith(["a1", "a2", "b1"]);
  });

  it("sends only what is still ticked", () => {
    const { onAdopt } = setup();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByText("2 of 3 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Adopt 2 chats$/ }));
    expect(onAdopt).toHaveBeenCalledWith(["a2", "b1"]);
  });

  it("deselects a whole source at once — the scratch-copy case", () => {
    const { onAdopt } = setup();
    // Each source has its own toggle; the second is the one nobody recognises.
    fireEvent.click(screen.getAllByRole("button", { name: /Deselect all/ })[1]);
    fireEvent.click(screen.getByRole("button", { name: /^Adopt 2 chats$/ }));
    expect(onAdopt).toHaveBeenCalledWith(["a1", "a2"]);
  });

  it("cannot confirm an empty selection", () => {
    setup();
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    expect(screen.getByText("0 of 3 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Adopt 0 chats$/ })).toBeDisabled();
  });

  it("refuses to close out from under an in-flight adoption", () => {
    const { onClose } = setup({ busy: true });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    // The request would still land, so the buttons stay inert too.
    expect(screen.getByRole("button", { name: /Adopting…/ })).toBeDisabled();
  });

  it("closes on Escape when idle", () => {
    const { onClose } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("degrades to id-only rows against a server that reports no session detail", () => {
    // Version skew: `sessions` is newer than `sessionIds`. An older server still
    // answers the count endpoint, and crashing the whole route over a missing
    // field would be a worse outcome than a plainer dialog.
    const { onAdopt } = setup({
      adoptable: {
        count: 2,
        sources: [
          { sourceCwd: "/w", sessionIds: ["x1", "x2"] } as AdoptableChats["sources"][number],
        ],
      },
    });
    expect(screen.getByText("x1")).toBeInTheDocument();
    // No date/size line invented for data that was never sent.
    expect(screen.queryByText(/unknown date/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Adopt 2 chats$/ }));
    expect(onAdopt).toHaveBeenCalledWith(["x1", "x2"]);
  });

  it("says so plainly when there is nothing on offer", () => {
    setup({ adoptable: { count: 0, sources: [] } });
    expect(screen.getByText(/Nothing left to adopt/)).toBeInTheDocument();
  });
});
