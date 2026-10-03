import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { formatElapsed, relativeTime } from "../lib/format";
import { useProjects } from "../lib/projects-context";
import type { AttentionChat } from "../lib/types";
import { chatClient } from "../lib/ws";
import { ROOT_KEY, viewBase } from "../routes/ProjectView/urls";
import { MigrationOfferBanner } from "./MigrationOffer";
import { cx } from "./ui/cx";

/**
 * The fleet readout (#784) — a strip above every route saying what the herd is
 * doing right now.
 *
 * Paddock is a control surface for a herd of running agents, and until this
 * existed the app could not answer the operator's first question from any screen
 * but Home: *what is running, and for how long?* The sidebar's badge said "2
 * in-flight"; it did not say for how long, in which project, or whether either
 * one was about to run out of context. Two of the five things reported here did
 * not exist anywhere in the UI before: a turn's ELAPSED time (a forty-minute
 * turn and an eight-second one looked identical) and its CONTEXT pressure
 * (visible only inside the chat it belonged to — by which point you had opened
 * it anyway).
 *
 * ## The one rule
 *
 * **The only thing that moves in here is the elapsed clocks, because that is
 * data.** No pulsing lamp, no sweeping bar, no shimmer. `docs/DESIGN.md` says
 * frequency decides whether to animate at all, and a persistent readout is on
 * screen 100% of the time — anything decorative in it is decorative forever.
 * The counters advancing IS the running indicator; a second animation on top of
 * them would say the same thing twice, louder.
 *
 * ## Where the data comes from — and what it deliberately does NOT cost
 *
 * This component renders on every route, so its cost at rest has to be zero.
 * Everything except two fields is already in the client:
 *
 * - **Which turns are running, in which project, since when** — `onActiveInfos`
 *   plus `turnStartedAt`, both fed by the existing `chat:active` frames. The
 *   server broadcasts those to every socket and replays the whole running
 *   snapshot on connect, so this works on a first paint with no chat pane
 *   mounted, and survives a reload mid-turn. No fetch.
 * - **The counts** — handed down from `AppShell`, which already derives
 *   fleet-wide unread and in-flight for the sidebar badges out of the projects
 *   payload it has anyway. Sharing that derivation is not just a saved request:
 *   an independent one would let this strip disagree with the badges two inches
 *   to its left.
 * - **Project names, and the fleet's last sign of life** — the projects context,
 *   already loaded for the sidebar.
 *
 * That leaves the chat's NAME and its CONTEXT FILL, which only
 * `GET /api/root/chats/attention` knows. So that is the one request, and
 * {@link useChatDetails} makes it only while the strip has a channel on it —
 * a running turn, or a finished one holding an unread reply — and REFRESHES it
 * only while something is running, so an idle fleet with nothing unread issues
 * no requests and arms no timers. An earlier draft mounted
 * Home's `useAttentionChats` here instead, which put a fleet-wide fetch and a
 * permanent 30-second poll on every route in the app whether anything was
 * running or not.
 *
 * {@link MigrationOfferBanner} (#882) adds the strip's second request: ONE
 * `GET /api/transcripts/migration` per page load, never a poll and never a
 * timer. It is a readdir per project behind a server-side memo, the answer
 * cannot change without a restart, and it is shared by every consumer on the
 * page — so "an idle fleet arms no timers" still holds, and the readout's cost
 * at rest is unchanged.
 */

/**
 * The channels no longer collapse into `+N` past a breakpoint-dependent count.
 * Running and finished channels together can run well past the viewport, so the
 * row SCROLLS sideways (scrollbar hidden, end faded while there is more) instead
 * of truncating to a guess at what fits. The counts on the left stay exact
 * whatever is scrolled out of view, which is what kept `+N` honest before.
 */

/** Segments in a context meter. Discrete on purpose — a gauge, not a progress bar. */
const METER_SEGMENTS = 6;

