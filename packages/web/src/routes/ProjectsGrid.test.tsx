import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ProjectsGrid } from "./ProjectsGrid";
import { makeProject, makeChat } from "../test/factories";
import type { Project } from "../lib/types";

// --- mocks -----------------------------------------------------------------
// The grid reads the project list from context and lazily fetches per-project
// chat counts. Mock both so the test is deterministic and offline.
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
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      listProjectChats: (...a: unknown[]) => listProjectChats(...a),
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
      ["Homelab", "House", "Side Projects", "Garage", "Unsorted"].includes(l ?? ""),
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

  it("flags a project with uncommitted changes and leaves a clean one unflagged (#258)", () => {
    mockProjects = [
      makeProject({ slug: "d", name: "Dirty One", group: "homelab", dirty: 4 }),
      makeProject({ slug: "c", name: "Clean One", group: "homelab", dirty: 0 }),
    ];
    renderGrid();
    const chip = screen.getByTitle(/4 uncommitted changes/i);
    expect(chip).toHaveTextContent("4");
    // The clean project has no dirty chip.
    expect(screen.queryByTitle(/uncommitted change/i)).toBe(chip);
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

});

/**
 * The grid is standalone-only again (#599). It briefly had an `embedded` mode
 * that rendered it as the first section of root Home; Home now opens on the
 * running/unread feeds instead, so the mode — and the tests that pinned its
 * header/scroller/action differences — went with it. `/tags/:tag` is the only
 * caller left, so what matters here is that the full page chrome is back
 * unconditionally.
 */
describe("ProjectsGrid: the standalone page", () => {
  beforeEach(() => {
    listProjectChats.mockReset().mockResolvedValue([]);
    // Section collapse persists in localStorage — an earlier test collapses
    // Homelab, which would otherwise hide this suite's card.
    localStorage.clear();
    mockProjects = [makeProject({ slug: "a", name: "Alpha", group: "homelab" })];
  });

  it("renders the page header, the blurb and its own scroll container", () => {
    const { container } = renderGrid();
    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(screen.getByText(/Each project is a directory/)).toBeInTheDocument();
    expect(container.querySelector("div")!.className).toMatch(/overflow-y-auto/);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("keeps both page actions — New chat and New Project", () => {
    renderGrid();
    expect(screen.getByRole("button", { name: /New chat/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New Project/i })).toBeInTheDocument();
  });
});

describe("ProjectsGrid: tag filter mode", () => {
  beforeEach(() => {
    listProjectChats.mockReset().mockResolvedValue([]);
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
