import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EntryCard } from "./EntryCard";
import { Pager } from "./Pager";
import { BoltIcon, SparkIcon } from "../icons";
import type { Tip, WhatsNewEntry } from "../../lib/onboarding/types";

/**
 * The pager shared by both onboarding cards (#865).
 *
 * It exists as its own component because the two cards had already drifted once
 * — different corners AND different notations — while they were a slideshow and
 * a two-tab panel. They are now the same component rendered twice, so drift is
 * structurally impossible; the last test here is what keeps it that way if
 * someone re-specialises one of them.
 */

const tips: Tip[] = [
  { id: "t1", title: "Tip one", body: "First." },
  { id: "t2", title: "Tip two", body: "Second." },
  { id: "t3", title: "Tip three", body: "Third." },
];
const news: WhatsNewEntry[] = [
  { id: "n1", version: "0.71", title: "News one", body: "Landed.", href: "https://example.test/1" },
  { id: "n2", version: "0.70", title: "News two", body: "Also.", href: "https://example.test/2" },
  { id: "n3", version: "0.69", title: "News three", body: "Too.", href: "https://example.test/3" },
];

describe("Pager", () => {
  const props = {
    index: 1,
    count: 3,
    backLabel: "Back",
    nextLabel: "Next",
    onBack: vi.fn(),
    onNext: vi.fn(),
    itemNoun: "Tip",
  };

  it("shows a COUNTER, not dots — the notation has to survive 31 tips", () => {
    // #867 ships 31 tips. Dots were the old slideshow's treatment and do not
    // scale past a handful, so a shared control cannot use them.
    render(<Pager {...props} />);
    expect(screen.getByText("2/3")).toBeInTheDocument();
  });

  it("reads aloud as words even though it displays as `2/3`", () => {
    render(<Pager {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("Tip 2 of 3");
  });

  it("renders NOTHING at all for a single item", () => {
    // Not two dead arrows. The content lists genuinely arrive at length 1.
    const { container } = render(<Pager {...props} index={0} count={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("clamped: disables the arrow that cannot move", () => {
    // No card uses this today — both wrap — but the option is what stops the
    // next sequence-shaped card from growing its own pager to get it.
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
    // The regression guard. Both cards are rendered with three entries each and
    // their pagers compared structurally: same counter notation, and the LAST
    // child of the card in both, which is what puts the two on one baseline when
    // they share a grid row.
    const user = userEvent.setup();
    const { unmount } = render(
      <EntryCard
        label="What's New"
        icon={BoltIcon}
        entries={news}
        itemNoun="Entry"
        testId="home-whats-new"
        random={() => 0}
      />,
    );
    const newsCard = screen.getByTestId("home-whats-new");
    const newsPager = newsCard.lastElementChild!;
    expect(newsPager).toHaveTextContent("1/3");
    expect(newsPager.querySelectorAll("button")).toHaveLength(2);
    unmount();

    render(
      <EntryCard
        label="Tips"
        icon={SparkIcon}
        entries={tips}
        itemNoun="Tip"
        testId="home-tips-panel"
        random={() => 0}
      />,
    );
    const tipsCard = screen.getByTestId("home-tips-panel");
    expect(tipsCard.lastElementChild).toHaveTextContent("1/3");
    expect(tipsCard.lastElementChild!.querySelectorAll("button")).toHaveLength(2);

    // …and it is a live pager in the card, not a coincidence of text.
    await user.click(screen.getByRole("button", { name: "Next Tips entry" }));
    expect(tipsCard.lastElementChild).toHaveTextContent("2/3");

    // Neither card carries dots — the treatment the two used to disagree over.
    expect(tipsCard.querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(0);
  });
});