/** Context fill at which the meter changes hue. Below `WARN` it is just the accent. */
const METER_WARN = 0.75;
const METER_DANGER = 0.9;

/**
 * How long after the running set moves before asking for the new turns' details.
 * A single turn boundary fires two transitions in quick succession (this one
 * stopped, that one started) and a burst of wake-ups can fire a dozen, so they
 * coalesce into one request.
 */
const DETAIL_DEBOUNCE_MS = 250;

/**
 * How often to re-ask while turns are running. This is a REFRESH, not a poll for
 * liveness: start and stop arrive over the socket, and the only thing that goes
 * stale between them is the context fill, which grows as the turn does. Runs
 * only while something is running and the tab is visible, so an idle instance
 * schedules nothing at all.
 */
const DETAIL_REFRESH_MS = 30_000;

/**
 * The strip's clock. One second while something is running — the elapsed
 * counters are the running indicator — and thirty while only FINISHED channels
 * are up, whose "4m ago" moves by the minute. Nothing up, nothing armed.
 */
function useTick(intervalMs: number | null): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (intervalMs == null) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

/** The fleet's live running map (sessionId -> projectSlug), fleet-wide, no fetch. */
function useRunningSessions(): ReadonlyMap<string, string> {
  const [running, setRunning] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => chatClient.onActiveInfos((infos) => setRunning(new Map(infos))), []);
  return running;
}

/**
 * Chat name + context fill for the channels on the strip, keyed by session id.
 *
 * The gate is the point. `runningKey` and `finishedKey` are stable digests of
 * the session ids on the strip, so this effect re-runs when its composition
 * changes and at no other time; with neither, there is no fetch, no interval and
 * no retained rows. The 30-second REFRESH runs only while something is RUNNING
 * (a running chat's context fill grows; a finished one's name does not change),
 * so a fleet holding only unread replies costs one request when that set moves
 * and then nothing.
 *
 * Rows MERGE rather than replace. A turn that has just ended is, for a beat,
 * neither running nor unread on the server (its job record lands a moment
 * after the socket says it stopped — see `useAttentionChats`), so a replacing
 * fetch in that window would strip the name off the channel the user is about
 * to click. Entries are pruned only when their session leaves the strip.
 */
function useChatDetails(
  runningKey: string,
  finishedKey: string,
): ReadonlyMap<string, AttentionChat> {
  const [details, setDetails] = useState<ReadonlyMap<string, AttentionChat>>(new Map());
  // Guards an out-of-order response: two fetches in flight, the older landing
  // last, would overwrite fresh rows with stale ones.
  const seqRef = useRef(0);

  useEffect(() => {
    const wanted = new Set([...runningKey.split(","), ...finishedKey.split(",")].filter(Boolean));
    if (wanted.size === 0) {
      seqRef.current++; // abandon anything in flight from the last strip
      setDetails(new Map());
      return;
    }
    // Drop rows for sessions that left the strip right away; no fetch needed.
    setDetails((prev) => {
      const next = new Map([...prev].filter(([id]) => wanted.has(id)));
      return next.size === prev.size ? prev : next;
    });
    let cancelled = false;
    const load = async () => {
      const seq = ++seqRef.current;
      try {
        const res = await api.attentionChats(ROOT_KEY);
        if (cancelled || seq !== seqRef.current) return;
        setDetails((prev) => {
          const next = new Map([...prev].filter(([id]) => wanted.has(id)));
          // Unread first so a RUNNING row (which carries the live context fill)
          // wins for a session somehow in both.
          for (const c of [...(res.recent ?? []), ...(res.unread ?? []), ...(res.running ?? [])]) {
            if (!wanted.has(c.sessionId)) continue;
            const before = next.get(c.sessionId);
            // A finished row carries no usage (the server resolves it only for
            // live turns); keep the last gauge the running row had.
            next.set(
              c.sessionId,
              c.contextTokens == null && before?.contextTokens != null
                ? { ...c, contextTokens: before.contextTokens, contextLimit: before.contextLimit }
                : c,
            );
          }
          return next;
        });
      } catch {
        // Leave the last-known rows up. A failed refresh must not blank a strip
        // whose clocks the socket is still driving correctly.
      }
    };

    const debounce = setTimeout(() => void load(), DETAIL_DEBOUNCE_MS);
    const refresh = runningKey
      ? setInterval(() => {
          if (document.visibilityState === "visible") void load();
        }, DETAIL_REFRESH_MS)
      : null;
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      if (refresh) clearInterval(refresh);
    };
  }, [runningKey, finishedKey]);

  return details;
}

