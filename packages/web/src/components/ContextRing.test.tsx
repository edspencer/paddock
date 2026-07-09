import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ContextRing } from "./ContextRing";

const C = 2 * Math.PI * 8; // circumference of the r=8 ring

describe("ContextRing", () => {
  it("renders nothing without usage data", () => {
    const { container: a } = render(<ContextRing />);
    expect(a.querySelector("svg")).toBeNull();
    const { container: b } = render(<ContextRing tokens={100} />);
    expect(b.querySelector("svg")).toBeNull();
    const { container: c } = render(<ContextRing tokens={100} limit={0} />);
    expect(c.querySelector("svg")).toBeNull();
  });

  it("fills the arc proportionally to the usage percentage", () => {
    const { container } = render(<ContextRing tokens={250_000} limit={1_000_000} />);
    const arc = container.querySelectorAll("circle")[1];
    // 25% of the circumference filled.
    expect(arc.getAttribute("stroke-dasharray")).toBe(`${(25 / 100) * C} ${C}`);
    // Below the 80% threshold → accent, not amber.
    expect(arc.getAttribute("class")).toContain("stroke-accent");
  });

  it("turns amber at or above 80% full", () => {
    const { container } = render(<ContextRing tokens={850_000} limit={1_000_000} />);
    const arc = container.querySelectorAll("circle")[1];
    expect(arc.getAttribute("class")).toContain("stroke-amber-500");
  });

  it("clamps an over-limit usage to a full ring", () => {
    const { container } = render(<ContextRing tokens={2_000_000} limit={1_000_000} />);
    const arc = container.querySelectorAll("circle")[1];
    expect(arc.getAttribute("stroke-dasharray")).toBe(`${C} ${C}`);
  });

  it("exposes an accessible percentage label", () => {
    const { getByLabelText } = render(<ContextRing tokens={500_000} limit={1_000_000} />);
    expect(getByLabelText(/Context 50% full/i)).toBeInTheDocument();
  });

  it("renders an indeterminate spinner while working without usage data", () => {
    const { container, getByLabelText } = render(<ContextRing working />);
    const svg = container.querySelector("svg")!;
    // Still renders (unlike the idle no-usage case) and spins.
    expect(svg).not.toBeNull();
    expect(svg.getAttribute("class")).toContain("animate-spin");
    // A fixed quarter-arc stands in for the missing fill level.
    const arc = container.querySelectorAll("circle")[1];
    expect(arc.getAttribute("stroke-dasharray")).toBe(`${0.25 * C} ${C}`);
    expect(getByLabelText(/Streaming a response/i)).toBeInTheDocument();
  });

  it("spins while keeping the fill arc when working with usage data", () => {
    const { container, getByLabelText } = render(
      <ContextRing tokens={250_000} limit={1_000_000} working />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("animate-spin");
    // Fill arc still reflects the real 25% usage.
    const arc = container.querySelectorAll("circle")[1];
    expect(arc.getAttribute("stroke-dasharray")).toBe(`${(25 / 100) * C} ${C}`);
    // Label surfaces both the streaming state and the fill level.
    expect(getByLabelText(/Streaming a response.*25% full/i)).toBeInTheDocument();
  });

  it("does not spin when idle", () => {
    const { container } = render(<ContextRing tokens={250_000} limit={1_000_000} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("class")).not.toContain("animate-spin");
  });
});
