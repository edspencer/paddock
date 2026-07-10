import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SentFileBlock } from "./SentFileBlock";
import type { SentFile } from "../lib/types";

const inline = (over: Partial<SentFile>): SentFile => ({
  filename: "x.txt",
  kind: "text",
  source: "inline",
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SentFileBlock", () => {
  it("shows the filename and a kind label in the header", () => {
    render(<SentFileBlock file={inline({ filename: "notes.md", kind: "markdown" })} />);
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("markdown")).toBeInTheDocument();
  });

  it("prefers the language label over the kind for code", () => {
    render(
      <SentFileBlock
        file={inline({ filename: "a.ts", kind: "code", language: "typescript", content: "const x = 1" })}
      />,
    );
    expect(screen.getByText("typescript")).toBeInTheDocument();
    expect(screen.getByText("const x = 1")).toBeInTheDocument();
  });

  it("renders inline text content in a preformatted block", () => {
    render(<SentFileBlock file={inline({ content: "plain body" })} />);
    expect(screen.getByText("plain body")).toBeInTheDocument();
  });

  it("renders the agent's accompanying message when present", () => {
    render(<SentFileBlock file={inline({ message: "here you go" })} />);
    expect(screen.getByText("here you go")).toBeInTheDocument();
  });

  it("is expanded by default and collapses when the header is clicked", () => {
    render(<SentFileBlock file={inline({ content: "collapse me" })} />);
    expect(screen.getByText("collapse me")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(screen.queryByText("collapse me")).not.toBeInTheDocument();
  });

  it("renders a file-source image from its rawUrl", () => {
    const rawUrl = "/api/chat-files/scratch?path=p.png";
    render(
      <SentFileBlock file={{ filename: "p.png", kind: "image", source: "file", rawUrl }} />,
    );
    const img = screen.getByAltText("p.png") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(rawUrl);
  });

  it("shows a fallback when an image has no rawUrl", () => {
    render(<SentFileBlock file={{ filename: "p.png", kind: "image", source: "file" }} />);
    expect(screen.getByText(/could not display/i)).toBeInTheDocument();
  });

  it("loads a file-source text file's bytes from rawUrl and renders them", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("fetched body", { status: 200 }),
    );
    render(
      <SentFileBlock
        file={{ filename: "r.txt", kind: "text", source: "file", rawUrl: "/api/chat-files/scratch?path=r.txt" }}
      />,
    );
    expect(await screen.findByText("fetched body")).toBeInTheDocument();
  });

  it("shows an error when a file-source fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    render(
      <SentFileBlock
        file={{ filename: "r.txt", kind: "text", source: "file", rawUrl: "/api/chat-files/scratch?path=r.txt" }}
      />,
    );
    await waitFor(() => expect(screen.getByText(/could not load/i)).toBeInTheDocument());
  });

  it("routes a code kind through the syntax highlighter (eventually gets an hljs class)", async () => {
    const { container } = render(
      <SentFileBlock
        file={inline({ filename: "a.py", kind: "code", language: "python", content: "def hi():\n    return 1" })}
      />,
    );
    // Baseline text is present immediately; the highlighter upgrades it async.
    expect(screen.getByText(/def hi/)).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector("code.hljs")).not.toBeNull());
  });

  it("keeps a text kind as a plain pre (never highlighted)", async () => {
    const { container } = render(
      <SentFileBlock file={inline({ filename: "n.txt", kind: "text", content: "plain body" })} />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("code.hljs")).toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
    expect(screen.getByText("plain body")).toBeInTheDocument();
  });
});