/**
 * A discrete context gauge — a row of lit segments, not a smooth progress bar.
 *
 * Renders NOTHING when the chat has no usage data yet. An instrument that shows
 * an empty gauge is claiming a measurement it does not have: six unlit segments
 * look like "0% context used", which is the opposite of "we have not measured
 * this chat". Absent is the honest state, and it also keeps the channel narrow
 * on the chats that have never completed a turn.
 *
 * A MEASURED zero therefore lights nothing (#819). An unconditional
 * `Math.max(1, …)` floor used to render 0% as 1/6 lit while the title beside it
 * read "Context 0% full". But the floor cannot simply be dropped: with six
 * segments, `Math.round` sends every fill below 1/12 (8.3%) to zero, so a chat
 * at 3% would draw the same empty gauge as a measured zero — the same conflation
 * in the other direction. Both claims have to be kept distinct, so the floor is
 * retained strictly above zero.
 */
function Meter({ fill }: { fill: number }) {
  const filled =
    fill <= 0 ? 0 : Math.max(1, Math.min(METER_SEGMENTS, Math.round(fill * METER_SEGMENTS)));
  const hue =
    fill < METER_WARN
      ? "bg-accent-solid"
      : fill < METER_DANGER
        ? "bg-warn-solid"
        : "bg-danger-solid";
  return (
    <span
      className="flex items-center gap-px"
      title={`Context ${Math.round(fill * 100)}% full`}
      aria-hidden="true"
    >
      {Array.from({ length: METER_SEGMENTS }, (_, i) => (
        <span key={i} className={cx("h-2.5 w-[3px] rounded-[1px]", i < filled ? hue : "bg-edge")} />
      ))}
    </span>
  );
}

/**
 * One running turn, as a mixing-desk channel strip: project, clock, gauge.
 * The whole strip is the hit target (>=24px tall) and navigates to that chat.
 */
function Channel({
  projectSlug,
  projectName,
  chatName,
  sessionId,
  startedAt,
  fill,
}: {
  projectSlug: string;
  projectName: string;
  chatName: string | null;
  sessionId: string;
  startedAt: number | null;
  fill: number | null;
}) {
  const time = startedAt == null ? "—:—" : formatElapsed(Date.now() - startedAt);
  const label = chatName ?? "Running turn";
  return (
    <Link
      data-testid="fleet-channel"
      to={`${viewBase(projectSlug)}/chat/${encodeURIComponent(sessionId)}`}
      title={`${label} — ${projectName}`}
      aria-label={`${label} in ${projectName}, running${startedAt == null ? "" : ` for ${time}`}`}
      className="focus-visible:focus-ring flex h-6 shrink-0 items-center gap-2 rounded-md border border-edge-subtle bg-surface px-2 text-2xs can-hover:hover:border-edge can-hover:hover:bg-surface-hover"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-accent-solid" aria-hidden="true" />
      <span className="max-w-[14ch] truncate font-medium text-fg">{projectName}</span>
      <span className="font-mono tabular text-fg-muted">{time}</span>
      {fill != null && <Meter fill={fill} />}
    </Link>
  );
}

/** One unread reply the strip is holding up for the operator — see {@link FleetReadout}. */
export interface FinishedChat {
  sessionId: string;
  projectSlug: string;
  /** When its last turn landed, epoch ms. */
  at: number;
}

