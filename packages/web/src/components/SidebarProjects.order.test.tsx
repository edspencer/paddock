import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "./AppShell";
import { makeProject } from "../test/factories";
import { resetLastSeenForTests } from "../lib/lastSeen";
import type { ListOrder, Project } from "../lib/types";
import { fakeListLayout } from "../test/pointerEvent";

// The left nav project list's sort modes, rendered through the real AppShell
// with the same context/WS mocks SidebarProjects.test.tsx uses.

let mockProjects: Project[] = [];
const upsert = vi.fn();
vi.mock("../lib/projects-context", () => ({
  useProjects: () => ({
    projects: mockProjects,
    rootWorkspace: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    upsert,
    remove: vi.fn(),
  }),
}));

const getProjectOrder = vi.fn<() => Promise<ListOrder>>();
const patchProjectOrder = vi.fn();
const updateProject = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      listProjectChats: () => Promise.resolve([]),
      markChatSeen: vi.fn(),
      getProjectOrder: () => getProjectOrder(),
      patchProjectOrder: (...a: unknown[]) => patchProjectOrder(...a),
      updateProject: (...a: unknown[]) => updateProject(...a),
    },
  };
});

vi.mock("../lib/ws", () => ({
  chatClient: {
    onActiveInfos: (cb: (m: ReadonlyMap<string, string>) => void) => {
      cb(new Map());
      return () => {};
    },
    onActiveSessions: (cb: (s: ReadonlySet<string>) => void) => {
      cb(new Set());
      return () => {};
    },
    turnStartedAt: () => null,
  },
}));

const sidebar = () => within(screen.getByRole("complementary"));
/** Project names in render order, per area heading. */
const rowNames = () =>
  sidebar()
    .getAllByRole("link")
    .map((a) => a.querySelector("span.truncate")?.textContent)
    .filter((n): n is string => !!n);

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<div>HOME</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const turn = (at: string) => [{ sessionId: at, lastTurnCompletedAt: at }];

beforeEach(() => {
  localStorage.clear();
  resetLastSeenForTests();
  getProjectOrder.mockReset().mockResolvedValue({ mode: "recent", orders: {} });
  patchProjectOrder.mockReset().mockResolvedValue({});
  updateProject.mockReset();
  upsert.mockReset();
  mockProjects = [
    makeProject({
      slug: "a",
      name: "Alpha",
      group: "homelab",
      started: "2026-01-01",
      chatTurns: turn("2026-06-01T00:00:00Z"),
    }),
    makeProject({
      slug: "b",
      name: "Beta",
      group: "homelab",
      started: "2026-03-01",
      chatTurns: turn("2026-05-01T00:00:00Z"),
    }),
    makeProject({ slug: "u", name: "Loose", group: "", started: "2026-02-01" }),
  ];
});

describe("Sidebar project list: sort modes", () => {
  it("defaults to most recent reply within each area, areas in their fixed order", async () => {
    renderShell();
    await waitFor(() => expect(getProjectOrder).toHaveBeenCalled());
    expect(rowNames()).toEqual(["Alpha", "Beta", "Loose"]);
    expect(
      sidebar().getByRole("button", { name: "Sort projects (Most recent reply)" }),
    ).toBeTruthy();
  });

  it("switches to Created and persists the mode", async () => {
    renderShell();
    fireEvent.click(sidebar().getByRole("button", { name: /^Sort projects/ }));
    fireEvent.click(sidebar().getByRole("menuitemradio", { name: /^Created/ }));
    expect(rowNames()).toEqual(["Beta", "Alpha", "Loose"]);
    expect(patchProjectOrder).toHaveBeenCalledWith({ mode: "created" });
  });

  it("renders a persisted manual order on load", async () => {
    getProjectOrder.mockResolvedValue({ mode: "manual", orders: { homelab: ["b", "a"] } });
    renderShell();
    await waitFor(() => expect(rowNames()).toEqual(["Beta", "Alpha", "Loose"]));
  });

  it("switching to Manual seeds each area from its current order", async () => {
    renderShell();
    await waitFor(() => expect(getProjectOrder).toHaveBeenCalled());
    fireEvent.click(sidebar().getByRole("button", { name: /^Sort projects/ }));
    fireEvent.click(sidebar().getByRole("menuitemradio", { name: /^Manual/ }));
    expect(rowNames()).toEqual(["Alpha", "Beta", "Loose"]);
    expect(patchProjectOrder).toHaveBeenCalledWith({
      mode: "manual",
      orders: { homelab: ["a", "b"], "": ["u"] },
    });
  });

  it("rolls back and shows a toast when the save fails", async () => {
    patchProjectOrder.mockRejectedValue(new Error("server said no"));
    renderShell();
    await waitFor(() => expect(getProjectOrder).toHaveBeenCalled());
    fireEvent.click(sidebar().getByRole("button", { name: /^Sort projects/ }));
    fireEvent.click(sidebar().getByRole("menuitemradio", { name: /^Created/ }));
    await screen.findByText("server said no");
    expect(rowNames()).toEqual(["Alpha", "Beta", "Loose"]);
  });
});

