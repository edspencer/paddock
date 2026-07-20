import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageAttachments, AttachmentTrayItem } from "./MessageAttachments";
import type { AttachmentRef } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const img: AttachmentRef = { id: "aaaa.png", filename: "shot.png", kind: "image" };
const doc: AttachmentRef = { id: "bbbb.pdf", filename: "report.pdf", kind: "pdf", size: 2048 };

describe("MessageAttachments (transcript render)", () => {
  it("renders an image thumbnail pointing at the raw-bytes endpoint", () => {
    render(<MessageAttachments attachments={[img]} />);
    const el = screen.getByAltText("shot.png") as HTMLImageElement;
    expect(el.getAttribute("src")).toBe("/api/chat-files/aaaa.png");
  });

  it("renders a non-image as a chip linking to the raw bytes, with a size label", () => {
    render(<MessageAttachments attachments={[doc]} />);
    const chip = screen.getByTestId("attachment-chip") as HTMLAnchorElement;
    expect(chip.getAttribute("href")).toBe("/api/chat-files/bbbb.pdf");
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<MessageAttachments attachments={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("AttachmentTrayItem (composer tray)", () => {
  it("shows a removable chip and fires onRemove with the id", () => {
    const onRemove = vi.fn();
    render(<AttachmentTrayItem attachment={doc} onRemove={onRemove} />);
    fireEvent.click(screen.getByTestId("attachment-remove"));
    expect(onRemove).toHaveBeenCalledWith("bbbb.pdf");
  });
});
