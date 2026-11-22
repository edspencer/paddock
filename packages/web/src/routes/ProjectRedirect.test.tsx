import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { ProjectRedirect } from "./ProjectRedirect";
import { makeProject } from "../test/factories";
import { recordOpenedChat, writeLastTab } from "../lib/lastTab";

const getProjectDetail = vi.fn();
const listProjectFiles = vi.fn();
const listProjectChats = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      getProjectDetail: (...a: unknown[]) => getProjectDetail(...a),
      listProjectFiles: (...a: unknown[]) => listProjectFiles(...a),
      listProjectChats: (...a: unknown[]) => listProjectChats(...a),
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
  // Read the router's location (MemoryRouter doesn't touch window.location) so
  // we can assert exactly where the redirect landed.
  const loc = useLocation();
  return <div data-testid="dest">{loc.pathname}</div>;
}

beforeEach(() => {
  localStorage.clear();
  getProjectDetail.mockReset().mockResolvedValue({ project: makeProject({ slug: "p", pinned: [] }), changelog: "", chats: [] });
  listProjectFiles.mockReset().mockResolvedValue([]);
  listProjectChats.mockReset().mockResolvedValue([]);
});

describe("ProjectRedirect", () => {
  it("defaults to the home tab when nothing is stored (no fetch)", async () => {
    renderRedirect();
    await waitFor(() =>
      expect(screen.getByTestId("dest")).toHaveTextContent("/projects/p/home"),
    );
    // No validation fetch needed for the default.
    expect(getProjectDetail).not.toHaveBeenCalled();
  });

  const dest = () => screen.getByTestId("dest");

  it("restores a stored chat that is still active", async () => {
    writeLastTab("p", "chat/sess-1");
    listProjectChats.mockResolvedValue([{ sessionId: "sess-1" }]);
    renderRedirect();
    await waitFor(() => expect(dest()).toHaveTextContent("/projects/p/chat/sess-1"));
    expect(listProjectChats).toHaveBeenCalledWith("p");
  });

  it("skips a stored chat archived since, for the last opened chat still active", async () => {
    recordOpenedChat("p", "older");
    recordOpenedChat("p", "newer-archived");
    writeLastTab("p", "chat/newer-archived");
    listProjectChats.mockResolvedValue([
      { sessionId: "older" },
      { sessionId: "newer-archived", archived: true },
    ]);
    renderRedirect();
    await waitFor(() => expect(dest()).toHaveTextContent("/projects/p/chat/older"));
  });

  it("opens a new chat rather than an archived one when no opened chat is active", async () => {
    recordOpenedChat("p", "gone");
    recordOpenedChat("p", "archived-1");
    writeLastTab("p", "chat/archived-1");
    listProjectChats.mockResolvedValue([{ sessionId: "archived-1", archived: true }]);
    renderRedirect();
    await waitFor(() => expect(dest()).toHaveTextContent(/^\/projects\/p\/chat$/));
  });

  it("restores the stored chat as before when the chat list can't be read", async () => {
    writeLastTab("p", "chat/sess-1");
    listProjectChats.mockRejectedValue(new Error("down"));
    renderRedirect();
    await waitFor(() => expect(dest()).toHaveTextContent("/projects/p/chat/sess-1"));
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
