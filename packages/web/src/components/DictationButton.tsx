// The composer's microphone button (#voice). Records a mic clip and inserts the
// transcribed text into the draft via `onText`. All the record→transcribe
// machinery lives in the useDictation hook; this component is just the button +
// its visual states.
//
// Visibility rules:
//   - server dictation disabled           → render nothing
//   - server enabled, browser unsupported → disabled button, explanatory tooltip
//   - server enabled, browser supported    → live mic / stop / spinner
import { MicIcon, StopIcon } from "./icons";
import { useDictation } from "../lib/useDictation";

export interface DictationButtonProps {
  /** Receives transcribed text to append to the composer draft. */
  onText: (text: string) => void;
  /** Disable while the chat is otherwise busy (e.g. a turn is streaming). */
  disabled?: boolean;
}

export function DictationButton({ onText, disabled = false }: DictationButtonProps) {
  const { state, available, supported, error, toggle } = useDictation({ onText });

  // Hide entirely until we know the server supports it, and when it doesn't.
  if (available !== true) return null;

  const recording = state === "recording";
  const transcribing = state === "transcribing";

  // Server has dictation, but this browser/context can't capture audio (most
  // commonly: served over plain HTTP, which blocks getUserMedia). Show a
  // disabled mic that explains why rather than a button that silently fails.
  if (!supported) {
    return (
      <button
        type="button"
        disabled
        aria-label="Voice dictation unavailable"
        title="Voice dictation needs a secure context (HTTPS or localhost). It's blocked over plain HTTP."
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-paddock-300 dark:text-paddock-700"
      >
        <MicIcon width={18} height={18} />
      </button>
    );
  }

  const title = error
    ? error
    : recording
      ? "Stop recording"
      : transcribing
        ? "Transcribing…"
        : "Record a voice message";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || transcribing}
      aria-label={recording ? "Stop recording" : "Record a voice message"}
      aria-pressed={recording}
      title={title}
      data-state={state}
      className={[
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors",
        recording
          ? "bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400"
          : "text-paddock-500 hover:bg-paddock-100 hover:text-paddock-700 dark:text-paddock-400 dark:hover:bg-paddock-800 dark:hover:text-paddock-200",
        (disabled || transcribing) && "cursor-not-allowed opacity-60",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {transcribing ? (
        <Spinner />
      ) : recording ? (
        <StopIcon width={16} height={16} />
      ) : (
        <MicIcon width={18} height={18} />
      )}
      {recording && (
        // Pulsing dot reinforces the live-recording state.
        <span className="sr-only">recording</span>
      )}
    </button>
  );
}

/** Small inline spinner shown while a clip is being transcribed. */
function Spinner() {
  return (
    <span
      className="h-4 w-4 animate-spin rounded-full border-2 border-paddock-300 border-t-accent dark:border-paddock-600"
      role="status"
      aria-label="Transcribing"
    />
  );
}
