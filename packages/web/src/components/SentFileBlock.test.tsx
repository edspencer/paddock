import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SentFileBlock } from "./SentFileBlock";
import type { SentFile } from "../lib/types";

const file = (over: Partial<SentFile>): SentFile => ({
  filename: "x.txt",
  kind: "text",
  ...over,
});

describe("SentFileBlock", () => {
  it("shows the filename and a kind label in the header", () => {
    render(<SentFileBlock file={file({ filename: "notes.md", kind: "markdown" })} />);
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("markdown")).toBeInTheDocument();
  });

  it("prefers the language label over the kind for code", () => {
    render(
      <SentFileBlock
        file={file({ filename: "a.ts", kind: "code", language: "typescript", content: "const x = 1" })}
      />,
    );
    expect(screen.getByText("typescript")).toBeInTheDocument();
    expect(screen.getByText("const x = 1")).toBeInTheDocument();
  });

  it("renders text content in a preformatted block", () => {
    render(<SentFileBlock file={file({ content: "plain body" })} />);
    expect(screen.getByText("plain body")).toBeInTheDocument();
  });

  it("renders the agent's accompanying message when present", () => {
    render(<SentFileBlock file={file({ message: "here you go" })} />);
    expect(screen.getByText("here you go")).toBeInTheDocument();
  });

  it("renders an image from its data URL", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    render(<SentFileBlock file={file({ filename: "p.png", kind: "image", dataUrl })} />);
    const img = screen.getByAltText("p.png") as HTMLImageElement;
    expect(img.src).toBe(dataUrl);
  });

  it("shows a fallback when an image has no data URL", () => {
    render(<SentFileBlock file={file({ filename: "p.png", kind: "image" })} />);
    expect(screen.getByText(/could not display/i)).toBeInTheDocument();
  });
});
