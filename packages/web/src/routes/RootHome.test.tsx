import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RootHome } from "./RootHome";

let empty: boolean | null = null;
const recheck = vi.fn();
vi.mock("../lib/useInstanceEmpty", () => ({ useInstanceEmpty: () => ({ empty, recheck }) }));
vi.mock("../components/DiscoverView", () => ({
  DiscoverView: () => <div data-testid="discover">discover</div>,
}));
vi.mock("./ProjectView", () => ({
  ProjectView: ({
    root,
    instanceEmpty,
    onInstanceRecheck,
  }: {
    root?: boolean;
    instanceEmpty?: boolean | null;
    onInstanceRecheck?: () => void;
  }) => (
    <div data-testid="project-view" data-empty={String(instanceEmpty)}>
      {root ? "root" : "project"}
      <button type="button" onClick={() => onInstanceRecheck?.()}>
        recheck
      </button>
    </div>
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
    recheck.mockReset();
  });

  it("renders the root workspace even when the instance is EMPTY (#865)", () => {
    // The whole bug. `/` used to render Discovery INSTEAD of the workspace, and
    // on a machine with no Claude Code history Discovery has no button on it at
    // all — so the front door was a dead end. The workspace always renders now;
    // the first-run content is a section of its Home.
    empty = true;
    renderHome();
    expect(screen.getByTestId("project-view")).toHaveTextContent("root");
    expect(screen.queryByTestId("discover")).not.toBeInTheDocument();
  });

  it("renders the ordinary root workspace once anything exists", () => {
    empty = false;
    renderHome();
    expect(screen.getByTestId("project-view")).toHaveTextContent("root");
  });

  it("mounts the workspace IMMEDIATELY, before the answer is known", () => {
    // Was: mount neither, to avoid flashing one screen and replacing it with a
    // different one. There is only one screen now, so waiting buys nothing and
    // costs a blank front door on exactly the fresh install this is for.
    renderHome();
    expect(screen.getByTestId("project-view")).toBeInTheDocument();
  });

  it("forwards the tri-state rather than collapsing unknown into 'not empty'", () => {
    // `null` is not `false`: Home holds back the one slot that depends on the
    // answer instead of rendering the wrong thing for a frame.
    renderHome();
    expect(screen.getByTestId("project-view")).toHaveAttribute("data-empty", "null");
    expect(recheck).not.toHaveBeenCalled();
  });

  it("gives Home a way to make the instance re-ask (#808)", () => {
    // Adopting is precisely what stops the instance being empty, and the latch
    // in `useInstanceEmpty` means nothing re-asks until something says so.
    empty = true;
    renderHome();
    screen.getByRole("button", { name: "recheck" }).click();
    expect(recheck).toHaveBeenCalled();
  });
});
