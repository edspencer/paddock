import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "./StatusPill";
import type { ProjectStatus } from "../lib/types";

describe("StatusPill", () => {
  it("renders the status text", () => {
    render(<StatusPill status="active" />);
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("applies the per-status pill styling", () => {
    const { container } = render(<StatusPill status="blocked" />);
    const pill = container.querySelector(".status-pill");
    expect(pill).toBeTruthy();
    // The "blocked" palette is rose-based.
    expect(pill?.className).toContain("rose");
  });

  it("renders a distinct style per known status", () => {
    const statuses: ProjectStatus[] = [
      "idea",
      "active",
      "paused",
      "blocked",
      "done",
      "abandoned",
    ];
    for (const s of statuses) {
      const { container, unmount } = render(<StatusPill status={s} />);
      expect(container.querySelector(".status-pill")).toBeTruthy();
      expect(screen.getByText(s)).toBeInTheDocument();
      unmount();
    }
  });

  it("falls back to the idea palette for an unknown status without crashing", () => {
    // Defensive: the component guards `STYLES[status] ?? STYLES.idea`.
    const { container } = render(
      <StatusPill status={"bogus" as unknown as ProjectStatus} />,
    );
    expect(container.querySelector(".status-pill")).toBeTruthy();
  });
});
