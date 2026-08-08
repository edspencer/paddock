// The composer's microphone button (#voice). Records a mic clip and inserts the
// transcribed text into the draft via `onText`. All the record→transcribe
// machinery lives in the useDictation hook; this component is just the button +
// its visual states.
//
// The mic follows the same enabled semantics as the composer's text input: it is
// interactive regardless of turn state, so a user can dictate a follow-up while a
// turn is streaming and have it queue via the composer's existing single-slot
// queue path (issue #365) — exactly like typing does. Its own record/transcribe/
// error state is the only thing that changes what a click does.
//
// Visibility rules:
//   - server dictation disabled           → render nothing
//   - server enabled, browser unsupported → disabled button, explanatory tooltip
//   - server enabled, browser supported    → live mic / stop / spinner
import { AlertIcon, MicIcon, StopIcon } from "./icons";
import { useDictation } from "../lib/useDictation";

export interface DictationButtonProps {
  /** Receives transcribed text to append to the composer draft. */
  onText: (text: string) => void;
}

export function DictationButton({ onText }: DictationButtonProps) {
  const { state, available, supported, error, toggle, retry, dismiss, cancel } = useDictation({
    onText,
  });

  // Hide entirely until we know the server supports it, and when it doesn't.
  if (available !== true) return null;

  const recording = state === "recording";
  const transcribing = state === "transcribing";
  const errored = state === "error";

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
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-subtle"
      >
        <MicIcon width={18} height={18} />
      </button>
    );
  }

  const title = recording
    ? "Stop recording"
    : transcribing
      ? "Transcribing… — click to cancel"
      : errored
        ? "Transcription failed — click to record again"
        : "Record a voice message";

  // Click dispatch by state: cancel an in-flight transcription, else toggle
  // (start when idle/errored, stop when recording).
  const handleClick = () => {
    if (transcribing) cancel();
    else toggle();
  };

  return (
    <div className="relative flex items-center">
      {/* Visible error surface (#voice): a failure would otherwise only show in
          the button tooltip. Anchored above the mic so it doesn't reflow the
          composer, with a one-click Retry that re-submits the same audio. */}
      {errored && error && (
        <div
          role="alert"
          className="absolute bottom-full right-0 z-10 mb-2 flex max-w-[240px] items-start gap-2 rounded-lg border border-danger-edge bg-danger-soft px-2.5 py-1.5 text-xs text-danger shadow-md"
        >
          <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
          <button
            type="button"
            onClick={retry}
            className="shrink-0 font-medium text-danger underline underline-offset-2 hover:opacity-80"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss error"
            className="shrink-0 text-danger/70 hover:text-danger"
          >
            ✕
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={handleClick}
        // Always interactive: idle records, recording stops, transcribing cancels
        // — matching the composer's text input, which stays usable mid-turn so a
        // dictated follow-up can queue like a typed one (issue #365).
        aria-label={
          recording
            ? "Stop recording"
            : transcribing
              ? "Cancel transcription"
              : "Record a voice message"
        }
        aria-pressed={recording}
        title={title}
        data-state={state}
        className={[
          "group flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors",
          recording
            ? "bg-danger-soft text-danger"
            : transcribing
              ? // Transcribing: bright accent (spinner reads clearly); clickable to
                // cancel. Hover tint is can-hover-gated: on touch, the tap that
                // stopped the recording leaves a sticky :hover which would tint
                // this red and make it look like it's still recording.
                "cursor-pointer text-accent can-hover:hover:bg-danger-soft can-hover:hover:text-danger"
              : errored
                ? "bg-danger-soft text-danger"
                : "text-fg-muted can-hover:hover:bg-surface-hover can-hover:hover:text-fg",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {transcribing ? (
          // Spinner by default; on hover/focus it becomes a stop icon to signal
          // "click to cancel". The hover swap is can-hover-gated: iOS Safari
          // keeps a sticky :hover on the button after the tap that stopped the
          // recording, which would replace the spinner with a stop icon and hide
          // that transcription is in progress. On touch the spinner stays (and
          // tapping it still cancels).
          <>
            <span className="inline-flex can-hover:group-hover:hidden group-focus-visible:hidden">
              <Spinner />
            </span>
            <StopIcon
              width={15}
              height={15}
              className="hidden can-hover:group-hover:block group-focus-visible:block"
            />
          </>
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
    </div>
  );
}

/**
 * Small inline spinner shown while a clip is being transcribed. A faint accent
 * ring with one solid accent segment, so the `animate-spin` rotation is clearly
 * visible (high contrast, full opacity).
 */
function Spinner() {
  return (
    <span
      className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-accent/25 border-t-accent"
      role="status"
      aria-label="Transcribing"
    />
  );
}
