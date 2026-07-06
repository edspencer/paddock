import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { DictationButton } from "./DictationButton";
import { api, ApiError } from "../lib/api";

/** A controllable fake MediaRecorder whose stop() emits a chunk + fires onstop. */
class FakeMediaRecorder {
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "audio/webm";
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) });
    this.onstop?.();
  }
  static isTypeSupported() {
    return true;
  }
}

function setSupported(supported: boolean) {
  Object.defineProperty(window, "isSecureContext", { value: supported, configurable: true });
  if (supported) {
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    });
  } else {
    delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
  }
}

/** Click the mic to start, then again to stop → triggers transcription. */
async function recordViaButton() {
  const mic = await screen.findByRole("button", { name: /record a voice message/i });
  await act(async () => {
    fireEvent.click(mic);
  });
  await act(async () => {
    fireEvent.click(mic); // stop → onstop → transcribe
  });
}

afterEach(() => vi.restoreAllMocks());

describe("DictationButton", () => {
  beforeEach(() => setSupported(true));

  it("renders nothing when the server has dictation disabled", async () => {
    vi.spyOn(api, "transcriptionStatus").mockResolvedValue({
      available: false,
      mode: "off",
      model: "",
    });
    const { container } = render(<DictationButton onText={vi.fn()} />);
    // Give the availability probe a tick to resolve.
    await waitFor(() => expect(api.transcriptionStatus).toHaveBeenCalled());
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders a live mic button when enabled + supported", async () => {
    vi.spyOn(api, "transcriptionStatus").mockResolvedValue({
      available: true,
      mode: "remote",
      model: "base",
    });
    render(<DictationButton onText={vi.fn()} />);
    const btn = await screen.findByRole("button", { name: /record a voice message/i });
    expect(btn).toBeEnabled();
  });

  it("renders a disabled mic explaining the secure-context requirement when unsupported", async () => {
    setSupported(false);
    vi.spyOn(api, "transcriptionStatus").mockResolvedValue({
      available: true,
      mode: "remote",
      model: "base",
    });
    render(<DictationButton onText={vi.fn()} />);
    const btn = await screen.findByRole("button", { name: /voice dictation unavailable/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/secure context|HTTPS/i);
  });

  it("shows a visible error with a working Retry after a failed transcription", async () => {
    vi.spyOn(api, "transcriptionStatus").mockResolvedValue({
      available: true,
      mode: "remote",
      model: "base",
    });
    // 400 = non-transient, so it fails immediately (no auto-retry delay), then
    // the manual Retry succeeds.
    const transcribe = vi
      .spyOn(api, "transcribe")
      .mockRejectedValueOnce(new ApiError("Didn't catch any audio — try again.", 400))
      .mockResolvedValueOnce("hello there");
    const onText = vi.fn();
    render(<DictationButton onText={onText} />);

    await recordViaButton();

    // The error is surfaced visibly (an alert), not just in a tooltip.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/audio/i);
    const retryBtn = screen.getByRole("button", { name: /^retry$/i });

    await act(async () => {
      fireEvent.click(retryBtn);
    });

    await waitFor(() => expect(onText).toHaveBeenCalledWith("hello there"));
    expect(transcribe).toHaveBeenCalledTimes(2);
    // Error surface clears on success.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
