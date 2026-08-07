import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Toast } from "./Toast";

/**
 * The transient outcome message (#588). paddock's only other action feedback is
 * `ProjectView`'s `loadErr`, which is an early return that replaces the entire
 * page — fine for "this project failed to load", useless for "adopted 7 chats".
 */
describe("Toast", () => {
  afterEach(() => vi.useRealTimers());

  it("renders nothing when there is no message", () => {
    const { container } = render(<Toast message={null} onDismiss={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("announces the message politely rather than as an interruption", () => {
    render(<Toast message="Adopted 7 chats" onDismiss={() => {}} />);
    const live = screen.getByRole("status");
    expect(live).toHaveTextContent("Adopted 7 chats");
    // `status`, not `alert`: this reports the outcome of something the user just
    // asked for, so an assertive region would talk over them.
    expect(live).toHaveAttribute("aria-live", "polite");
  });

  it("dismisses on the close button", () => {
    const onDismiss = vi.fn();
    render(<Toast message="Adopted 7 chats" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss notification/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses itself once the dwell elapses", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Adopted 7 chats" onDismiss={onDismiss} durationMs={5000} />);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(5000));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("gives a REPLACEMENT message its own full dwell", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast message="first" onDismiss={onDismiss} durationMs={5000} />,
    );
    act(() => void vi.advanceTimersByTime(4000));
    // A second outcome arrives with one second left on the clock. Keying the
    // timer on the message text restarts it — otherwise the new message would
    // flash for the remainder of the old one's countdown.
    rerender(<Toast message="second" onDismiss={onDismiss} durationMs={5000} />);
    act(() => void vi.advanceTimersByTime(4000));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1000));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("never auto-dismisses when the dwell is disabled", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="stay" onDismiss={onDismiss} durationMs={0} />);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
