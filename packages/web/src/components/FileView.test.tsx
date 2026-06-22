import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { FileView } from "./FileView";

const getProjectFile = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { getProjectFile: (...a: unknown[]) => getProjectFile(...a) } };
});

// Mermaid is heavy + async; stub it so a markdown file with a ```mermaid fence
// renders a deterministic marker we can assert routing on.
vi.mock("./Mermaid", () => ({
  Mermaid: ({ code }: { code: string }) => <div data-testid="mermaid-stub">{code}</div>,
}));

beforeEach(() => getProjectFile.mockReset());

describe("FileView: render-kind routing", () => {
  it("renders a markdown file through the Markdown renderer", async () => {
    getProjectFile.mockResolvedValue({ name: "doc.md", kind: "markdown", content: "# Heading\n\nbody text" });
    render(<FileView slug="p" name="doc.md" />);
    expect(await screen.findByRole("heading", { name: "Heading" })).toBeInTheDocument();
    expect(screen.getByText("body text")).toBeInTheDocument();
  });

  it("renders a markdown file's mermaid fence as a diagram (file viewer enables mermaid)", async () => {
    getProjectFile.mockResolvedValue({
      name: "diagram.md",
      kind: "markdown",
      content: "```mermaid\ngraph TD; A-->B;\n```",
    });
    render(<FileView slug="p" name="diagram.md" />);
    expect(await screen.findByTestId("mermaid-stub")).toHaveTextContent("graph TD; A-->B;");
  });

  it("renders an HTML file inside a sandboxed iframe (scripts allowed, no same-origin)", async () => {
    getProjectFile.mockResolvedValue({
      name: "page.html",
      kind: "html",
      content: "<h1>hi</h1><script>1</script>",
    });
    render(<FileView slug="p" name="page.html" />);
    const frame = (await screen.findByTitle("page.html")) as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    // Critically NOT allow-same-origin (that would defeat the isolation).
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>hi</h1>");
    expect(screen.getByText(/sandboxed frame/i)).toBeInTheDocument();
  });

  it("renders a text file as monospace preformatted content", async () => {
    getProjectFile.mockResolvedValue({ name: "notes.txt", kind: "text", content: "plain\ttext" });
    render(<FileView slug="p" name="notes.txt" />);
    expect(await screen.findByText(/plain\s+text/)).toBeInTheDocument();
  });
});

describe("FileView: states", () => {
  it("shows a loading skeleton before the file resolves", () => {
    getProjectFile.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<FileView slug="p" name="doc.md" />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("surfaces a load error", async () => {
    getProjectFile.mockRejectedValue(new Error("file not found"));
    render(<FileView slug="p" name="missing.md" />);
    expect(await screen.findByText("file not found")).toBeInTheDocument();
  });

  it("refetches when the name changes", async () => {
    getProjectFile.mockResolvedValue({ name: "a.md", kind: "markdown", content: "A" });
    const { rerender } = render(<FileView slug="p" name="a.md" />);
    await waitFor(() => expect(getProjectFile).toHaveBeenCalledWith("p", "a.md"));
    getProjectFile.mockResolvedValue({ name: "b.md", kind: "markdown", content: "B" });
    rerender(<FileView slug="p" name="b.md" />);
    await waitFor(() => expect(getProjectFile).toHaveBeenCalledWith("p", "b.md"));
  });
});