/**
 * A turn that has FINISHED and holds a reply nobody has read yet — the running
 * channel's afterlife. Same footprint and hit target, so the strip reads as one
 * row of chats, but visibly at rest: no surface fill (it sits flush on the
 * sunken strip rather than raised like a live one), the UNREAD stat's warn tone
 * for its square instead of the live accent, and a static "4m ago" where the
 * clock was. Opening the chat marks it seen, and it leaves the strip.
 */
function FinishedChannel({
  projectSlug,
  projectName,
  chatName,
  sessionId,
  at,
  fill,
}: {
  projectSlug: string;
  projectName: string;
  chatName: string | null;
  sessionId: string;
  at: number;
  fill: number | null;
}) {
  const ago = relativeTime(new Date(at).toISOString());
  const label = chatName ?? "Finished turn";
  return (
    <Link
      data-testid="fleet-finished"
      to={`${viewBase(projectSlug)}/chat/${encodeURIComponent(sessionId)}`}
      title={`${label} — ${projectName} · finished ${ago}, unread`}
      aria-label={`${label} in ${projectName}, finished ${ago}, unread`}
      className="focus-visible:focus-ring flex h-6 shrink-0 items-center gap-2 rounded-md border border-dashed border-edge px-2 text-2xs can-hover:hover:border-solid can-hover:hover:bg-surface-hover"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn-solid" aria-hidden="true" />
      <span className="max-w-[14ch] truncate font-medium text-fg-muted">{projectName}</span>
      <span className="text-fg-subtle">{ago}</span>
      {fill != null && (
        <span className="opacity-50">
          <Meter fill={fill} />
        </span>
      )}
    </Link>
  );
}

/**
 * Sideways scrolling for the channel row, with no scrollbar drawn: reports
 * whether there is more to either side (to fade that edge) and turns a plain
 * vertical mouse wheel into horizontal scroll, since a wheel-only mouse has no
 * other way to reach a scrolled-off channel.
 */
function useSideScroll(): {
  ref: React.RefObject<HTMLDivElement>;
  moreLeft: boolean;
  moreRight: boolean;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [moreLeft, setMoreLeft] = useState(false);
  const [moreRight, setMoreRight] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setMoreLeft(el.scrollLeft > 1);
      setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    // Children come and go (a turn starts, a reply is read) and the strip
    // resizes with the window; both change whether it overflows.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(measure);
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener("scroll", measure);
      el.removeEventListener("wheel", onWheel);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, []);
  return { ref, moreLeft, moreRight };
}

/** A count with its unit, as one hit target. `tone` carries the only colour. */
function Stat({
  value,
  unit,
  to,
  tone,
  title,
}: {
  value: number;
  unit: string;
  to: string;
  tone: "live" | "attention" | "rest";
  title: string;
}) {
  return (
    <Link
      data-testid={`fleet-${unit}`}
      to={to}
      title={title}
      className="focus-visible:focus-ring flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 can-hover:hover:bg-surface-hover"
    >
      <span
        aria-hidden="true"
        className={cx(
          "h-1.5 w-1.5 shrink-0 rounded-[1px]",
          tone === "live" && "bg-accent-solid",
          tone === "attention" && "bg-warn-solid",
          tone === "rest" && "bg-edge-strong",
        )}
      />
      {/* The NUMBER carries its own hook. The link's own text is the count and
          the unit run together ("0running"), so an exact-text assertion on the
          link is a trap — it reads fine and breaks the moment the label moves. */}
      <span
        data-testid={`fleet-${unit}-value`}
        className="font-mono tabular text-2xs font-semibold text-fg"
      >
        {value}
      </span>
      <span className="text-3xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">
        {unit}
      </span>
    </Link>
  );
}

