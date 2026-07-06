import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDictation, dictationSupported } from "./useDictation";
import { api, ApiError } from "./api";

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

  /** Drive a full record→stop cycle so a queued transcription runs. */
  async function recordOnce(result: { current: ReturnType<typeof useDictation> }) {
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      result.current.stop();
    });
  }

  it("auto-retries once on a transient failure, then succeeds silently", async () => {
    const onText = vi.fn();
    const transcribe = vi
      .spyOn(api, "transcribe")
      .mockRejectedValueOnce(new ApiError("server warming up", 502))
      .mockResolvedValueOnce("recovered text");
    const { result } = renderHook(() => useDictation({ onText }));
    await waitFor(() => expect(result.current.available).toBe(true));

    await recordOnce(result);

    await waitFor(() => expect(result.current.state).toBe("idle"), { timeout: 2000 });
    expect(transcribe).toHaveBeenCalledTimes(2); // one auto-retry
    expect(onText).toHaveBeenCalledWith("recovered text");
    expect(result.current.error).toBeNull();
  });

  it("surfaces an error after the auto-retry also fails, and retry() re-submits the same clip", async () => {
    const onText = vi.fn();
    const transcribe = vi
      .spyOn(api, "transcribe")
      .mockRejectedValueOnce(new ApiError("boom", 502)) // initial
      .mockRejectedValueOnce(new ApiError("boom", 502)) // auto-retry
      .mockResolvedValueOnce("second time lucky"); // manual retry
    const { result } = renderHook(() => useDictation({ onText }));
    await waitFor(() => expect(result.current.available).toBe(true));

    await recordOnce(result);
    await waitFor(() => expect(result.current.state).toBe("error"), { timeout: 2000 });
    expect(transcribe).toHaveBeenCalledTimes(2);
    const firstBlob = transcribe.mock.calls[0][0];

    // Manual retry re-submits the SAME audio (no re-recording).
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.state).toBe("idle"), { timeout: 2000 });
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(transcribe.mock.calls[2][0]).toBe(firstBlob);
    expect(onText).toHaveBeenCalledWith("second time lucky");
  });

  it("does NOT auto-retry a non-transient (400) failure", async () => {
    const transcribe = vi
      .spyOn(api, "transcribe")
      .mockRejectedValue(new ApiError("Didn't catch any audio", 400));
    const { result } = renderHook(() => useDictation({ onText: vi.fn() }));
    await waitFor(() => expect(result.current.available).toBe(true));

    await recordOnce(result);
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(transcribe).toHaveBeenCalledTimes(1); // no retry
    expect(result.current.error).toMatch(/audio/i);
  });

  it("dismiss() clears the error and drops the retained clip", async () => {
    vi.spyOn(api, "transcribe").mockRejectedValue(new ApiError("nope", 400));
    const { result } = renderHook(() => useDictation({ onText: vi.fn() }));
    await waitFor(() => expect(result.current.available).toBe(true));

    await recordOnce(result);
    await waitFor(() => expect(result.current.state).toBe("error"));

    await act(async () => {
      result.current.dismiss();
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  /** A transcribe mock that hangs until its request is aborted, then rejects. */
  function hangUntilAborted() {
    return vi.spyOn(api, "transcribe").mockImplementation(
      (_b, _f, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );
  }

  it("cancel() abandons an in-flight transcription and returns to idle", async () => {
    const onText = vi.fn();
    hangUntilAborted();
    const { result } = renderHook(() => useDictation({ onText }));
    await waitFor(() => expect(result.current.available).toBe(true));

    await recordOnce(result);
    await waitFor(() => expect(result.current.state).toBe("transcribing"));

    await act(async () => {
      result.current.cancel();
    });

    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(result.current.error).toBeNull();
    expect(onText).not.toHaveBeenCalled();
  });

  it("surfaces a client-side timeout as a retryable error", async () => {
    hangUntilAborted();
    const { result } = renderHook(() => useDictation({ onText: vi.fn(), timeoutMs: 50 }));
    await waitFor(() => expect(result.current.available).toBe(true));

    await recordOnce(result);

    await waitFor(() => expect(result.current.state).toBe("error"), { timeout: 2000 });
    expect(result.current.error).toMatch(/timed out/i);
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
