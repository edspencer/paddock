import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TagPill } from "./TagPill";

function renderTag(tag: string) {
  return render(
    <MemoryRouter>
      <TagPill tag={tag} />
    </MemoryRouter>,
  );
}

describe("TagPill", () => {
  it("renders the tag text", () => {
    renderTag("plumbing");
    expect(screen.getByText("plumbing")).toBeInTheDocument();
  });

  it("links to the /tags/:tag filter route (URL-encoded)", () => {
    renderTag("home automation");
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/tags/home%20automation");
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
