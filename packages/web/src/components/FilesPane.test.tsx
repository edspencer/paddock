import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { FilesPane } from "./FilesPane";
import { ApiError } from "../lib/api";
import type { FileEntry } from "../lib/types";
import { makeProject } from "../test/factories";

// FileView fetches a file; stub it to a marker echoing the requested path so we
// can assert the browser drops into the viewer for a file path.
vi.mock("./FileView", () => ({
  FileView: ({ name }: { name: string }) => <div data-testid="file-view">file: {name}</div>,
}));

const listProjectDir = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: { listProjectDir: (...a: unknown[]) => listProjectDir(...a) },
  };
});

/**
 * Serve directory listings from a map; any path NOT in the map is treated as a
 * file (`kind: "file"`), exactly like the server, so the browser drops into the
 * file viewer for that path.
 */
function setDir(dirs: Record<string, FileEntry[]>) {
  listProjectDir.mockImplementation((_slug: string, subpath = "") =>
    subpath in dirs
      ? Promise.resolve({ path: subpath, kind: "dir", entries: dirs[subpath] })
      : Promise.resolve({ path: subpath, kind: "file", entries: [] }),
  );
}

const project = makeProject({ slug: "p", pinned: [] });
const onNavigate = vi.fn();
const onTogglePin = vi.fn();

beforeEach(() => {
  listProjectDir.mockReset();
  onNavigate.mockReset();
  onTogglePin.mockReset();
});

function renderPane(path: string) {
  return render(
    <FilesPane project={project} path={path} onNavigate={onNavigate} onTogglePin={onTogglePin} />,
  );
}

describe("FilesPane (#259)", () => {
  it("lists the root, directories first, with no '..' at the top", async () => {
    setDir({
      "": [
        { name: "design", kind: "dir" },
        { name: "OVERVIEW.md", kind: "file" },
      ],
    });
    renderPane("");
    expect(await screen.findByText("design")).toBeInTheDocument();
    expect(screen.getByText("OVERVIEW.md")).toBeInTheDocument();
    // At the root there's nothing to go up to.
    expect(screen.queryByText("..")).not.toBeInTheDocument();
  });

  it("navigates into a directory when its row is clicked", async () => {
    setDir({ "": [{ name: "design", kind: "dir" }] });
    renderPane("");
    fireEvent.click(await screen.findByText("design"));
    expect(onNavigate).toHaveBeenCalledWith("design");
  });

  it("opening a file row navigates to its full subpath", async () => {
    setDir({ design: [{ name: "plan.md", kind: "file" }] });
    renderPane("design");
    fireEvent.click(await screen.findByText("plan.md"));
    expect(onNavigate).toHaveBeenCalledWith("design/plan.md");
  });

  it("shows a '..' row when nested and it goes to the parent", async () => {
    setDir({ design: [{ name: "plan.md", kind: "file" }] });
    renderPane("design");
    const up = await screen.findByText("..");
    fireEvent.click(up);
    expect(onNavigate).toHaveBeenCalledWith("");
  });

  it("renders a breadcrumb whose crumbs navigate to their ancestor dirs", async () => {
    setDir({ "design/sub": [{ name: "deep.md", kind: "file" }] });
    renderPane("design/sub");
    const crumb = await screen.findByRole("navigation", { name: /File path/i });
    fireEvent.click(within(crumb).getByRole("button", { name: "design" }));
    expect(onNavigate).toHaveBeenCalledWith("design");
    fireEvent.click(within(crumb).getByRole("button", { name: "Files" }));
    expect(onNavigate).toHaveBeenCalledWith("");
  });

  it("falls back to the file viewer when the path is a file (not a directory)", async () => {
    setDir({ "": [{ name: "design", kind: "dir" }], design: [{ name: "plan.md", kind: "file" }] });
    renderPane("design/plan.md");
    expect(await screen.findByTestId("file-view")).toHaveTextContent("file: design/plan.md");
    // A nested file is pinnable too — the toggle carries its full subpath.
    fireEvent.click(screen.getByRole("button", { name: /Pin as tab/i }));
    expect(onTogglePin).toHaveBeenCalledWith("design/plan.md");
  });

  it("offers a Pin toggle for a top-level file in the viewer", async () => {
    // This path resolves to a file (kind: "file").
    listProjectDir.mockResolvedValue({ path: "page.html", kind: "file", entries: [] });
    renderPane("page.html");
    await screen.findByTestId("file-view");
    fireEvent.click(screen.getByRole("button", { name: /Pin as tab/i }));
    expect(onTogglePin).toHaveBeenCalledWith("page.html");
  });

  it("pins a top-level file from its list row", async () => {
    setDir({ "": [{ name: "page.html", kind: "file" }] });
    renderPane("");
    fireEvent.click(await screen.findByRole("button", { name: /^Pin page.html$/i }));
    expect(onTogglePin).toHaveBeenCalledWith("page.html");
  });

  it("pins a file inside a subdirectory from its list row (full subpath)", async () => {
    setDir({ design: [{ name: "plan.md", kind: "file" }] });
    renderPane("design");
    fireEvent.click(await screen.findByRole("button", { name: /^Pin plan.md$/i }));
    expect(onTogglePin).toHaveBeenCalledWith("design/plan.md");
  });

  it("surfaces a load error", async () => {
    listProjectDir.mockRejectedValue(new ApiError("boom", 500));
    renderPane("");
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("shows the empty-root hint when there are no files", async () => {
    setDir({ "": [] });
    renderPane("");
    expect(await screen.findByText(/No files yet/i)).toBeInTheDocument();
  });
});
