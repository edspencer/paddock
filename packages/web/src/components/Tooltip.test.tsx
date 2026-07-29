import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Tooltip } from "./Tooltip";

/**
 * The shared tooltip (#508) that replaced the chat list's native `title=`
 * attributes. What's worth pinning: it opens on hover only after the dwell delay
 * (so sweeping across a row of six actions doesn't flash six bubbles), opens
 * immediately on keyboard focus, describes its trigger rather than renaming it,
 * and gets out of the way when the page moves under it.
 */
// jsdom ships no PointerEvent, so testing-library downgrades `pointerEnter` to a
// MouseEvent and drops `pointerType` — which is exactly the field the touch guard
// reads. A minimal stand-in keeps that branch reachable.
class FakePointerEvent extends MouseEvent {
  readonly pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
  }
}

describe("Tooltip (#508)", () => {
  beforeEach(() => {
    (window as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  const dwell = (ms = 300) => act(() => void vi.advanceTimersByTime(ms));

  const renderOne = (content: React.ReactNode = "Archive chat") =>
    render(
      <Tooltip content={content}>
        <button type="button" aria-label="Archive chat Manager">
          icon
        </button>
      </Tooltip>,
    );

  it("shows nothing until the pointer has dwelled", () => {
    renderOne();
    const btn = screen.getByRole("button");
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerEnter(btn, { pointerType: "mouse" });
    // Still closed immediately after entering — that's the anti-flicker delay.
    expect(screen.queryByRole("tooltip")).toBeNull();

    dwell();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Archive chat");
  });

  it("never opens if the pointer leaves before the delay elapses", () => {
    renderOne();
    const btn = screen.getByRole("button");
    fireEvent.pointerEnter(btn, { pointerType: "mouse" });
    act(() => void vi.advanceTimersByTime(50));
    fireEvent.pointerLeave(btn);
    dwell();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens immediately on keyboard focus — a focused control is a deliberate stop", () => {
    renderOne();
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.blur(screen.getByRole("button"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("describes the trigger instead of renaming it", () => {
    renderOne();
    const btn = screen.getByRole("button");
    // The accessible NAME is untouched — the bubble is a description.
    expect(btn).toHaveAccessibleName("Archive chat Manager");
    expect(btn).not.toHaveAttribute("aria-describedby");

    fireEvent.focus(btn);
    const tip = screen.getByRole("tooltip");
    expect(btn.getAttribute("aria-describedby")).toBe(tip.id);
    expect(btn).toHaveAccessibleName("Archive chat Manager");

    fireEvent.blur(btn);
    expect(btn).not.toHaveAttribute("aria-describedby");
  });

  it("renders rich content — the point of replacing title=", () => {
    renderOne(
      <>
        Archive · <span className="font-semibold">Shift-click</span> to archive all 21
      </>,
    );
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Archive · Shift-click to archive all 21",
    );
  });

  it("ignores touch 'hover', which arrives with the tap that already acted", () => {
    renderOne();
    fireEvent.pointerEnter(screen.getByRole("button"), { pointerType: "touch" });
    dwell();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("dismisses on Escape, on scroll, and on the press itself", () => {
    renderOne();
    const btn = screen.getByRole("button");

    fireEvent.focus(btn);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    // A fixed bubble positioned from a stale rect would drift away from its
    // trigger, so any scroll closes it rather than following.
    fireEvent.focus(btn);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(btn);
    fireEvent.pointerDown(btn);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("portals out of a clipping scroll container", () => {
    render(
      <div style={{ overflow: "hidden" }} data-testid="clipper">
        <Tooltip content="Delete chat">
          <button type="button">x</button>
        </Tooltip>
      </div>,
    );
    fireEvent.focus(screen.getByRole("button"));
    const tip = screen.getByRole("tooltip");
    // Rendered into document.body, so the sidebar's overflow-y-auto column can't
    // clip it — the reason this isn't a plain absolutely-positioned span.
    expect(screen.getByTestId("clipper")).not.toContainElement(tip);
    expect(document.body).toContainElement(tip);
  });
});
