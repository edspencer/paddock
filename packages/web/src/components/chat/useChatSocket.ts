import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect } from "react";
import { chatClient } from "../../lib/ws";
import { api } from "../../lib/api";
import { writeChatModel } from "../../lib/chatModel";
import type { ChatCompleteUsage, ChatUsage, HistoryMessage } from "../../lib/types";
import { sentFileFromToolCall } from "./toolFormatting";
import {
  type Turn,
  appendAssistantText,
  historyToTurns,
  nextId,
  sealStreaming,
  settlePending,
} from "./turnModel";

/**
 * Everything the socket subscription effect reads or writes. The refs stay OWNED
 * by {@link ChatPane} — the send/cancel paths touch them too — so this hook takes
 * them as a wide params object rather than owning any of its own state. This keeps
 * the ~12 frame handlers (the bulk of the pane) in their own module without
 * changing behavior: the effect body is identical to the inline version, and its
 * dependency array is unchanged, so it re-subscribes on exactly the same
 * chat-identity transitions (issue #403).
 */
export interface UseChatSocketParams {
  // --- chat identity + parent callbacks (the effect's dependency array) -------
  projectSlug: string;
  initialSessionId?: string;
  loadHistory?: (sessionId: string) => Promise<HistoryMessage[]>;
  onSessionEstablished?: (sessionId: string) => void;
  onSessionStarted?: (sessionId: string) => void;
  onTurnComplete?: (live?: { sessionId: string; usage: ChatCompleteUsage }) => void;
  // --- refs owned by ChatPane (send/cancel touch them too) --------------------
  sessionRef: MutableRefObject<string | null>;
  jobRef: MutableRefObject<string | null>;
  pendingCancelRef: MutableRefObject<boolean>;
  streamingRef: MutableRefObject<boolean>;
  awaitingSessionRef: MutableRefObject<boolean>;
  isNewSessionRef: MutableRefObject<boolean>;
  startedNotifiedRef: MutableRefObject<boolean>;
  establishedHereRef: MutableRefObject<string | null>;
  modelRef: MutableRefObject<string | null>;
  cancelledRef: MutableRefObject<boolean>;
  noticeThisTurnRef: MutableRefObject<boolean>;
  seenInjectionsRef: MutableRefObject<Set<string>>;
  onQueuedFlushedRef: MutableRefObject<(text?: string) => void>;
  // --- state setters ----------------------------------------------------------
  setTurns: Dispatch<SetStateAction<Turn[]>>;
  setStreaming: Dispatch<SetStateAction<boolean>>;
  setUsage: Dispatch<SetStateAction<ChatCompleteUsage | null>>;
  setSessionUsage: Dispatch<SetStateAction<ChatUsage | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/**
 * Subscribe to the shared chat socket for the currently open chat and translate
 * its ~12 frame types into transcript/turn-state updates. Extracted verbatim from
 * ChatPane's socket effect (issue #403). See {@link UseChatSocketParams}.
 */
export function useChatSocket(params: UseChatSocketParams): void {
  const {
    projectSlug,
    initialSessionId,
    loadHistory,
    onSessionEstablished,
    onSessionStarted,
    onTurnComplete,
    sessionRef,
    jobRef,
    pendingCancelRef,
    streamingRef,
    awaitingSessionRef,
    isNewSessionRef,
    startedNotifiedRef,
    establishedHereRef,
    modelRef,
    cancelledRef,
    noticeThisTurnRef,
    seenInjectionsRef,
    onQueuedFlushedRef,
    setTurns,
    setStreaming,
    setUsage,
    setSessionUsage,
    setError,
  } = params;

  // --- subscribe to the shared socket for this chat -------------------------
  useEffect(() => {
    // Guard against frames that belong to a different chat. Only one ChatPane is
    // mounted per project, so a still-streaming chat's stragglers can be routed
    // here after the user switches away (issue #35). Adopt only frames for our
    // own session — or, for a brand-new chat, the first frames of the turn we
    // just sent (identified by the awaiting/streaming flags).
    const framesBelong = (meta: { sessionId: string | null; jobId: string | null }) => {
      const mine = sessionRef.current;
      if (mine) {
        if (meta.sessionId === mine) return true;
        // A session-less frame during our own in-flight turn (server hasn't
        // stamped the id yet) is ours; one while idle is a straggler.
        return meta.sessionId == null && streamingRef.current;
      }
      // Nascent chat: accept frames only once we've sent and are awaiting our
      // own session id. Otherwise (a fresh chat the user is just looking at)
      // reject everything so another chat's stream can't bleed in.
      return awaitingSessionRef.current;
    };
    const adoptSession = (id: string) => {
      sessionRef.current = id;
      awaitingSessionRef.current = false;
      sub.setSessionId(id);
      // Tell the parent as soon as a brand-new chat learns its id (mid-stream)
      // so it can show a pending list entry right away — not at turn end.
      if (isNewSessionRef.current && !startedNotifiedRef.current) {
        startedNotifiedRef.current = true;
        // The parent mirrors this id into the URL mid-stream. Treat that like
        // the new->established transition so it does NOT re-hydrate the live
        // transcript or reset the model picker to the default when
        // initialSessionId flips: mark it established here and persist the
        // picked model onto the now-known session-id key (mirrors onComplete).
        establishedHereRef.current = id;
        if (modelRef.current) writeChatModel(id, projectSlug, modelRef.current);
        onSessionStarted?.(id);
      }
    };
    // Record the turn's now-known jobId. If the user already hit Stop during the
    // pre-arm window (`pendingCancelRef`), fire the deferred cancel right now —
    // otherwise that earlier click would have been a silent no-op (#196).
    const armJob = (id: string) => {
      jobRef.current = id;
      if (pendingCancelRef.current) {
        pendingCancelRef.current = false;
        chatClient.cancel(id);
      }
    };
    const sub = chatClient.subscribe(projectSlug, sessionRef.current, {
      onResponse: (chunk, meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) armJob(meta.jobId);
        if (meta.sessionId) adoptSession(meta.sessionId);
        appendAssistantText(setTurns, chunk);
      },
      onToolStart: (tc, meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) armJob(meta.jobId);
        if (meta.sessionId) adoptSession(meta.sessionId);
        // A slow tool (esp. a subagent) starts: show a pending "running…" row
        // right away instead of nothing until it finishes (#175). Reconciled by
        // toolUseId when its chat:tool_call completion arrives.
        setTurns((prev) => {
          // A replayed start frame (reconnect gap replay) must not double-add.
          if (
            tc.toolUseId &&
            prev.some((t) => t.kind === "tool" && t.tool.toolUseId === tc.toolUseId)
          ) {
            return prev;
          }
          // Seal the streaming text bubble first so its caret clears the instant
          // the tool begins (same reasoning as the completion path below).
          return [...sealStreaming(prev), { kind: "tool", id: nextId(), tool: tc }];
        });
      },
      onToolCall: (tc, meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) armJob(meta.jobId);
        if (meta.sessionId) adoptSession(meta.sessionId);
        // A send_file call renders as a rich `file` turn (parsed from its output
        // envelope); everything else is the generic tool widget.
        const file = sentFileFromToolCall(tc);
        setTurns((prev) => {
          // Reconcile the pending row created on chat:tool_start (#175): replace
          // it in place — keeping its Turn id for a stable React key — with the
          // finished call (or the rich file turn for send_file).
          if (tc.toolUseId) {
            const idx = prev.findIndex(
              (t) => t.kind === "tool" && t.tool.toolUseId === tc.toolUseId,
            );
            if (idx !== -1) {
              const kept = prev[idx].id;
              const next = prev.slice();
              next[idx] = file
                ? { kind: "file", id: kept, file }
                : { kind: "tool", id: kept, tool: tc };
              return next;
            }
          }
          // No pending row (start frame lost/aged out of the replay buffer, or a
          // tool with no id): seal the streaming bubble and append, as before.
          const turn: Turn = file
            ? { kind: "file", id: nextId(), file }
            : { kind: "tool", id: nextId(), tool: tc };
          return [...sealStreaming(prev), turn];
        });
      },
      onMessageBoundary: (meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) armJob(meta.jobId);
        // Seal the current streaming bubble so the next assistant message
        // renders as a separate turn.
        setTurns((prev) => sealStreaming(prev));
      },
      onComplete: (meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) armJob(meta.jobId);
        streamingRef.current = false;
        setStreaming(false);
        // Seal the streaming bubble and settle any in-flight tool row whose
        // completion never arrived (#175 backstop) so no spinner survives the turn.
        setTurns((prev) => settlePending(sealStreaming(prev)));
        // Stale-by-one-turn context meter: store the last completed turn's
        // usage for this chat (omitted by the server when none was observed).
        if (meta.usage) setUsage(meta.usage);
        // Refresh the cumulative session totals (issue #152) now that the turn
        // just written a fresh usage line to the transcript. Best-effort — the
        // per-turn meter above already updated; this only re-tots the lifetime
        // figure. Uses the (possibly newly-minted) session id from the frame.
        {
          const sid = meta.sessionId ?? sessionRef.current;
          if (sid) {
            void api
              .chatContext(projectSlug, sid)
              .then((ctx) => setSessionUsage(ctx))
              .catch(() => {
                /* leave the prior cumulative figure in place */
              });
          }
        }
        if (meta.sessionId) {
          const wasNew = isNewSessionRef.current && sessionRef.current !== meta.sessionId;
          adoptSession(meta.sessionId);
          if (wasNew || isNewSessionRef.current) {
            isNewSessionRef.current = false;
            // Carry the new chat's picked model from its "new:<slug>" key onto
            // the now-established session-id key so reopening it restores it.
            if (modelRef.current) writeChatModel(meta.sessionId, projectSlug, modelRef.current);
            // Remember this so the parent's URL mirroring (which feeds the id
            // back as initialSessionId) doesn't trigger a re-hydration.
            establishedHereRef.current = meta.sessionId;
            onSessionEstablished?.(meta.sessionId);
          }
        }
        // A failed turn surfaces as an inline notice turn (#329, via the preceding
        // chat:notice frame) — richer, persistent, and retryable. Only fall back to
        // the transient composer-level error toast when no such notice arrived this
        // turn, so the failure is never invisible but also never double-surfaced.
        if (!meta.success && meta.error && !noticeThisTurnRef.current) setError(meta.error);
        // Pull model: a completed turn may have triggered a sweep that rewrote
        // OVERVIEW.md / CHANGELOG / added files — let the parent re-fetch. Hand
        // up the live per-turn usage (already accurate, no disk dependency) so
        // the parent can seed the chat-list ring immediately (issue #164).
        {
          const sid = meta.sessionId ?? sessionRef.current;
          onTurnComplete?.(sid && meta.usage ? { sessionId: sid, usage: meta.usage } : undefined);
        }
        // Issue #245: the SERVER auto-sends any queued follow-up (it drains its own
        // persisted copy on a successful turn and streams the next turn back here,
        // then a chat:queued_flushed clears our copy). The client no longer flushes
        // the queue itself — that removed a stranding path (a completion arriving
        // while the socket was down never fired the client flush) and a double-send
        // (client + server both sending). Just clear the Stop-hold marker.
        cancelledRef.current = false;
      },
      onError: (err) => {
        // chat:error carries no session id, so it can't be session-routed.
        // Only surface it when this pane actually has a turn in flight —
        // otherwise it's another chat's error leaking into an idle pane.
        if (!streamingRef.current) return;
        streamingRef.current = false;
        setStreaming(false);
        jobRef.current = null;
        setTurns((prev) => settlePending(sealStreaming(prev)));
        setError(err);
        // Hold the queue on error (#91) but clear the cancel flag so it can't
        // suppress a later turn's flush.
        cancelledRef.current = false;
      },
      onResync: () => {
        // Rare (#54): the server's live-turn buffer aged out before we could
        // re-attach, so it asked us to re-hydrate. Reload the transcript to catch
        // up on the gap; live frames for the still-running turn keep appending.
        const sid = sessionRef.current;
        if (!sid || !loadHistory) return;
        void loadHistory(sid)
          .then((msgs) => setTurns(historyToTurns(msgs)))
          .catch(() => {
            /* keep whatever we already have */
          });
      },
      onActive: ({ running, jobId }) => {
        // The server reports this chat's live-turn status (#52). On a pane that
        // navigated back to a still-streaming chat this restores the Stop button
        // and the job id needed to cancel — state a remount would otherwise lose.
        if (running) {
          if (jobId) armJob(jobId);
          streamingRef.current = true;
          setStreaming(true);
        } else {
          // The turn ended (possibly while we were away): clear the running UI.
          streamingRef.current = false;
          setStreaming(false);
          jobRef.current = null;
          setTurns((prev) => sealStreaming(prev));
          cancelledRef.current = false;
          pendingCancelRef.current = false;
        }
      },
      onQueuedFlushed: ({ text }) => {
        // The server auto-sent (or cleared a stale copy of) our queued message
        // (#245). Reflect it: render the sent bubble + clear the queue toolbar.
        onQueuedFlushedRef.current(text);
      },
      onInjected: (inj, meta) => {
        // A machine injected a user turn into THIS open chat (#290 Part 2):
        // another chat send_message'd / a schedule fired. Render its bubble live
        // (with the sender attribution) so it no longer takes a refresh to appear.
        if (!framesBelong(meta)) return;
        if (meta.jobId) armJob(meta.jobId);
        if (meta.sessionId) adoptSession(meta.sessionId);
        // Dedup a hub REPLAY (which re-delivers the buffered frame verbatim,
        // same server timestamp) while still rendering a genuinely new injection
        // — even one with identical text — since that carries a fresh timestamp.
        // `content` rides in the key too so a clock with only second-granularity
        // can't merge two distinct same-second injections.
        const key = `${inj.timestamp} ${inj.content}`;
        if (seenInjectionsRef.current.has(key)) return;
        seenInjectionsRef.current.add(key);
        setTurns((prev) => [
          ...sealStreaming(prev),
          { kind: "user", id: nextId(), content: inj.content, sender: inj.sender },
        ]);
      },
      onKilledTask: ({ summary, timestamp }) => {
        // A background task was killed at the turn boundary (#347) — surfaced LIVE
        // by the recovery engine (its notification is otherwise trapped in the SDK
        // input queue). Append the terminated-notification turn so the amber
        // "keeper is idle / Continue" affordance renders inline without a refresh.
        // Dedup on timestamp so a re-delivery can't stack duplicate notices.
        const key = `killed ${timestamp}`;
        if (seenInjectionsRef.current.has(key)) return;
        seenInjectionsRef.current.add(key);
        setTurns((prev) => [
          ...sealStreaming(prev),
          { kind: "notification", id: nextId(), summary, status: "killed" },
        ]);
      },
      onNotice: (notice, meta) => {
        if (!framesBelong(meta)) return;
        // A turn dead-ended without a normal reply (#329): a usage-limit hit, the
        // max-turns cap, or an error. Seal any streaming bubble and append a
        // distinct notice turn so the chat shows WHY it stopped. Mark the turn so
        // the failed-completion path doesn't also raise the transient error toast.
        noticeThisTurnRef.current = true;
        setTurns((prev) => [...sealStreaming(prev), { kind: "notice", id: nextId(), notice }]);
      },
    });
    return () => {
      sub.unsubscribe();
    };
    // Re-subscribe when the chat identity changes. Refs + setters are stable, so
    // the dependency array is exactly the inline effect's (issue #403).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug, initialSessionId, loadHistory, onSessionEstablished, onSessionStarted, onTurnComplete]);
}
