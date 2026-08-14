import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TipsPanel } from "./TipsPanel";
import { GettingStarted } from "./GettingStarted";
import { Pager } from "./Pager";
import type { Slide, Tip } from "../../lib/onboarding/types";

/**
 * The pager shared by both onboarding cards (#865, review round 2).
 *
 * They shipped with the pager in different corners and different notations —
 * Tips `2/3 ‹ ›` top right, Getting Started dots bottom-left and arrows
 * bottom-right — two cards in one row doing the same job with two answers. The
 * fix was one component, so the last test here is the one that matters: it
 * fails if either card grows a paging control of its own again.
 */

const tips: Tip[] = [
  { id: "t1", title: "Tip one", body: "First." },
  { id: "t2", title: "Tip two", body: "Second." },
  { id: "t3", title: "Tip three", body: "Third." },
];
const slides: Slide[] = [
  { id: "s1", title: "Slide one", body: "First." },
  { id: "s2", title: "Slide two", body: "Second." },
  { id: "s3", title: "Slide three", body: "Third." },
];

describe("Pager", () => {
  const props = {
    index: 1,
    count: 3,
    backLabel: "Back",
    nextLabel: "Next",
    onBack: vi.fn(),
    onNext: vi.fn(),
    itemNoun: "Slide",
  };

  it("shows a COUNTER, not dots — the notation has to survive 31 tips", () => {
    // #867 ships 31 tips. Dots were the Getting Started card's treatment and do
    // not scale past a handful, so a shared control cannot use them.
    render(<Pager {...props} />);
    expect(screen.getByText("2/3")).toBeInTheDocument();
  });

  it("reads aloud as words even though it displays as `2/3`", () => {
    render(<Pager {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("Slide 2 of 3");
  });

  it("renders NOTHING at all for a single item", () => {
    // Not two dead arrows. The content lists genuinely arrive at length 1.
    const { container } = render(<Pager {...props} index={0} count={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("clamped: disables the arrow that cannot move", () => {
    const { unmount } = render(<Pager {...props} index={0} clamped />);
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    unmount();

    render(<Pager {...props} index={2} clamped />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("unclamped: neither arrow is ever disabled, because it wraps", () => {
    render(<Pager {...props} index={0} />);
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("is the SAME control in both cards — same notation, same place", async () => {
    // The regression guard. Both cards are rendered with three items each, and
    // the pager is compared structurally: same counter notation, and last child
    // of the card in both, which is what puts the two on one baseline when they
    // share a grid row.
    const user = userEvent.setup();
    const { unmount } = render(<TipsPanel tips={tips} whatsNew={[]} random={() => 0} />);
    const tipsCard = screen.getByTestId("home-tips-panel");
    const tipsPager = tipsCard.lastElementChild!;
    expect(tipsPager).toHaveTextContent("1/3");
    // …and it is a real pager, not a coincidence of text.
    expect(tipsPager.querySelectorAll("button")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Next Tips entry" }));
    expect(tipsCard.lastElementChild).toHaveTextContent("2/3");
    unmount();

    render(<GettingStarted slides={slides} onClose={vi.fn()} />);
    const gsCard = screen.getByTestId("home-getting-started");
    const gsPager = gsCard.lastElementChild!;
    expect(gsPager).toHaveTextContent("1/3");
    expect(gsPager.querySelectorAll("button")).toHaveLength(2);

    // Neither card carries dots any more — the treatment they disagreed over.
    expect(gsCard.querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(0);
  });
});
