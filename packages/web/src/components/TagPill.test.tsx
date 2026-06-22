import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { TagPill } from "./TagPill";

function renderTag(tag: string) {
  return render(
    <MemoryRouter>
      <TagPill tag={tag} />
    </MemoryRouter>,
  );
}

/** Surfaces the current location so we can assert navigation. */
function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="loc">{loc.pathname}</span>;
}

describe("TagPill", () => {
  it("renders the tag text", () => {
    renderTag("plumbing");
    expect(screen.getByText("plumbing")).toBeInTheDocument();
  });

  it("renders as a button (NOT an anchor) so it's valid nested inside link cards (issue #22)", () => {
    renderTag("plumbing");
    expect(screen.getByRole("button", { name: "plumbing" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("navigates to the /tags/:tag filter route (URL-encoded) on click", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <TagPill tag="home automation" />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "home automation" }));
    expect(screen.getByTestId("loc")).toHaveTextContent("/tags/home%20automation");
  });

  it("stops click propagation so a card link isn't also triggered", () => {
    const onParentClick = vi.fn();
    render(
      <MemoryRouter>
        <div onClick={onParentClick}>
          <TagPill tag="x" />
        </div>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("x"));
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("merges a passed className", () => {
    render(
      <MemoryRouter>
        <TagPill tag="x" className="max-w-[10rem]" />
      </MemoryRouter>,
    );
    expect(screen.getByText("x").className).toContain("max-w-[10rem]");
  });
});
