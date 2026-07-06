// Voice dictation for the composer: records a short mic clip in the browser and
// sends it to the server's whisper backend for transcription (see api.transcribe
// + the server's /api/transcribe route).
//
// State machine:  idle → recording → transcribing → idle   (→ error on failure)
//
// The mic button is shown only when BOTH are true:
//   - the SERVER advertises dictation (`available`, from /api/transcription), and
//   - the BROWSER can capture audio (`supported`).
// `supported` is false in an insecure context — getUserMedia requires HTTPS or
// localhost, so on the raw-HTTP LAN dev port the mic can't be used (by design);
// we surface that as a disabled button with an explanatory tooltip rather than a
// silent no-op.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

/** Backoff before the single automatic retry of a transient failure. */
const RETRY_BACKOFF_MS = 500;

/**
 * Client-side ceiling on a single transcription request. The server aborts at
 * 120s; we give up a bit sooner so a hung/slow request surfaces as a clean,
 * retryable "timed out" instead of spinning indefinitely.
 */
const DEFAULT_TIMEOUT_MS = 90_000;

// Abort reasons, so the catch can tell a user cancel from a client timeout.
const ABORT_CANCEL = "paddock:cancel";
const ABORT_TIMEOUT = "paddock:timeout";

export type DictationState = "idle" | "recording" | "transcribing" | "error";

export interface UseDictation {
  /** Current phase of the record→transcribe cycle. */
  state: DictationState;
  /** Server has dictation enabled (null while the probe is in flight). */
  available: boolean | null;
  /** This browser/context can capture audio (secure context + MediaRecorder). */
  supported: boolean;
  /** Last error message, if state === "error". */
  error: string | null;
  /** Begin recording (idempotent while already recording). */
  start: () => Promise<void>;
  /** Stop recording and transcribe what was captured. */
  stop: () => void;
  /** Convenience: start if idle, stop if recording. */
  toggle: () => void;
  /**
   * After an error, re-attempt WITHOUT re-recording — re-submits the retained
   * audio for a transcription failure, or re-opens the mic for a capture/
   * permission failure (where no audio was captured).
   */
  retry: () => void;
  /** Dismiss the current error and drop any retained audio. */
  dismiss: () => void;
  /** Cancel an in-flight transcription (abandons it, returns to idle). */
  cancel: () => void;
}

/** True when the browser can actually capture microphone audio. */
export function dictationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    // A secure context is required for getUserMedia (HTTPS or localhost).
    window.isSecureContext === true &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof window.MediaRecorder !== "undefined"
  );
}

/** Pick a recording MIME type the browser supports, with a filename extension. */
function pickMimeType(): { mimeType: string; ext: string } {
  const candidates = [
    { mimeType: "audio/webm;codecs=opus", ext: "webm" },
    { mimeType: "audio/webm", ext: "webm" },
    { mimeType: "audio/ogg;codecs=opus", ext: "ogg" },
    { mimeType: "audio/mp4", ext: "mp4" }, // Safari
  ];
  const MR = window.MediaRecorder;
  for (const c of candidates) {
    if (typeof MR.isTypeSupported !== "function" || MR.isTypeSupported(c.mimeType)) {
      return c;
    }
  }
  return { mimeType: "", ext: "webm" }; // let the browser choose
}

export interface UseDictationOptions {
  /** Called with the transcribed text when a recording is transcribed. */
  onText: (text: string) => void;
  /** Client-side per-request timeout in ms (default 90s). */
  timeoutMs?: number;
}