/**
 * @param unread Fleet-wide unread count, from the shell's own badge derivation.
 *   Passed in rather than fetched so this strip and the sidebar badges are one
 *   number computed once — see the note at the top of this file.
 * @param finished The unread chats themselves, newest first, from that SAME
 *   derivation — so the finished channels and the UNREAD count can never
 *   disagree about which chats are waiting.
 */
export function FleetReadout({
  unread,
  finished = [],
}: {
  unread: number;
  finished?: FinishedChat[];
}) {
  const { projects, rootWorkspace } = useProjects();
  const running = useRunningSessions();

  // A stable digest of WHICH turns are running. The map identity changes on
  // every `chat:active` frame — including the mid-turn one that resolves a
  // jobId — and keying the fetch on that would re-request several times per
  // turn for a fleet whose composition never changed.
  const runningKey = useMemo(() => [...running.keys()].sort().join(","), [running]);
  const finishedKey = useMemo(() => finished.map((f) => f.sessionId).join(","), [finished]);
  const details = useChatDetails(runningKey, finishedKey);

  useTick(running.size > 0 ? 1000 : finished.length > 0 ? 30_000 : null);
  const side = useSideScroll();

  // slug -> display name, for the channel labels. The root workspace is a real
  // place a turn can run, and its key is `""` — a falsy guard here would drop
  // every root chat from the strip without a trace.
  const projectNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.slug, p.name);
    if (rootWorkspace) m.set(rootWorkspace.slug, rootWorkspace.name);
    return m;
  }, [projects, rootWorkspace]);

  // The clock is the point of ordering: the longest-running turn is the one most
  // likely to be wedged, so it leads — nearest the counts, never scrolled off
  // the start. Built from the SOCKET's running map, not from the fetched
  // rows — a turn that started a moment ago appears immediately, with whatever
  // detail has arrived so far.
  const channels = useMemo(() => {
    return [...running.entries()]
      .map(([sessionId, projectSlug]) => {
        const detail = details.get(sessionId);
        return {
          sessionId,
          projectSlug,
          projectName: projectNames.get(projectSlug) ?? detail?.projectName ?? projectSlug,
          chatName: detail?.name ?? null,
          startedAt: chatClient.turnStartedAt(sessionId),
          fill:
            detail?.contextTokens != null && detail.contextLimit
              ? Math.min(1, detail.contextTokens / detail.contextLimit)
              : null,
        };
      })
      // Unknown start times sort last: we cannot claim they are the oldest.
      .sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
  }, [running, details, projectNames]);

  const fillOf = (d: AttentionChat | undefined) =>
    d?.contextTokens != null && d.contextLimit ? Math.min(1, d.contextTokens / d.contextLimit) : null;

  // Finished, unread, newest first (the shell already sorted them), to the
  // RIGHT of every running channel: live work leads, and the reply that landed
  // a moment ago sits next to it rather than behind last week's.
  const finishedChannels = finished.map((f) => {
    const detail = details.get(f.sessionId);
    return {
      ...f,
      projectName: projectNames.get(f.projectSlug) ?? detail?.projectName ?? f.projectSlug,
      chatName: detail?.name ?? null,
      fill: fillOf(detail),
    };
  });

  // The fleet's last sign of life, for when nothing is running. Every workspace
  // payload already carries its chats' completed-turn times, so this is free.
  const lastTurnAt = useMemo(() => {
    let newest = "";
    for (const p of rootWorkspace ? [...projects, rootWorkspace] : projects) {
      for (const t of p.chatTurns ?? []) {
        if (t.lastTurnCompletedAt > newest) newest = t.lastTurnCompletedAt;
      }
    }
    return newest;
  }, [projects, rootWorkspace]);

  // Announce only the counts, and only when they change — a live region that
  // re-read every ticking clock once a second would be unusable.
  const summary =
    running.size === 0
      ? `Fleet idle. ${unread} unread.`
      : `${running.size} running. ${unread} unread.`;

  return (
    <div
      data-testid="fleet-readout"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-edge-subtle bg-surface-sunken px-2 sm:px-3"
    >
      {/*
        A "FLEET" label sat here and came off. It was the only element in this
        strip that carried no data — the counts next to it already say RUNNING
        and UNREAD, so it was naming something self-evident, and on a narrow
        viewport it was spending ~50px that a channel could use. Everything left
        in here is a number or the thing that makes a number legible.

        The strip keeps its height when the fleet is idle rather than collapsing
        to the counts. A readout that disappears cannot be told from a readout
        that broke, and a row that appears the instant a turn starts would shove
        every route down by 36px at the least welcome moment.
      */}
      <Stat
        value={running.size}
        unit="running"
        to="/"
        tone={running.size > 0 ? "live" : "rest"}
        title={running.size > 0 ? "Turns in flight across every project" : "Nothing running"}
      />
      <Stat
        value={unread}
        unit="unread"
        to="/"
        tone={unread > 0 ? "attention" : "rest"}
        title="Chats holding a reply you have not read"
      />

      <span className="h-4 w-px shrink-0 bg-edge-subtle" aria-hidden="true" />

      {/* The channels: running, then finished-and-unread. `min-w-0` so the row
          takes the leftover width rather than pushing the strip wide; it
          scrolls sideways past that, scrollbar hidden and an edge faded while
          there is more that way. A finger swipe scrolls it natively; the
          overscroll containment stops a swipe that hits either end from
          turning into the browser's back/forward gesture. */}
      <div
        ref={side.ref}
        data-testid="fleet-channels"
        className={cx(
          "scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain",
          side.moreLeft && side.moreRight
            ? "fade-both"
            : side.moreLeft
              ? "fade-start"
              : side.moreRight && "fade-end",
        )}
      >
        {channels.map((c) => (
          <Channel
            key={c.sessionId}
            projectSlug={c.projectSlug}
            projectName={c.projectName}
            chatName={c.chatName}
            sessionId={c.sessionId}
            startedAt={c.startedAt}
            fill={c.fill}
          />
        ))}
        {finishedChannels.map((c) => (
          <FinishedChannel
            key={c.sessionId}
            projectSlug={c.projectSlug}
            projectName={c.projectName}
            chatName={c.chatName}
            sessionId={c.sessionId}
            at={c.at}
            fill={c.fill}
          />
        ))}

        {/* Idle. Not a void: it says when the fleet last did anything, or — on a
            genuinely empty instance — offers the one thing there is to do.
            `/chat`, not `/` (#865). It pointed at Home, and on the empty instance
            this line is written for, Home WAS the Discover takeover — a screen
            with no button on it. The one affordance promising something to do
            delivered the user back to the screen that had nothing. Home is fixed
            now too, but a link that says "start a chat" should start a chat. */}
        {channels.length === 0 &&
          finishedChannels.length === 0 &&
          (lastTurnAt ? (
            <span className="truncate text-2xs text-fg-subtle">
              Idle · last turn {relativeTime(lastTurnAt)}
            </span>
          ) : (
            <Link
              to="/chat"
              className="focus-visible:focus-ring truncate rounded-md px-1 text-2xs text-accent can-hover:hover:underline"
            >
              No turns yet — start a chat →
            </Link>
          ))}
      </div>

      {/* The transcript-migration offer (#882). It lives in the space the
          channels leave empty — which on most instances is all of it — and it
          renders NOTHING unless the server says a migration is available, so an
          instance already on `host`, or one whose probe fails or is slow, gets
          today's strip unchanged down to the pixel. It is deliberately OUTSIDE
          the `overflow-hidden` channel column: a chip that a busy fleet could
          clip away would be a discovery surface that disappears exactly when
          the app is being used most. */}
      <MigrationOfferBanner />

      <span role="status" aria-live="polite" className="sr-only">
        {summary}
      </span>
    </div>
  );
}
