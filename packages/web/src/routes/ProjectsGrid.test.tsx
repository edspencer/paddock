import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ProjectsGrid } from "./ProjectsGrid";
import { makeProject, makeChat } from "../test/factories";
import type { Project } from "../lib/types";

// --- mocks -----------------------------------------------------------------
// The grid reads the project list from context and lazily fetches per-project
// chat counts + the scratch inbox. Mock both so the test is deterministic and
// offline.
let mockProjects: Project[] = [];
vi.mock("../lib/projects-context", () => ({
  useProjects: () => ({
    projects: mockProjects,
    loading: false,
    error: null,
    refresh: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
  }),
}));

const listProjectChats = vi.fn();
const listScratchChats = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      listProjectChats: (...a: unknown[]) => listProjectChats(...a),
      listScratchChats: (...a: unknown[]) => listScratchChats(...a),
    },
  };
});

function renderGrid(filterTag?: string) {
  return render(
    <MemoryRouter>
      <ProjectsGrid filterTag={filterTag} />
    </MemoryRouter>,
  );
}

describe("ProjectsGrid: area sectioning", () => {
  beforeEach(() => {
    listProjectChats.mockReset().mockResolvedValue([]);
    listScratchChats.mockReset().mockResolvedValue([]);
  });

  it("groups projects into ordered area sections: canonical, custom, then Unsorted", async () => {
    mockProjects = [
      makeProject({ slug: "a", name: "A", group: "side-projects" }),
      makeProject({ slug: "b", name: "B", group: "homelab" }),
      makeProject({ slug: "c", name: "C", group: "" }), // Unsorted
      makeProject({ slug: "d", name: "D", group: "garage" }), // custom
      makeProject({ slug: "e", name: "E", group: "homelab" }),
    ];
    renderGrid();

    // Section headings are <h2> inside the collapsible buttons.
    const headings = screen.getAllByRole("heading", { level: 2 });
    const labels = headings.map((h) => h.textContent);
    // Homelab (canonical, 1st) → Side Projects (canonical) → Garage (custom) →
    // Unsorted (last). House is absent (no projects) so it does not appear.
    const ordered = labels.filter((l) =>
      ["Homelab", "House", "Side Projects", "Garage", "Unsorted", "Inbox"].includes(l ?? ""),
    );
    expect(ordered).toEqual(["Homelab", "Side Projects", "Garage", "Unsorted"]);
  });

  it("shows the per-area project count", () => {
    mockProjects = [
      makeProject({ slug: "b1", group: "homelab" }),
      makeProject({ slug: "b2", group: "homelab" }),
      makeProject({ slug: "h1", group: "house" }),
    ];
    renderGrid();

    const homelabBtn = screen.getByRole("button", { name: /Homelab/ });
    expect(within(homelabBtn).getByText("2")).toBeInTheDocument();
    const houseBtn = screen.getByRole("button", { name: /House/ });
    expect(within(houseBtn).getByText("1")).toBeInTheDocument();
  });

  it("collapses a section and hides its cards (persisting to localStorage)", async () => {
    localStorage.clear();
    mockProjects = [makeProject({ slug: "vis", name: "Visible One", group: "homelab" })];
    renderGrid();

    expect(screen.getByText("Visible One")).toBeInTheDocument();
    const homelabBtn = screen.getByRole("button", { name: /Homelab/ });
    expect(homelabBtn).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(homelabBtn);
    expect(homelabBtn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Visible One")).not.toBeInTheDocument();
    expect(localStorage.getItem("paddock:area-collapsed:homelab")).toBe("1");
  });

  it("renders an Inbox section for one-off chats", async () => {
    mockProjects = [makeProject({ slug: "p", group: "homelab" })];
    listScratchChats.mockResolvedValue([makeChat({ sessionId: "s1", name: "Loose chat" })]);
    renderGrid();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Inbox/ })).toBeInTheDocument(),
    );
    expect(screen.getByText("Loose chat")).toBeInTheDocument();
  });
});

describe("ProjectsGrid: tag filter mode", () => {
  beforeEach(() => {
    listProjectChats.mockReset().mockResolvedValue([]);
    listScratchChats.mockReset().mockResolvedValue([]);
  });

  it("shows a flat grid of only matching projects and no area headers", () => {
    mockProjects = [
      makeProject({ slug: "m1", name: "Match One", domain: ["plumbing"], group: "homelab" }),
      makeProject({ slug: "m2", name: "No Match", domain: ["electrics"], group: "house" }),
    ];
    renderGrid("plumbing");

    expect(screen.getByText("Match One")).toBeInTheDocument();
    expect(screen.queryByText("No Match")).not.toBeInTheDocument();
    // No area section headings in filter mode.
    expect(screen.queryByRole("button", { name: /^Homelab/ })).not.toBeInTheDocument();
  });
});
