import { useId, useState } from "react";
import type { ChatVerdict } from "../../lib/types";
import { verdictLabel } from "../ChatVerdictMark";
import { ChevronDownIcon } from "../icons";
import type { Turn } from "./turnModel";

// The re-entry card: what a chat is for and where it stands, for someone coming
// back to it after other work. Three lines — the judge's Goal, the user's Last
// ask (straight from the transcript), and Where it stands (the judge's verdict).
//
// Two placements, chosen from the transcript area's measured width (ChatPane,
// via lib/useMarginFits): in the transcript's RIGHT margin when that margin is at least
// 14rem wide (a 76rem area: the 48rem column plus 14rem a side), else a thin
// collapsible bar above the transcript. Only one is rendered at a time.

/** The transcript area width, in rem, from which the card fits in the margin. */
export const REENTRY_MARGIN_MIN_REM = 76;

/** Collapsed/expanded memory for the narrow bar; a client pref, per browser. */
const EXPANDED_KEY = "paddock:reentry-expanded";

/** Whether the narrow bar is expanded. False (collapsed) when unset or unavailable. */
export function readReentryExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the narrow bar's state. Best effort (private mode / quota). */
export function writeReentryExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** The literal boundary the server's preload wrapper puts before the real request. */
const PRELOAD_OPEN = "<project-context>";
const PRELOAD_REQUEST_MARKER = "</project-context>\n\nMy request:\n";

/**
 * The user's most recent message, whitespace collapsed, or undefined when there
 * is none. Only a genuine user turn counts: `kind: "user"` with no `sender` (a
 * sender marks a message another chat or a trigger injected) and some text.
 * Task notifications, slash commands, command output and compaction summaries
 * have kinds of their own, so they are skipped by the kind check. A first
 * message wrapped in the preload context block yields only the request.
 */
export function lastAskOf(turns: readonly Turn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.kind !== "user" || t.sender) continue;
    let text = t.content;
    if (text.startsWith(PRELOAD_OPEN)) {
      const at = text.indexOf(PRELOAD_REQUEST_MARKER);
      if (at !== -1) text = text.slice(at + PRELOAD_REQUEST_MARKER.length);
    }
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat) return flat;
  }
  return undefined;
}

interface ReentryProps {
  goal?: string;
  lastAsk?: string;
  verdict?: ChatVerdict;
  /** A turn is in flight: the verdict judged an earlier one, so it is hidden. */
  running: boolean;
}

/** The three lines, each omitted when it has nothing to say. */
function SummaryLines({ goal, lastAsk, verdict, running }: ReentryProps) {
  return (
    <dl className="space-y-1.5">
      {goal && (
        <div>
          <dt className="text-2xs font-medium text-fg-subtle">Goal</dt>
          <dd className="text-fg-muted">{goal}</dd>
        </div>
      )}
      {lastAsk && (
        <div>
          <dt className="text-2xs font-medium text-fg-subtle">Last ask</dt>
          <dd className="line-clamp-2 break-words text-fg-muted" title={lastAsk}>
            {lastAsk}
          </dd>
        </div>
      )}
      {verdict && !running && (
        <div>
          <dt className="text-2xs font-medium text-fg-subtle">Where it stands</dt>
          <dd className="text-fg-muted" data-verdict={verdict.verdict}>
            {verdictLabel(verdict)}
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * The card pinned in the transcript's right margin. The caller positions it;
 * it fills the width it is given.
 */
export function ReentryMarginCard(props: ReentryProps) {
  if (!props.goal && !props.lastAsk) return null;
  return (
    <section
      aria-label="Chat summary"
      data-placement="margin"
      className={
        "rounded-lg border border-edge bg-surface/90 px-3 py-2.5 text-xs shadow-sm " +
        "backdrop-blur"
      }
    >
      <SummaryLines {...props} />
    </section>
  );
}

/**
 * The narrow-pane bar: one line collapsed (the Goal, else the Last ask), all
 * three expanded. The state is remembered per browser.
 */
export function ReentryBar(props: ReentryProps) {
  const [expanded, setExpanded] = useState(readReentryExpanded);
  const bodyId = useId();
  if (!props.goal && !props.lastAsk) return null;
  const toggle = () => {
    writeReentryExpanded(!expanded);
    setExpanded(!expanded);
  };
  return (
    <section
      aria-label="Chat summary"
      data-placement="bar"
      className="border-b border-edge bg-surface px-4 text-xs"
    >
      <div className="mx-auto w-full max-w-3xl">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          className={
            "flex w-full min-w-0 items-center gap-1.5 py-1.5 text-left text-fg-muted " +
            "hover:text-fg"
          }
        >
          <ChevronDownIcon
            width={11}
            height={11}
            className={`shrink-0 text-fg-subtle transition-transform ${
              expanded ? "" : "-rotate-90"
            }`}
          />
          {expanded ? (
            <span className="text-2xs font-medium text-fg-subtle">Chat summary</span>
          ) : (
            <span className="min-w-0 truncate">
              {props.goal ? `Goal: ${props.goal}` : `Last ask: ${props.lastAsk}`}
            </span>
          )}
        </button>
        {expanded && (
          <div id={bodyId} className="pb-2 pl-[17px]">
            <SummaryLines {...props} />
          </div>
        )}
      </div>
    </section>
  );
}