describe("Sidebar project list: reordering by hand", () => {
  const mouse = { pointerType: "mouse", button: 0, pointerId: 1, clientX: 10 };
  const link = (name: string) => sidebar().getByRole("link", { name: new RegExp(name) });
  /** Give each row and heading a 40px slot: Homelab, Alpha, Beta, Unsorted, Loose. */
  const layout = () =>
    fakeListLayout(document.querySelectorAll<HTMLElement>("[data-reorder-id],[data-reorder-heading]"));
  const drag = (name: string, toY: number, fromY = 300) => {
    const el = link(name);
    fireEvent.pointerDown(el, { ...mouse, clientY: fromY });
    fireEvent.pointerMove(el, { ...mouse, clientY: toY });
    fireEvent.pointerUp(el, { ...mouse, clientY: toY });
    fireEvent.click(el);
  };

  it("reorders within an area, switching to Manual with the rest seeded", async () => {
    renderShell();
    await waitFor(() => expect(getProjectOrder).toHaveBeenCalled());
    layout();
    drag("Beta", 45); // upper half of Alpha
    expect(rowNames()).toEqual(["Beta", "Alpha", "Loose"]);
    expect(patchProjectOrder).toHaveBeenCalledWith({
      mode: "manual",
      orders: { homelab: ["b", "a"], "": ["u"] },
    });
    expect(updateProject).not.toHaveBeenCalled();
    // The click that ended the drag did not navigate.
    expect(screen.getByText("HOME")).toBeTruthy();
  });

  it("dropping on another area's heading moves the project there, at the top", async () => {
    updateProject.mockResolvedValue(makeProject({ slug: "a", name: "Alpha", group: "" }));
    renderShell();
    await waitFor(() => expect(getProjectOrder).toHaveBeenCalled());
    layout();
    drag("Alpha", 130); // the Unsorted heading
    expect(patchProjectOrder).toHaveBeenCalledWith({
      mode: "manual",
      orders: { homelab: ["b"], "": ["a", "u"] },
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ slug: "a", group: "" }));
    expect(updateProject).toHaveBeenCalledWith("a", { group: "" });
  });

  it("dropping among another area's rows places it at the drop position", async () => {
    updateProject.mockResolvedValue(makeProject({ slug: "u", name: "Loose", group: "homelab" }));
    renderShell();
    await waitFor(() => expect(getProjectOrder).toHaveBeenCalled());
    layout();
    drag("Loose", 85, 300); // upper half of Beta
    expect(patchProjectOrder).toHaveBeenCalledWith({
      mode: "manual",
      orders: { homelab: ["a", "u", "b"], "": [] },
    });
    expect(updateProject).toHaveBeenCalledWith("u", { group: "homelab" });
  });

  it("restores the project's area and says so when the move is refused", async () => {
    updateProject.mockRejectedValue(new Error("read-only project"));
    renderShell();
    await waitFor(() => expect(getProjectOrder).toHaveBeenCalled());
    layout();
    drag("Alpha", 130);
    await screen.findByText("read-only project");
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ slug: "a", group: "homelab" }),
    );
    // The order PATCH that went first is undone as well, back to Most recent reply.
    await waitFor(() =>
      expect(patchProjectOrder).toHaveBeenLastCalledWith({
        mode: "recent",
        orders: { homelab: null, "": null },
      }),
    );
  });

  it("Alt+ArrowDown moves the focused project one place down within its area", async () => {
    renderShell();
    await waitFor(() => expect(getProjectOrder).toHaveBeenCalled());
    fireEvent.keyDown(link("Alpha"), { key: "ArrowDown", altKey: true });
    expect(rowNames()).toEqual(["Beta", "Alpha", "Loose"]);
    // At the bottom of its area it goes no further.
    fireEvent.keyDown(link("Loose"), { key: "ArrowDown", altKey: true });
    expect(patchProjectOrder).toHaveBeenCalledTimes(1);
  });

  it("ignores a touch drag", async () => {
    renderShell();
    await waitFor(() => expect(getProjectOrder).toHaveBeenCalled());
    layout();
    const el = link("Beta");
    const touch = { ...mouse, pointerType: "touch" };
    fireEvent.pointerDown(el, { ...touch, clientY: 300 });
    fireEvent.pointerMove(el, { ...touch, clientY: 45 });
    fireEvent.pointerUp(el, { ...touch, clientY: 45 });
    expect(patchProjectOrder).not.toHaveBeenCalled();
  });
});
