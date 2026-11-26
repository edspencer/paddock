// The browser's built-in speech recognition (Web Speech API), used by dictation
// when the server reports `transcription.mode: browser`.
//
// TypeScript's lib.dom (5.5) declares SpeechRecognitionResult / ResultList /
// Alternative but not the SpeechRecognition constructor or its events, so the
// slice paddock uses is typed here. The names carry a `Browser` prefix so they
// cannot collide if a later lib.dom adds the real declarations.
//
// Some browsers expose only the `webkit`-prefixed constructor, so both names are
// checked. Firefox exposes neither by default (→ dictation shows as unsupported).
// Chromium still exposes the constructor on an insecure origin, so callers gate
// on `isSecureContext` as well.

export interface BrowserSpeechRecognitionEvent {
  /** Lowest index in `results` that changed in this event. */
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

export interface BrowserSpeechRecognitionErrorEvent {
  /** Spec error code, e.g. `not-allowed`, `no-speech`, `network`. */
  error: string;
  message?: string;
}

export interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  /** Stop listening; results already heard are still delivered, then `end`. */
  stop(): void;
  /** Stop immediately, discarding pending results (fires `aborted`, then `end`). */
  abort(): void;
}

export type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognition;

/** The browser's SpeechRecognition constructor, or null when it has none. */
export function speechRecognitionCtor(): BrowserSpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: BrowserSpeechRecognitionCtor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Human-readable message for a recognition error code, or null for `aborted`
 * (paddock's own abort on unmount, which is not a failure to report).
 */
export function speechErrorMessage(code: string): string | null {
  switch (code) {
    case "aborted":
      return null;
    case "not-allowed":
      return "Microphone permission denied.";
    case "service-not-allowed":
      return "This browser blocked its speech recognition service.";
    case "no-speech":
      return "Didn't catch any speech — try again.";
    case "audio-capture":
      return "No microphone found.";
    case "network":
      return "Speech recognition couldn't reach its service — check your connection and retry.";
    case "language-not-supported":
      return "Speech recognition doesn't support this browser's language.";
    default:
      return `Speech recognition failed (${code}).`;
  }
}
