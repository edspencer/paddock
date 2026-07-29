import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { ProjectsProvider, useProjects } from "./projects-context";
import { makeProject } from "../test/factories";

const listProjects = vi.fn();
const getRootWorkspace = vi.fn();
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    api: {
      listProjects: (...a: unknown[]) => listProjects(...a),
      getRootWorkspace: (...a: unknown[]) => getRootWorkspace(...a),
    },
  };
});

// A tiny probe component that surfaces the context for assertions + exposes the
// mutators on window so tests can drive upsert/remove/refresh.
function Probe() {
  const ctx = useProjects();
  (window as unknown as { __ctx: typeof ctx }).__ctx = ctx;
  return (
    <div>
      <span data-testid="loading">{String(ctx.loading)}</span>
      <span data-testid="error">{ctx.error ?? ""}</span>
      <ul>
        {ctx.projects.map((p) => (
          <li key={p.slug}>{p.slug}</li>
        ))}
      </ul>
    </div>
  );
}

function ctx() {
  return (window as unknown as { __ctx: ReturnType<typeof useProjects> }).__ctx;
}

beforeEach(() => {
  listProjects.mockReset();
  // The root workspace is the instance's own directory, so it ALWAYS resolves —
  // that is the default everywhere (#516). Its key is the empty string.
  getRootWorkspace.mockReset();
  getRootWorkspace.mockResolvedValue(makeProject({ slug: "", name: "Instance Root" }));
});

describe("ProjectsProvider", () => {
  it("loads projects on mount and clears the loading flag", async () => {
    listProjects.mockResolvedValue([makeProject({ slug: "a" }), makeProject({ slug: "b" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    expect(screen.getByTestId("loading")).toHaveTextContent("true");
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("surfaces a load error and stops loading", async () => {
    listProjects.mockRejectedValue(new Error("nope"));
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("nope"));
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("upsert inserts a new project at the front and replaces an existing one", async () => {
    listProjects.mockResolvedValue([makeProject({ slug: "a", name: "A" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());

    act(() => ctx().upsert(makeProject({ slug: "b", name: "B" })));
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["b", "a"]); // new one prepended

    // Upserting an existing slug replaces (no dupe), moving it to the front.
    act(() => ctx().upsert(makeProject({ slug: "a", name: "A2" })));
    const after = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(after).toEqual(["a", "b"]);
  });

  it("remove drops a project locally", async () => {
    listProjects.mockResolvedValue([makeProject({ slug: "a" }), makeProject({ slug: "b" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    act(() => ctx().remove("a"));
    expect(screen.queryByText("a")).not.toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("refresh re-fetches the list", async () => {
    listProjects.mockResolvedValueOnce([makeProject({ slug: "a" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    listProjects.mockResolvedValueOnce([makeProject({ slug: "c" })]);
    await act(async () => {
      await ctx().refresh();
    });
    expect(screen.getByText("c")).toBeInTheDocument();
    expect(screen.queryByText("a")).not.toBeInTheDocument();
  });

  it("useProjects throws when used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used within ProjectsProvider/);
    spy.mockRestore();
  });
});

describe("ProjectsProvider — the root workspace (#516)", () => {
  it("exposes the root workspace separately, never inside `projects`", async () => {
    listProjects.mockResolvedValue([makeProject({ slug: "a" })]);
    getRootWorkspace.mockResolvedValue(makeProject({ slug: "", name: "Root" }));
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(ctx().rootWorkspace).not.toBeNull());
    expect(ctx().rootWorkspace?.slug).toBe("");
    // `GET /api/projects` enumerates the root's CHILDREN, so the root itself is
    // absent from it — and must stay out of the sidebar + grid, which render
    // `projects`.
    expect(ctx().projects.map((p) => p.slug)).toEqual(["a"]);
  });

  it("routes an upsert of the root workspace to `rootWorkspace`, not the list", async () => {
    listProjects.mockResolvedValue([makeProject({ slug: "a" })]);
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(ctx().rootWorkspace?.name).toBe("Instance Root"));
    act(() => ctx().upsert(makeProject({ slug: "", name: "Renamed Root" })));
    expect(ctx().rootWorkspace?.name).toBe("Renamed Root");
    expect(ctx().projects.map((p) => p.slug)).toEqual(["a"]);
  });

  it("leaves the root null when its fetch fails, without failing the page", async () => {
    listProjects.mockResolvedValue([]);
    getRootWorkspace.mockRejectedValue(new Error("boom"));
    render(
      <ProjectsProvider>
        <Probe />
      </ProjectsProvider>,
    );
    await waitFor(() => expect(ctx().loading).toBe(false));
    expect(ctx().rootWorkspace).toBeNull();
    // A failed root fetch is NOT a page-level error — the children list it rode
    // along with is still good, so the grid and sidebar keep rendering.
    expect(ctx().error).toBeNull();
  });
});
