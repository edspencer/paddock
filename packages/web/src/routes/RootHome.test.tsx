import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RootHome } from "./RootHome";

let empty: boolean | null = null;
vi.mock("../lib/useInstanceEmpty", () => ({ useInstanceEmpty: () => ({ empty, recheck: vi.fn() }) }));
vi.mock("../components/DiscoverView", () => ({
  DiscoverView: ({ firstRun }: { firstRun?: boolean }) => (
    <div data-testid="discover">{firstRun ? "first-run" : "page"}</div>
  ),
}));
vi.mock("./ProjectView", () => ({
  ProjectView: ({ root }: { root?: boolean }) => (
    <div data-testid="project-view">{root ? "root" : "project"}</div>
  ),
}));

function renderHome() {
  return render(
    <MemoryRouter>
      <RootHome />
    </MemoryRouter>,
  );
}

describe("RootHome", () => {
  beforeEach(() => {
    empty = null;
  });

  it("renders Discovery as Home when the instance is empty", () => {
    empty = true;
    renderHome();
    expect(screen.getByTestId("discover")).toHaveTextContent("first-run");
    expect(screen.queryByTestId("project-view")).not.toBeInTheDocument();
  });

  it("renders the ordinary root workspace once anything exists", () => {
    empty = false;
    renderHome();
    expect(screen.getByTestId("project-view")).toHaveTextContent("root");
    expect(screen.queryByTestId("discover")).not.toBeInTheDocument();
  });

  it("mounts NEITHER while the answer is still unknown", () => {
    // `ProjectView` opens sockets and fetches a workspace; mounting it for a beat
    // and then replacing it with a completely different screen is worse than a
    // blank moment, and the flash lands on the fresh install this is for.
    renderHome();
    expect(screen.queryByTestId("project-view")).not.toBeInTheDocument();
    expect(screen.queryByTestId("discover")).not.toBeInTheDocument();
  });
});
