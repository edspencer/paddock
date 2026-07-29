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

function renderEmbedded() {
  return render(
    <MemoryRouter>
      <ProjectsGrid embedded />
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

describe("ProjectsGrid: embedded as the first section of root Home", () => {
  beforeEach(() => {
    listProjectChats.mockReset().mockResolvedValue([]);
    listScratchChats.mockReset().mockResolvedValue([]);
    // Section collapse persists in localStorage — an earlier test collapses
    // Homelab, which would otherwise hide this suite's card.
    localStorage.clear();
    mockProjects = [makeProject({ slug: "a", name: "Alpha", group: "homelab" })];
  });

  it("drops its own page header — ProjectView already supplies the page chrome", () => {
    renderEmbedded();
    // No page title and no landing blurb: rendered inside ProjectView, the
    // workspace header above it is the title, so this would be a second one.
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText(/Each project is a directory/)).not.toBeInTheDocument();
    // The grid itself is unchanged.
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("carries a section heading in Home's own visual language", () => {
    // Home labels its sections with a small uppercase <h3> ("Chats", "Files",
    // "CHANGELOG.md"). Embedded, this is one of those sections, so it gets a
    // matching heading + count rather than the standalone page's <h1>.
    renderEmbedded();
    const heading = screen.getByRole("heading", { level: 2, name: /^Projects/ });
    expect(heading).toHaveTextContent("1");
  });

  it("contributes no scroll container of its own when embedded", () => {
    // The host pane owns the scrolling. A second scroller here would trap the
    // wheel inside the projects section and strand the rest of Home below it.
    const { container } = renderEmbedded();
    const root = container.querySelector("div")!;
    expect(root.className).not.toMatch(/overflow-y-auto/);
    expect(root.className).not.toMatch(/h-full/);
  });

  it("keeps New Project when embedded — it is the app's only one", () => {
    // Load-bearing: the sidebar CTA is gone, so losing this would leave no way
    // to create a project at all.
    renderEmbedded();
    expect(screen.getByRole("button", { name: /New Project/i })).toBeInTheDocument();
  });

  it("drops its 'New chat' action when embedded — Home's Chats section owns it", () => {
    // Both pointed at `/chat`, and embedded they land on the same screen. Two
    // identical buttons is worse than one, so the host's wins.
    renderEmbedded();
    expect(screen.queryByRole("button", { name: /New chat/i })).not.toBeInTheDocument();
    renderGrid();
    expect(screen.getByRole("button", { name: /New chat/i })).toBeInTheDocument();
  });

  it("still renders the full page header when NOT embedded", () => {
    renderGrid();
    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(screen.getByText(/Each project is a directory/)).toBeInTheDocument();
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
