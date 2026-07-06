import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDictation, dictationSupported } from "./useDictation";
import { api } from "./api";

// Drive the record→transcribe machinery with a controllable fake MediaRecorder
// and getUserMedia, since jsdom implements neither.
class FakeMediaRecorder {
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType: string;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "audio/webm";
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    // Emit a chunk then fire onstop, mirroring the browser.
    this.ondataavailable?.({ data: new Blob(["fake-audio"], { type: this.mimeType }) });
    this.onstop?.();
  }
  static isTypeSupported() {
    return true;
  }
}

const stopTrack = vi.fn();

beforeEach(() => {
  stopTrack.mockClear();
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })),
    },
  });
  vi.spyOn(api, "transcriptionStatus").mockResolvedValue({
    available: true,
    mode: "remote",
    model: "base",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dictationSupported", () => {
  it("is true when secure context + mediaDevices + MediaRecorder are present", () => {
    expect(dictationSupported()).toBe(true);
  });
  it("is false in an insecure context", () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    expect(dictationSupported()).toBe(false);
  });
});

describe("useDictation", () => {
  it("probes the server for availability on mount", async () => {
    const { result } = renderHook(() => useDictation({ onText: vi.fn() }));
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.supported).toBe(true);
    expect(result.current.state).toBe("idle");
  });

  it("records then transcribes and emits the text", async () => {
    const onText = vi.fn();
    vi.spyOn(api, "transcribe").mockResolvedValue("the transcribed words");
    const { result } = renderHook(() => useDictation({ onText }));
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });

    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(onText).toHaveBeenCalledWith("the transcribed words");
    // The mic stream's tracks are released after recording.
    expect(stopTrack).toHaveBeenCalled();
    // A blob was actually sent for transcription.
    expect(api.transcribe).toHaveBeenCalledOnce();
    expect((api.transcribe as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      Blob,
    );
  });

  it("surfaces a transcription failure as error state", async () => {
    vi.spyOn(api, "transcribe").mockRejectedValue(new Error("whisper server unreachable"));
    const onText = vi.fn();
    const { result } = renderHook(() => useDictation({ onText }));
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.error).toMatch(/unreachable/);
    expect(onText).not.toHaveBeenCalled();
  });

  it("reports a denied-permission error without recording", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(denied);
    const { result } = renderHook(() => useDictation({ onText: vi.fn() }));
    await waitFor(() => expect(result.current.available).toBe(true));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("error");
    expect(result.current.error).toMatch(/permission denied/i);
  });
});
