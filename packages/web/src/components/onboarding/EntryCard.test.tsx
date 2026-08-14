import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EntryCard } from "./EntryCard";
import { BoltIcon, SparkIcon } from "../icons";
import type { Tip, WhatsNewEntry } from "../../lib/onboarding/types";

/**
 * The onboarding card (#865). Replaces the deleted `TipsPanel` and
 * `GettingStarted` suites: one component now serves both cards on the root's
 * Home, so the behaviour they each pinned separately is pinned once, here.
 *
 * Everything covered is something the doc comment PROMISES — the roll happening
 * once per mount, an empty list rendering nothing, a single entry growing no
 * orphan arrows, wrap-around, and the version badge belonging to What's New
 * alone. The content lists are maintained elsewhere and vary in length between
 * releases (#866, #867), so length is the axis that actually breaks.
 */

const tips: Tip[] = [
  { id: "t1", title: "Tip one", body: "First tip." },
  { id: "t2", title: "Tip two", body: "Second tip.", href: "https://example.test/two" },
  { id: "t3", title: "Tip three", body: "Third tip." },
];
const news: WhatsNewEntry[] = [
  { id: "n1", version: "0.71", title: "News one", body: "Landed.", href: "https://example.test/1" },
  { id: "n2", version: "0.70", title: "News two", body: "Also.", href: "https://example.test/2" },
];

/** Render the Tips card. `random` is fixed so a case is never a coin toss. */
function renderTips(entries: Tip[] = tips, random = () => 0) {
  return render(
    <EntryCard
      label="Tips"
      icon={SparkIcon}
      entries={entries}
      itemNoun="Tip"
      testId="home-tips-panel"
      random={random}
    />,
  );
}

/** Render the What's New card. */
function renderNews(entries: WhatsNewEntry[] = news, random = () => 0) {
  return render(
    <EntryCard
      label="What's New"
      icon={BoltIcon}
      entries={entries}
      itemNoun="Entry"
      testId="home-whats-new"
      random={random}
    />,
  );
}

describe("EntryCard (#865)", () => {
  it("rolls ONE random entry at mount", () => {
    // 0.6 of three entries = index 1. The whole feature: every landing on Home
    // surfaces something different.
    renderTips(tips, () => 0.6);
    expect(screen.getByText("Tip two")).toBeInTheDocument();
    expect(screen.queryByText("Tip one")).not.toBeInTheDocument();
  });

  it("rolls a different entry for a different roll", () => {
    renderTips(tips, () => 0.9);
    expect(screen.getByText("Tip three")).toBeInTheDocument();
  });

  it("rolls ONCE, not on every render", () => {
    // A roll in an effect (or in the render body) re-fires on re-render, so the
    // card would visibly change under the reader mid-interaction. The rerender
    // below hands it a roll that WOULD pick a different entry if consulted.
    let calls = 0;
    const drifting = () => {
      calls += 1;
      return calls === 1 ? 0 : 0.9;
    };
    const { rerender } = renderTips(tips, drifting);
    expect(screen.getByText("Tip one")).toBeInTheDocument();
    rerender(
      <EntryCard
        label="Tips"
        icon={SparkIcon}
        entries={tips}
        itemNoun="Tip"
        testId="home-tips-panel"
        random={drifting}
      />,
    );
    expect(screen.getByText("Tip one")).toBeInTheDocument();
  });

  it("never rolls past the end of the list", () => {
    // `Math.random()` is [0,1), but a sloppy `* length` rounds up at 0.999… on
    // some inputs, and an out-of-range index renders a blank card.
    renderTips(tips, () => 0.999999);
    expect(screen.getByText("Tip three")).toBeInTheDocument();
  });

  it("renders NOTHING for an empty list", () => {
    // Not a card saying "nothing to show". The caller drops the row to one
    // column when only one card survives, so this leaves no hole either.
    const { container } = renderTips([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a single entry with NO pager — the orphan-arrow bug", () => {
    renderTips([tips[0]!]);
    expect(screen.getByText("Tip one")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Next/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Previous/ })).not.toBeInTheDocument();
    expect(screen.queryByText("1/1")).not.toBeInTheDocument();
  });

  it("pages forward and wraps past the end", async () => {
    const user = userEvent.setup();
    renderTips();
    await user.click(screen.getByRole("button", { name: "Next Tips entry" }));
    expect(screen.getByText("Tip two")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next Tips entry" }));
    await user.click(screen.getByRole("button", { name: "Next Tips entry" }));
    // Round the loop, not stranded on the last one.
    expect(screen.getByText("Tip one")).toBeInTheDocument();
  });

  it("pages backward and wraps past the start", async () => {
    const user = userEvent.setup();
    renderTips();
    expect(screen.getByText("Tip one")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous Tips entry" }));
    expect(screen.getByText("Tip three")).toBeInTheDocument();
  });

  it("badges a What's New entry with its version", () => {
    // The `"version" in entry` branch: the two cards take different shapes
    // through one component, and this is the only place that shows.
    renderNews();
    expect(screen.getByText("v0.71")).toBeInTheDocument();
  });

  it("shows NO version badge on a tip", () => {
    renderTips();
    expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
  });

  it("links out only where the entry has somewhere to go", async () => {
    const user = userEvent.setup();
    renderTips();
    // Tip one has no href.
    expect(screen.queryByRole("link", { name: /Read more/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next Tips entry" }));
    expect(screen.getByRole("link", { name: /Read more/ })).toHaveAttribute(
      "href",
      "https://example.test/two",
    );
  });

  it("carries its label and no close button — these cards are permanent", () => {
    // A card that re-randomises per visit only pays for its width if it is
    // always there, so there is deliberately nothing to dismiss.
    renderNews();
    expect(screen.getByText("What's New")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Close/ })).not.toBeInTheDocument();
  });
});
