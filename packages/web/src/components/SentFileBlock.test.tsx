import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SentFileBlock } from "./SentFileBlock";
import { SentFileViewerContext } from "./chat/chatContexts";
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
    const rawUrl = "/api/chat-files/sess-1?path=p.png";
    render(
      <SentFileBlock file={{ filename: "p.png", kind: "image", source: "file", rawUrl }} />,
    );
    const img = screen.getByAltText("p.png") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(rawUrl);
  });

  it("renders a file-source video as an inline <video> from its rawUrl (issue #126)", () => {
    const rawUrl = "/api/chat-files/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4";
    const { container } = render(
      <SentFileBlock file={{ filename: "clip.mp4", kind: "video", source: "file", rawUrl }} />,
    );
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.getAttribute("src")).toBe(rawUrl);
    // Controls + inline playback (iOS) are what make the player usable.
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    // A video is never rendered as an image or a preformatted text block.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("shows a fallback when a video has no rawUrl (issue #126)", () => {
    render(<SentFileBlock file={{ filename: "clip.mp4", kind: "video", source: "file" }} />);
    expect(screen.getByText(/could not display this video/i)).toBeInTheDocument();
  });

  it("shows a fallback when an image has no rawUrl", () => {
    render(<SentFileBlock file={{ filename: "p.png", kind: "image", source: "file" }} />);
    expect(screen.getByText(/could not display/i)).toBeInTheDocument();
  });

  it("renders a file-source PDF in an <object> pointing at the rawUrl (no <pre>)", () => {
    const rawUrl = "/api/chat-files/abc.pdf";
    const { container } = render(
      <SentFileBlock file={{ filename: "report.pdf", kind: "pdf", source: "file", rawUrl }} />,
    );
    const obj = container.querySelector("object");
    expect(obj).not.toBeNull();
    expect(obj?.getAttribute("data")).toBe(rawUrl);
    expect(obj?.getAttribute("type")).toBe("application/pdf");
    // The garbage text path must NOT be used for a PDF.
    expect(container.querySelector("pre")).toBeNull();
    // The fallback links point at the same bytes (open + download).
    const link = screen.getByRole("link", { name: /open in new tab/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(rawUrl);
  });

  it("shows a fallback when a PDF has no rawUrl", () => {
    render(<SentFileBlock file={{ filename: "report.pdf", kind: "pdf", source: "file" }} />);
    expect(screen.getByText(/could not display/i)).toBeInTheDocument();
  });

  it("loads a file-source text file's bytes from rawUrl and renders them", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("fetched body", { status: 200 }),
    );
    render(
      <SentFileBlock
        file={{ filename: "r.txt", kind: "text", source: "file", rawUrl: "/api/chat-files/sess-1?path=r.txt" }}
      />,
    );
    expect(await screen.findByText("fetched body")).toBeInTheDocument();
  });

  it("shows an error when a file-source fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    render(
      <SentFileBlock
        file={{ filename: "r.txt", kind: "text", source: "file", rawUrl: "/api/chat-files/sess-1?path=r.txt" }}
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

describe("media action bar + image lightbox (#137)", () => {
  const image: SentFile = {
    filename: "shot.png",
    kind: "image",
    source: "file",
    rawUrl: "/api/chat-files/img.png",
    message: "a nice screenshot",
  };

  it("renders Download, Open-in-new-tab, and Maximize over an image (keyed to rawUrl)", () => {
    render(<SentFileBlock file={image} />);
    const download = screen.getByRole("link", { name: /download shot\.png/i }) as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe(image.rawUrl);
    expect(download.hasAttribute("download")).toBe(true);
    const open = screen.getByRole("link", { name: /open shot\.png in new tab/i }) as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(image.rawUrl);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(screen.getByRole("button", { name: /maximize/i })).toBeInTheDocument();
  });

  it("opens the lightbox on Maximize (image at rawUrl + filename/caption) and closes on Escape", () => {
    render(<SentFileBlock file={image} />);
    fireEvent.click(screen.getByRole("button", { name: /maximize/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    const lightboxImg = within(dialog).getByAltText("shot.png") as HTMLImageElement;
    expect(lightboxImg.getAttribute("src")).toBe(image.rawUrl);
    // The filename + the agent's caption both show beneath the lightbox image.
    expect(within(dialog).getByText("shot.png")).toBeInTheDocument();
    expect(within(dialog).getByText("a nice screenshot")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the lightbox on a backdrop click", () => {
    render(<SentFileBlock file={image} />);
    fireEvent.click(screen.getByRole("button", { name: /maximize/i }));
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows Download + Open-in-new-tab but NO Maximize on a PDF", () => {
    render(
      <SentFileBlock
        file={{ filename: "report.pdf", kind: "pdf", source: "file", rawUrl: "/api/chat-files/r.pdf" }}
      />,
    );
    const download = screen.getByRole("link", {
      name: /download report\.pdf/i,
    }) as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe("/api/chat-files/r.pdf");
    expect(
      screen.getByRole("link", { name: /open report\.pdf in new tab/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /maximize/i })).not.toBeInTheDocument();
  });
});

describe("the chat viewer hand-off (#944)", () => {
  const image: SentFile = {
    filename: "shot.png",
    kind: "image",
    source: "file",
    rawUrl: "/api/chat-files/img.png",
  };

  it("offers no header Maximize outside a chat, and an image keeps its own lightbox", () => {
    render(<SentFileBlock file={image} turnId="t-1" />);
    expect(screen.queryByRole("button", { name: "Maximize shot.png" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open shot.png full screen" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("inside a chat, every way in opens the chat's viewer on this turn", () => {
    const open = vi.fn();
    render(
      <SentFileViewerContext.Provider value={{ open }}>
        <SentFileBlock file={image} turnId="t-1" />
        <SentFileBlock file={inline({ filename: "notes.md", kind: "markdown" })} turnId="t-2" />
      </SentFileViewerContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open shot.png full screen" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize notes.md" }));
    expect(open.mock.calls.map(([id, f]) => [id, f.filename])).toEqual([
      ["t-1", "shot.png"],
      ["t-2", "notes.md"],
    ]);
    // The image's own lightbox never opened.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("header Copy / Download", () => {
  const md = inline({ filename: "notes.md", kind: "markdown", content: "# Title\n\n**bold**" });

  function stubClipboard(writeText: (t: string) => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(writeText) },
      configurable: true,
    });
    return navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
  }

  afterEach(() => {
    // jsdom has no clipboard; drop any stub so tests stay independent.
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it("copies the markdown SOURCE, not the rendered text, and confirms", async () => {
    const write = stubClipboard(() => Promise.resolve());
    render(<SentFileBlock file={md} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy notes.md" }));
    expect(write).toHaveBeenCalledWith("# Title\n\n**bold**");
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("does not collapse the file when an action is clicked", () => {
    stubClipboard(() => Promise.resolve());
    render(<SentFileBlock file={md} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy notes.md" }));
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });

  it("still copies while collapsed", () => {
    const write = stubClipboard(() => Promise.resolve());
    render(<SentFileBlock file={md} />);
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    fireEvent.click(screen.getByRole("button", { name: "Copy notes.md" }));
    expect(write).toHaveBeenCalledWith("# Title\n\n**bold**");
  });

  it("reports a refused clipboard write instead of claiming success", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    render(<SentFileBlock file={md} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy notes.md" }));
    expect(await screen.findByText("Couldn't copy")).toBeInTheDocument();
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  it("reports failure when there is no clipboard API (insecure context)", async () => {
    render(<SentFileBlock file={md} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy notes.md" }));
    expect(await screen.findByText("Couldn't copy")).toBeInTheDocument();
  });

  it("copies a file source's fetched text, and is disabled until it loads", async () => {
    let resolve!: (r: Response) => void;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    const write = stubClipboard(() => Promise.resolve());
    render(
      <SentFileBlock
        file={{ filename: "a.md", kind: "markdown", source: "file", rawUrl: "/api/chat-files/a" }}
      />,
    );
    const copy = screen.getByRole("button", { name: "Copy a.md" });
    expect(copy).toBeDisabled();
    resolve(new Response("fetched *md*", { status: 200 }));
    await waitFor(() => expect(copy).toBeEnabled());
    fireEvent.click(copy);
    expect(write).toHaveBeenCalledWith("fetched *md*");
    // One fetch serves both the preview and Copy.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps Copy disabled when a file source fails to load", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    render(
      <SentFileBlock
        file={{ filename: "a.md", kind: "markdown", source: "file", rawUrl: "/api/chat-files/a" }}
      />,
    );
    expect(await screen.findByText("Could not load this file.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy a.md" })).toBeDisabled();
  });

  it("links a file source's Download straight at its rawUrl", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { status: 200 }));
    render(
      <SentFileBlock
        file={{ filename: "a.md", kind: "markdown", source: "file", rawUrl: "/api/chat-files/a" }}
      />,
    );
    const link = screen.getByRole("link", { name: "Download a.md" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/chat-files/a");
    expect(link.getAttribute("download")).toBe("a.md");
  });

  it("downloads inline content as a named Blob with a kind-appropriate type", async () => {
    let blob: Blob | undefined;
    const create = vi.fn((b: Blob) => ((blob = b), "blob:x"));
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe("notes.md");
      expect(this.getAttribute("href")).toBe("blob:x");
    });
    render(<SentFileBlock file={md} />);
    fireEvent.click(screen.getByRole("button", { name: "Download notes.md" }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(blob?.type).toBe("text/markdown;charset=utf-8");
    // jsdom's Blob has no .text(); read it the way it does support.
    const body = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsText(blob!);
    });
    expect(body).toBe("# Title\n\n**bold**");
  });

  it("offers Download but no Copy on a video; neither in the header of an image or PDF", () => {
    const { unmount } = render(
      <SentFileBlock file={{ filename: "v.mp4", kind: "video", source: "file", rawUrl: "/api/chat-files/v" }} />,
    );
    // The header link, distinct from the <video>'s own can't-play fallback link.
    const header = screen.getByTitle("Download") as HTMLAnchorElement;
    expect(header).toHaveAccessibleName("Download v.mp4");
    expect(header.getAttribute("href")).toBe("/api/chat-files/v");
    expect(screen.queryByRole("button", { name: /^Copy/ })).not.toBeInTheDocument();
    unmount();
    // Image and PDF keep exactly the one Download their overlay already had.
    render(
      <>
        <SentFileBlock file={{ filename: "p.png", kind: "image", source: "file", rawUrl: "/api/chat-files/p" }} />
        <SentFileBlock file={{ filename: "r.pdf", kind: "pdf", source: "file", rawUrl: "/api/chat-files/r" }} />
      </>,
    );
    expect(screen.getAllByRole("link", { name: /download p\.png/i })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: /download r\.pdf/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Copy/ })).not.toBeInTheDocument();
  });
});
