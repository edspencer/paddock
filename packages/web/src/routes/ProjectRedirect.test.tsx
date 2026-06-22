import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProjectRedirect } from "./ProjectRedirect";
import { makeProject } from "../test/factories";
import { writeLastTab } from "../lib/lastTab";

const getProjectDetail = vi.fn();
const listProjectFiles = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      getProjectDetail: (...a: unknown[]) => getProjectDetail(...a),
      listProjectFiles: (...a: unknown[]) => listProjectFiles(...a),
    },
  };
});

function renderRedirect() {
  return render(
    <MemoryRouter initialEntries={["/projects/p"]}>
      <Routes>
        <Route path="/projects/:slug" element={<ProjectRedirect />} />
        {/* Catch-all destinations so we can read where it redirected to. */}
        <Route path="/projects/:slug/*" element={<DestProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function DestProbe() {
  return <div data-testid="dest">{window.location.pathname}</div>;
}

beforeEach(() => {
  localStorage.clear();
  getProjectDetail.mockReset().mockResolvedValue({ project: makeProject({ slug: "p", pinned: [] }), changelog: "", chats: [] });
  listProjectFiles.mockReset().mockResolvedValue([]);
});

describe("ProjectRedirect", () => {
  it("defaults to the chat tab when nothing is stored (no fetch)", async () => {
    renderRedirect();
    await waitFor(() => expect(screen.getByTestId("dest")).toBeInTheDocument());
    // No validation fetch needed for the default.
    expect(getProjectDetail).not.toHaveBeenCalled();
  });

  it("restores a stored chat sub-path without validation", async () => {
    writeLastTab("p", "chat/sess-1");
    renderRedirect();
    await waitFor(() => expect(screen.getByTestId("dest")).toBeInTheDocument());
    expect(getProjectDetail).not.toHaveBeenCalled();
  });

  it("restores a stored files tab when the file still exists", async () => {
    writeLastTab("p", "files/page.html");
    listProjectFiles.mockResolvedValue(["page.html"]);
    renderRedirect();
    await waitFor(() => expect(listProjectFiles).toHaveBeenCalledWith("p"));
    await waitFor(() => expect(screen.getByTestId("dest")).toBeInTheDocument());
  });

  it("falls back when the stored file is gone (validated against project state)", async () => {
    writeLastTab("p", "files/deleted.html");
    listProjectFiles.mockResolvedValue(["other.md"]);
    getProjectDetail.mockResolvedValue({ project: makeProject({ slug: "p", pinned: [] }), changelog: "", chats: [] });
    renderRedirect();
    // It fetches the pinned + files lists to validate.
    await waitFor(() => expect(getProjectDetail).toHaveBeenCalled());
    await waitFor(() => expect(listProjectFiles).toHaveBeenCalled());
  });
});
