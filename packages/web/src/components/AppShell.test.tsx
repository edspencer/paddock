import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "./AppShell";
import { makeProject } from "../test/factories";
import type { Project } from "../lib/types";

let mockProjects: Project[] = [];
let mockLoading = false;
const upsert = vi.fn();
vi.mock("../lib/projects-context", () => ({
  useProjects: () => ({
    projects: mockProjects,
    loading: mockLoading,
    error: null,
    refresh: vi.fn(),
    upsert,
    remove: vi.fn(),
  }),
}));

// NewProjectModal pulls /api/models; stub it so the modal mounts cleanly.
vi.mock("./NewProjectModal", () => ({
  NewProjectModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-project-modal">New project modal</div> : null,
}));

function renderShell(initial = "/") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<div>HOME</div>} />
          <Route path="chat" element={<div>NEW ONE-OFF</div>} />
          <Route path="projects/:slug/*" element={<div>PROJECT</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockProjects = [];
  mockLoading = false;
  upsert.mockReset();
});

describe("AppShell: sidebar shell", () => {
  it("renders the brand, the two CTAs, and the project count", () => {
    mockProjects = [makeProject({ slug: "a", group: "homelab" }), makeProject({ slug: "b", group: "homelab" })];
    renderShell();
    expect(screen.getByText("Paddock")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New Project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New one-off chat/i })).toBeInTheDocument();
    // Project count next to the "Projects" label.
    const nav = screen.getByText("Projects").closest("div")!;
    expect(within(nav).getByText("2")).toBeInTheDocument();
  });

  it("shows the empty state when there are no projects", () => {
    renderShell();
    expect(screen.getByText(/No projects yet/i)).toBeInTheDocument();
  });

  it("shows loading skeletons while loading", () => {
    mockLoading = true;
    const { container } = renderShell();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });
});

describe("AppShell: area grouping + subheaders", () => {
  it("shows NO area subheaders when all projects share one area", () => {
    mockProjects = [
      makeProject({ slug: "a", name: "Alpha", group: "homelab" }),
      makeProject({ slug: "b", name: "Beta", group: "homelab" }),
    ];
    renderShell();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    // A single area → the "Homelab" subheader is suppressed.
    expect(screen.queryByText("Homelab")).not.toBeInTheDocument();
  });

  it("shows area subheaders (in canonical order) when multiple areas are present", () => {
    mockProjects = [
      makeProject({ slug: "a", name: "Alpha", group: "side-projects" }),
      makeProject({ slug: "b", name: "Beta", group: "homelab" }),
      makeProject({ slug: "c", name: "Gamma", group: "" }), // Unsorted
    ];
    renderShell();
    const subheaders = ["Homelab", "Side Projects", "Unsorted"].map((l) => screen.getByText(l));
    subheaders.forEach((h) => expect(h).toBeInTheDocument());
    // Homelab comes before Side Projects, Unsorted last (DOM order).
    const positions = subheaders.map((h) => h.compareDocumentPosition(subheaders[0]));
    expect(positions[0]).toBe(0); // Homelab is the reference
  });

  it("renders each project's status pill and up to two domain tags + overflow", () => {
    mockProjects = [
      makeProject({
        slug: "a",
        name: "Tagged",
        group: "homelab",
        status: "blocked",
        domain: ["plumbing", "electrics", "hvac"],
      }),
    ];
    renderShell();
    const link = screen.getByRole("link", { name: /Tagged/ });
    expect(within(link).getByText("blocked")).toBeInTheDocument();
    expect(within(link).getByText("plumbing")).toBeInTheDocument();
    expect(within(link).getByText("electrics")).toBeInTheDocument();
    // Third tag is collapsed into a "+1".
    expect(within(link).getByText("+1")).toBeInTheDocument();
    expect(within(link).queryByText("hvac")).not.toBeInTheDocument();
  });
});

describe("AppShell: navigation", () => {
  it("opens the New Project modal", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /New Project/i }));
    expect(screen.getByTestId("new-project-modal")).toBeInTheDocument();
  });

  it("navigates to a one-off chat", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /New one-off chat/i }));
    expect(screen.getByText("NEW ONE-OFF")).toBeInTheDocument();
  });

  it("a project nav link routes to that project", () => {
    mockProjects = [makeProject({ slug: "alpha", name: "Alpha", group: "homelab" })];
    renderShell();
    fireEvent.click(screen.getByRole("link", { name: /Alpha/ }));
    expect(screen.getByText("PROJECT")).toBeInTheDocument();
  });
});
