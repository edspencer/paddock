import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDictation, dictationSupported } from "./useDictation";
import { api, ApiError } from "./api";
import { FakeSpeechRecognition } from "../test/fakeSpeechRecognition";

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
  FakeSpeechRecognition.uninstall();
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

describe("useDictation — engine selection", () => {
  it("uses record + upload for whisper modes even when the browser has speech", async () => {
    FakeSpeechRecognition.install();
    vi.spyOn(api, "transcribe").mockResolvedValue("from whisper");
    const onText = vi.fn();
    const { result } = renderHook(() => useDictation({ onText }));
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.engine).toBe("server");

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      result.current.stop();
    });
    await waitFor(() => expect(onText).toHaveBeenCalledWith("from whisper"));
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
    expect(FakeSpeechRecognition.instances).toHaveLength(0);
  });

  it("uses the browser engine when the server reports mode browser", async () => {
    FakeSpeechRecognition.install();
    vi.spyOn(api, "transcriptionStatus").mockResolvedValue({
      available: true,
      mode: "browser",
      model: null,
    });
    const { result } = renderHook(() => useDictation({ onText: vi.fn() }));
    await waitFor(() => expect(result.current.engine).toBe("browser"));
    expect(result.current.supported).toBe(true);
    expect(result.current.unsupportedReason).toBeNull();
  });
});

describe("useDictation — browser engine", () => {
  const transcribe = () => vi.spyOn(api, "transcribe");

  beforeEach(() => {
    FakeSpeechRecognition.install("webkitSpeechRecognition");
    vi.spyOn(api, "transcriptionStatus").mockResolvedValue({
      available: true,
      mode: "browser",
      model: null,
    });
  });

  async function startBrowser(onText = vi.fn()) {
    const hook = renderHook(() => useDictation({ onText }));
    await waitFor(() => expect(hook.result.current.engine).toBe("browser"));
    await act(async () => {
      await hook.result.current.start();
    });
    return { ...hook, onText, rec: FakeSpeechRecognition.latest() };
  }

  it("starts continuous recognition with interim results in navigator.language", async () => {
    const { result, rec } = await startBrowser();
    expect(rec.start).toHaveBeenCalledOnce();
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.lang).toBe(navigator.language);
    expect(result.current.state).toBe("recording");
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("exposes interim text without inserting it, then inserts each final phrase", async () => {
    const { result, rec, onText } = await startBrowser();

    act(() => rec.emit([["hello wor", false]]));
    expect(result.current.interim).toBe("hello wor");
    expect(onText).not.toHaveBeenCalled();

    act(() => rec.emit([[" hello world ", true]]));
    expect(onText).toHaveBeenCalledWith("hello world");
    expect(result.current.interim).toBe("");

    // A later event starts at resultIndex 1: the earlier final is not re-sent.
    act(() =>
      rec.emit(
        [
          ["hello world", true],
          ["second phrase", true],
          ["and a thi", false],
        ],
        1,
      ),
    );
    expect(onText).toHaveBeenCalledTimes(2);
    expect(onText).toHaveBeenLastCalledWith("second phrase");
    expect(result.current.interim).toBe("and a thi");
    expect(result.current.state).toBe("recording");
  });

  it("stop() stops recognition and returns to idle on end, uploading nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const upload = transcribe();
    const { result, rec } = await startBrowser();
    act(() => rec.emit([["partial", false]]));

    act(() => result.current.toggle());
    expect(rec.stop).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("idle");
    expect(result.current.interim).toBe("");
    expect(upload).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns to idle when the browser ends the session by itself", async () => {
    const { result, rec } = await startBrowser();
    act(() => rec.end());
    expect(result.current.state).toBe("idle");
  });

  it.each([
    ["not-allowed", /permission denied/i],
    ["no-speech", /didn't catch any speech/i],
    ["network", /couldn't reach its service/i],
    ["audio-capture", /no microphone/i],
  ])("maps a %s error to the error state, and keeps it after end", async (code, message) => {
    const { result, rec } = await startBrowser();
    act(() => {
      rec.fail(code);
      rec.end();
    });
    expect(result.current.state).toBe("error");
    expect(result.current.error).toMatch(message);
  });

  it("retry() after an error starts a fresh recognition session", async () => {
    const { result, rec } = await startBrowser();
    act(() => {
      rec.fail("no-speech");
      rec.end();
    });
    await act(async () => {
      result.current.retry();
    });
    expect(FakeSpeechRecognition.instances).toHaveLength(2);
    expect(FakeSpeechRecognition.latest()).not.toBe(rec);
    expect(result.current.state).toBe("recording");
    expect(result.current.error).toBeNull();
  });

  it("ignores events from a superseded session", async () => {
    const { result, rec, onText } = await startBrowser();
    act(() => {
      rec.fail("no-speech");
      rec.end();
    });
    await act(async () => {
      result.current.retry();
    });
    act(() => {
      rec.emit([["stale", true]]);
      rec.end();
    });
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.state).toBe("recording");
  });

  it("surfaces a start() exception as an error", async () => {
    const { result } = renderHook(() => useDictation({ onText: vi.fn() }));
    await waitFor(() => expect(result.current.engine).toBe("browser"));
    // Make the next session's start() throw, as the browser does when the
    // recogniser is already running.
    const throwing = class extends FakeSpeechRecognition {
      start = vi.fn(() => {
        throw new Error("recognition has already started");
      });
    };
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition = throwing;
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("error");
    expect(result.current.error).toMatch(/already started/);
  });

  it("aborts the session on unmount", async () => {
    const { unmount, rec } = await startBrowser();
    unmount();
    expect(rec.abort).toHaveBeenCalledOnce();
  });

  it("is unsupported with no SpeechRecognition (Firefox), with that reason", async () => {
    FakeSpeechRecognition.uninstall();
    const { result } = renderHook(() => useDictation({ onText: vi.fn() }));
    await waitFor(() => expect(result.current.engine).toBe("browser"));
    expect(result.current.supported).toBe(false);
    expect(result.current.unsupportedReason).toBe("no-speech-recognition");
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("idle");
  });

  it("is unsupported in an insecure context, with that reason", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    const { result } = renderHook(() => useDictation({ onText: vi.fn() }));
    await waitFor(() => expect(result.current.engine).toBe("browser"));
    expect(result.current.supported).toBe(false);
    expect(result.current.unsupportedReason).toBe("insecure-context");
  });
});
