import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import { Tooltip } from "../Tooltip";
import {
  ArrowDownToLineIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "../icons";

// The transcript nav: five buttons beside the composer that move the transcript
// by message (Up / Down), by section (Back / Forward), or to the end.
//
// A "message" is a top-level row of the transcript — a user bubble, an assistant
// reply, a tool card, a notice. A "section" is an exchange, which starts at a
// message the user typed: a user row with no `sender`, marked `data-ask` by
// TurnView. Injected messages, task notifications, slash commands and command
// output are not section starts; an attachment-only message is.
//
// Each row has a stop: the scrollTop that puts its start NAV_TOP_GAP below the
// viewport's top (0 for the first row, so what sits above it shows too), clamped
// to the scroll range. Up goes to the last stop above the current scrollTop and
// Down to the first stop below it. So Up from part-way through a row goes to that
// row's start first, as a media player's "previous" restarts the track; from a
// row's start it goes to the row before. Back and Forward do the same over the
// section starts only.

/** How far below the viewport's top a row's start lands after a move, in px. */
export const NAV_TOP_GAP = 12;
/** Slack for sub-pixel layout when comparing a stop with the scrollTop. */
const EPS = 2;

export interface NavRow {
  /** The row's start, in the scroll container's content coordinates. */
  top: number;
  /** The row is a message the user typed: a section starts here. */
  ask: boolean;
}

/** The scrollTop each move would go to, or null where there is nowhere to go. */
export interface NavTargets {
  up: number | null;
  down: number | null;
  back: number | null;
  forward: number | null;
}

/**
 * The four moves' targets for `rows` (in document order) viewed from `scrollTop`,
 * with the container able to scroll to `maxScroll`.
 */
export function navTargets(
  rows: readonly NavRow[],
  scrollTop: number,
  maxScroll: number,
): NavTargets {
  const t: NavTargets = { up: null, down: null, back: null, forward: null };
  for (let i = 0; i < rows.length; i++) {
    const stop = i === 0 ? 0 : Math.max(0, Math.min(maxScroll, rows[i].top - NAV_TOP_GAP));
    if (stop < scrollTop - EPS) {
      t.up = stop;
      if (rows[i].ask) t.back = stop;
    } else if (stop > scrollTop + EPS) {
      t.down ??= stop;
      if (rows[i].ask) {
        t.forward = stop;
        break;
      }
    }
  }
  return t;
}

/** The transcript's rows, measured: the list's children, in content coordinates. */
function measureRows(el: HTMLElement, list: HTMLElement): NavRow[] {
  const origin = el.getBoundingClientRect().top - el.scrollTop;
  return Array.from(list.children, (row) => ({
    top: row.getBoundingClientRect().top - origin,
    ask: row.hasAttribute("data-ask"),
  }));
}

export type NavMove = keyof NavTargets | "end";

export interface TranscriptNavState {
  /** Which moves have somewhere to go. */
  can: Record<NavMove, boolean>;
  go: (move: NavMove) => void;
  /** The scroll container's onScroll: the pane's own handler, then a re-measure. */
  onScroll: () => void;
}

/**
 * The nav's state and moves, layered on ChatPane's scroll management. A move is
 * a deliberate jump, so it first unpins, then sets scrollTop and runs the pane's
 * own onScroll on the spot: the pane's rule (a move down to near the bottom
 * re-pins) then decides from where the move landed, and the browser's later
 * scroll event reads as no move. End snaps to the bottom and re-pins. Moves are
 * instant rather than smooth, so a streamed chunk can't snap an animation away
 * and a second click counts from where the first one landed.
 */
export function useTranscriptNav({
  scrollRef,
  listRef,
  pinnedRef,
  onScroll,
  snapToBottom,
  turns,
}: {
  scrollRef: RefObject<HTMLElement>;
  listRef: RefObject<HTMLElement>;
  pinnedRef: MutableRefObject<boolean>;
  onScroll: () => void;
  snapToBottom: (el: HTMLElement) => void;
  /** Re-measured whenever this changes. */
  turns: unknown;
}): TranscriptNavState {
  const targets = useCallback((): NavTargets | null => {
    const el = scrollRef.current;
    const list = listRef.current;
    if (!el || !list) return null;
    return navTargets(measureRows(el, list), el.scrollTop, el.scrollHeight - el.clientHeight);
  }, [scrollRef, listRef]);

  // One string, so an unchanged answer bails out of re-rendering the pane.
  const [key, setKey] = useState("00000");
  const refresh = useCallback(() => {
    const el = scrollRef.current;
    const t = targets();
    if (!el || !t) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    const end = !(atBottom && pinnedRef.current);
    setKey(
      [t.up, t.down, t.back, t.forward].map((v) => (v === null ? "0" : "1")).join("") +
        (end ? "1" : "0"),
    );
  }, [scrollRef, pinnedRef, targets]);

  // After the pane's own layout effect, which may have just snapped to the bottom.
  useLayoutEffect(refresh, [turns, refresh]);
  // Resizes move rows without a scroll or a `turns` change. Created after the
  // pane's own observer, so it runs after any snap that one makes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(refresh);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [scrollRef, refresh]);

  const go = useCallback(
    (move: NavMove) => {
      const el = scrollRef.current;
      if (!el) return;
      if (move === "end") {
        snapToBottom(el);
        pinnedRef.current = true;
      } else {
        const top = targets()?.[move];
        if (top == null) return;
        pinnedRef.current = false;
        el.scrollTop = top;
        onScroll();
      }
      refresh();
    },
    [scrollRef, pinnedRef, snapToBottom, onScroll, targets, refresh],
  );

  return {
    can: {
      up: key[0] === "1",
      down: key[1] === "1",
      back: key[2] === "1",
      forward: key[3] === "1",
      end: key[4] === "1",
    },
    go,
    onScroll: useCallback(() => {
      onScroll();
      refresh();
    }, [onScroll, refresh]),
  };
}

/** The 24px icon button the chat actions use, dimmed when it has nowhere to go. */
const ICON_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition " +
  "hover:bg-surface-active hover:text-fg aria-disabled:pointer-events-none aria-disabled:opacity-40";

const BUTTONS: ReadonlyArray<{
  move: NavMove;
  label: string;
  Icon: typeof ChevronUpIcon;
  className?: string;
}> = [
  { move: "up", label: "Previous message", Icon: ChevronUpIcon },
  { move: "down", label: "Next message", Icon: ChevronDownIcon },
  // In the wide grid the media pair and End start a second row, under Up / Down.
  {
    move: "back",
    label: "Previous section (your last message)",
    Icon: SkipBackIcon,
    className: "@[57rem]:col-start-1",
  },
  { move: "forward", label: "Next section", Icon: SkipForwardIcon },
  { move: "end", label: "Jump to latest", Icon: ArrowDownToLineIcon },
];

/** The five buttons. Their container (ChatPane) lays them out. */
export function TranscriptNavButtons({ nav }: { nav: TranscriptNavState }) {
  return (
    <>
      {BUTTONS.map(({ move, label, Icon, className }) => (
        <Tooltip key={move} content={label} className={className}>
          <button
            type="button"
            aria-label={label}
            // Not `disabled`: a button that disables itself under the focus a click
            // gave it drops keyboard focus to the body.
            aria-disabled={!nav.can[move]}
            onClick={() => nav.can[move] && nav.go(move)}
            className={ICON_BUTTON}
          >
            <Icon width={14} height={14} />
          </button>
        </Tooltip>
      ))}
    </>
  );
}
