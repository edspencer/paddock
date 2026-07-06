import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { DictationButton } from "./DictationButton";
import { api } from "../lib/api";

function setSupported(supported: boolean) {
  Object.defineProperty(window, "isSecureContext", { value: supported, configurable: true });
  if (supported) {
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = class {
      static isTypeSupported() {
        return true;
      }
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
  } else {
    delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
  }
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
});
