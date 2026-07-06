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
});
