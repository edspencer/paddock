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
import { api } from "./api";

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
}

export function useDictation({ onText }: UseDictationOptions): UseDictation {
  const [state, setState] = useState<DictationState>("idle");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState<boolean>(dictationSupported);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const extRef = useRef<string>("webm");
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
      void transcribe(blob);
    };
    recorderRef.current = recorder;
    recorder.start();
    setState("recording");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, state]);

  const transcribe = useCallback(
    async (blob: Blob) => {
      // Nothing captured (e.g. permission granted then immediately stopped).
      if (blob.size === 0) {
        if (mountedRef.current) setState("idle");
        return;
      }
      if (mountedRef.current) setState("transcribing");
      try {
        const text = await api.transcribe(blob, `dictation.${extRef.current}`);
        if (text.trim()) onText(text.trim());
        if (mountedRef.current) setState("idle");
      } catch (err) {
        if (mountedRef.current) {
          setState("error");
          setError(err instanceof Error ? err.message : "transcription failed");
        }
      }
    },
    [onText],
  );

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.stop(); // triggers onstop → transcribe
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === "recording") stop();
    else void start();
  }, [state, start, stop]);

  return { state, available, supported, error, start, stop, toggle };
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
