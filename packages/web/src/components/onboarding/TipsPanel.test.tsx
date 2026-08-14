import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TipsPanel } from "./TipsPanel";
import type { Tip, WhatsNewEntry } from "../../lib/onboarding/types";

const tips: Tip[] = [
  { id: "t1", title: "Tip one", body: "First tip." },
  { id: "t2", title: "Tip two", body: "Second tip.", href: "https://example.test/two" },
  { id: "t3", title: "Tip three", body: "Third tip." },
];
const news: WhatsNewEntry[] = [
  { id: "n1", version: "0.71", title: "News one", body: "Landed.", href: "https://example.test/n1" },
  { id: "n2", version: "0.70", title: "News two", body: "Also landed.", href: "https://example.test/n2" },
];

/** Deterministic "randomness": a fixed sequence, so a test is never a coin toss. */
function rolls(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

describe("TipsPanel (#865)", () => {
  it("randomises BOTH the tab and the entry on mount", () => {
    // The whole feature: every landing on Home surfaces something different.
    // 0.6 of two tabs = What's New; 0.6 of its two entries = the second.
    render(<TipsPanel tips={tips} whatsNew={news} random={rolls(0.6, 0.6)} />);
    expect(screen.getByRole("tab", { name: /What's New/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("News two")).toBeInTheDocument();
  });

  it("lands on a different tab and entry for a different roll", () => {
    render(<TipsPanel tips={tips} whatsNew={news} random={rolls(0.1, 0.9)} />);
    expect(screen.getByRole("tab", { name: /Tips/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Tip three")).toBeInTheDocument();
  });

  it("never rolls past the end of a list", () => {
    // `Math.random()` is [0,1), but a sloppy `* length` rounds up at 0.999… on
    // some inputs; an out-of-range index renders a blank card.
    render(<TipsPanel tips={tips} whatsNew={news} random={rolls(0.999999, 0.999999)} />);
    expect(screen.getByText("News two")).toBeInTheDocument();
  });

  it("pages forward and back through a tab, wrapping at both ends", async () => {
    const user = userEvent.setup();
    render(<TipsPanel tips={tips} whatsNew={news} random={rolls(0, 0)} />);
    expect(screen.getByText("Tip one")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next Tips entry" }));
    expect(screen.getByText("Tip two")).toBeInTheDocument();

    // Backwards past the start wraps to the end rather than stranding the reader
    // on a dead arrow.
    await user.click(screen.getByRole("button", { name: "Previous Tips entry" }));
    await user.click(screen.getByRole("button", { name: "Previous Tips entry" }));
    expect(screen.getByText("Tip three")).toBeInTheDocument();
  });

  it("switches tabs and starts that tab at its first entry", async () => {
    const user = userEvent.setup();
    render(<TipsPanel tips={tips} whatsNew={news} random={rolls(0, 0.9)} />);
    expect(screen.getByText("Tip three")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /What's New/ }));
    // NOT entry 3 of a 2-entry list, and not a blank card: position means
    // nothing once the list underneath it has changed.
    expect(screen.getByText("News one")).toBeInTheDocument();
  });

  it("renders no arrows and no counter for a single-entry tab", () => {
    render(<TipsPanel tips={[tips[0]!]} whatsNew={[]} random={rolls(0, 0)} />);
    expect(screen.getByText("Tip one")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Next/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Previous/ })).not.toBeInTheDocument();
    expect(screen.queryByText("1/1")).not.toBeInTheDocument();
  });

  it("does not offer a tab with no entries, or ever land on one", () => {
    // A roll that would select tab index 1 must still land on Tips, because
    // What's New is not in the list at all.
    render(<TipsPanel tips={tips} whatsNew={[]} random={rolls(0.99, 0)} />);
    expect(screen.queryByRole("tab", { name: /What's New/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Tips/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Tip one")).toBeInTheDocument();
  });

  it("renders NOTHING when both lists are empty", () => {
    // A card whose only content is "nothing to show" is worse than the gap.
    const { container } = render(<TipsPanel tips={[]} whatsNew={[]} random={rolls(0.5)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("links out only where the entry has somewhere to go", () => {
    render(<TipsPanel tips={tips} whatsNew={news} random={rolls(0, 0)} />);
    // Tip one has no href.
    expect(screen.queryByRole("link", { name: /Read more/ })).not.toBeInTheDocument();
  });

  it("labels a What's New entry with its version", () => {
    render(<TipsPanel tips={tips} whatsNew={news} random={rolls(0.6, 0)} />);
    expect(screen.getByText("v0.71")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Read more/ })).toHaveAttribute(
      "href",
      "https://example.test/n1",
    );
  });

  it("has no close button — it is permanent by design", () => {
    // Randomising per visit only pays for the width if it is always there.
    render(<TipsPanel tips={tips} whatsNew={news} random={rolls(0, 0)} />);
    expect(screen.queryByRole("button", { name: /Close/ })).not.toBeInTheDocument();
  });
});
