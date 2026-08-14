import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GettingStarted } from "./GettingStarted";
import type { Slide } from "../../lib/onboarding/types";

const slides: Slide[] = [
  { id: "s1", title: "Slide one", body: "First.", diagram: <svg data-testid="diagram" /> },
  { id: "s2", title: "Slide two", body: "Second." },
  { id: "s3", title: "Slide three", body: "Third." },
];

describe("GettingStarted (#865)", () => {
  it("opens on the first slide — a sequence, not a random entry", () => {
    // Deliberately unlike the tips panel next to it: a lesson you land in the
    // middle of is not a lesson.
    render(<GettingStarted slides={slides} onClose={vi.fn()} />);
    expect(screen.getByText("Slide one")).toBeInTheDocument();
  });

  it("steps forward and back", async () => {
    const user = userEvent.setup();
    render(<GettingStarted slides={slides} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Next slide" }));
    expect(screen.getByText("Slide two")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous slide" }));
    expect(screen.getByText("Slide one")).toBeInTheDocument();
  });

  it("clamps at both ends rather than wrapping", async () => {
    const user = userEvent.setup();
    render(<GettingStarted slides={slides} onClose={vi.fn()} />);
    // Back from the first stays put, and the control says so rather than
    // silently doing nothing.
    expect(screen.getByRole("button", { name: "Previous slide" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next slide" }));
    await user.click(screen.getByRole("button", { name: "Next slide" }));
    expect(screen.getByText("Slide three")).toBeInTheDocument();
    // Looping back to slide one would quietly restart a lesson just finished.
    expect(screen.getByRole("button", { name: "Next slide" })).toBeDisabled();
  });

  it("renders a diagram only where the slide has one", async () => {
    const user = userEvent.setup();
    render(<GettingStarted slides={slides} onClose={vi.fn()} />);
    expect(screen.getByTestId("diagram")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next slide" }));
    // An empty box where a diagram would go is worse than never promising one.
    expect(screen.queryByTestId("diagram")).not.toBeInTheDocument();
  });

  it("closes on the close button", async () => {
    const onClose = vi.fn();
    render(<GettingStarted slides={slides} onClose={onClose} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Close Getting started" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders no paging controls for a single slide", () => {
    render(<GettingStarted slides={[slides[0]!]} onClose={vi.fn()} />);
    expect(screen.getByText("Slide one")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next slide" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous slide" })).not.toBeInTheDocument();
    // …but it is still closeable: the dismissal is not a paging control.
    expect(screen.getByRole("button", { name: "Close Getting started" })).toBeInTheDocument();
  });

  it("renders NOTHING when there are no slides", () => {
    // Not an empty card with a close button on it.
    const { container } = render(<GettingStarted slides={[]} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