export function useDictation({
  onText,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: UseDictationOptions): UseDictation {
  const [state, setState] = useState<DictationState>("idle");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState<boolean>(dictationSupported);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const extRef = useRef<string>("webm");
  // The last recorded clip, retained after a transcription failure so `retry`
  // can re-submit the SAME audio without making the user speak again. Cleared
  // on success, on a new recording, and on dismiss.
  const lastBlobRef = useRef<Blob | null>(null);
  // The in-flight transcription request, so `cancel` (and the timeout) can abort it.
  const abortRef = useRef<AbortController | null>(null);
  // Guards async setState after unmount.
  const mountedRef = useRef(true);

  // Probe the server once for whether dictation is enabled at all.
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    api
      .transcriptionStatus()
      .then((s) => {
        if (!cancelled) setAvailable(s.available);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      abortRef.current?.abort(ABORT_CANCEL);
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  };

  const start = useCallback(async () => {
    if (!supported || state === "recording" || state === "transcribing") return;
    setError(null);
    // A fresh recording supersedes any retained clip from a prior failure.
    lastBlobRef.current = null;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setState("error");
      setError(micErrorMessage(err));
      return;
    }
    streamRef.current = stream;
    const { mimeType, ext } = pickMimeType();
    extRef.current = ext;
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stopStream();
      const type = recorder.mimeType || mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      lastBlobRef.current = blob;
      void runTranscription(blob);
    };
    recorderRef.current = recorder;
    recorder.start();
    setState("recording");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, state]);

  const runTranscription = useCallback(
    async (blob: Blob, isAutoRetry = false): Promise<void> => {
      // Nothing captured (e.g. permission granted then immediately stopped).
      if (blob.size === 0) {
        lastBlobRef.current = null;
        if (mountedRef.current) setState("idle");
        return;
      }
      if (mountedRef.current) setState("transcribing");

      // Each attempt gets its own controller: a `cancel()` or the timeout aborts
      // the in-flight fetch.
      const controller = new AbortController();
      abortRef.current = controller;
      const timer = setTimeout(() => controller.abort(ABORT_TIMEOUT), timeoutMs);
      try {
        const text = await api.transcribe(blob, `dictation.${extRef.current}`, controller.signal);
        if (text.trim()) onText(text.trim());
        lastBlobRef.current = null; // succeeded — nothing to retry
        if (mountedRef.current) {
          setError(null);
          setState("idle");
        }
      } catch (err) {
        // User cancelled → silently return to idle (not an error), drop the clip.
        if (controller.signal.aborted && controller.signal.reason === ABORT_CANCEL) {
          lastBlobRef.current = null;
          if (mountedRef.current) {
            setError(null);
            setState("idle");
          }
          return;
        }
        // Timed out → a retryable error (keep the clip); no auto-retry, since a
        // retry would just wait out the same timeout again.
        if (controller.signal.aborted && controller.signal.reason === ABORT_TIMEOUT) {
          if (mountedRef.current) {
            setState("error");
            setError("Transcription timed out — try again.");
          }
          return;
        }
        // Transient failures (network / 5xx — e.g. a whisper server still
        // warming up) get one silent automatic retry before we bother the user.
        if (isTransient(err) && !isAutoRetry) {
          await delay(RETRY_BACKOFF_MS);
          return runTranscription(blob, true);
        }
        // Keep lastBlobRef so `retry` can re-submit the same clip.
        if (mountedRef.current) {
          setState("error");
          setError(errorMessage(err));
        }
      } finally {
        clearTimeout(timer);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [onText, timeoutMs],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort(ABORT_CANCEL);
  }, []);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.stop(); // triggers onstop → runTranscription
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === "recording") stop();
    else void start();
  }, [state, start, stop]);

  // Re-attempt after an error without re-recording: re-submit the retained clip
  // if we have one, else re-open the mic (permission/capture failure).
  const retry = useCallback(() => {
    if (state === "recording" || state === "transcribing") return;
    const blob = lastBlobRef.current;
    if (blob) void runTranscription(blob);
    else void start();
  }, [state, runTranscription, start]);

  const dismiss = useCallback(() => {
    lastBlobRef.current = null;
    setError(null);
    setState("idle");
  }, []);

  return { state, available, supported, error, start, stop, toggle, retry, dismiss, cancel };
}

/** A failure worth one automatic retry: network errors and 5xx from the server. */
function isTransient(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500;
  // A non-ApiError here means fetch itself threw (network/CORS/abort) → transient.
  return true;
}

/** Best-effort human-readable message for a transcription failure. */
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status >= 500) return err.message || "Transcription service error — try again.";
    if (err.status === 400) return err.message || "Didn't catch any audio — try again.";
    return err.message || "Transcription failed.";
  }
  return "Couldn't reach the transcription service — check your connection and retry.";
}

/** A cancellable-free delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Human-readable message for a getUserMedia failure. */
function micErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone permission denied.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone found.";
    case "NotReadableError":
      return "Microphone is already in use.";
    default:
      return err instanceof Error ? err.message : "Could not access the microphone.";
  }
}
