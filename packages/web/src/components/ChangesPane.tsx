// The per-project "Changes" panel: uncommitted files + diff + commit + push,
// plus an unobtrusive "Connect GitHub" device-flow affordance in its header.
//
// Built against the live git backing-store endpoints (see lib/api.ts):
//   GET  /api/git                              -> fleet-wide GitInfo
//   GET  /api/projects/:slug/git/status        -> GitProjectStatus
//   GET  /api/projects/:slug/git/diff?file=    -> text/plain unified diff
//   POST /api/projects/:slug/git/commit        -> GitCommitResult
//   POST /api/git/push                         -> GitPushResult
//   POST /api/git/github/{connect,poll,disconnect}  -> device flow
//
// The whole surface gracefully no-ops when the projects dir isn't a git repo
// (callers gate on gitStatus(slug).repo before mounting this; it also self-
// guards). Styling mirrors the app's existing Tailwind/dark-mode idioms.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { GitFileChange, GitInfo, GitProjectStatus } from "../lib/types";
import {
  AlertIcon,
  BranchIcon,
  CheckIcon,
  GithubIcon,
  LinkIcon,
  UploadIcon,
} from "./icons";

/**
 * Map a porcelain status code to a short, color-coded badge. Untracked files
 * carry "??"; renames carry an "R…" code. We keep the raw first letter so any
 * code the server emits still renders sensibly.
 */
function statusBadge(file: GitFileChange): { label: string; cls: string } {
  const code = file.untracked ? "??" : (file.status || "").trim();
  const head = code[0]?.toUpperCase() ?? "";
  if (file.untracked || head === "?")
    return { label: "??", cls: "bg-paddock-200/70 text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300" };
  if (head === "A")
    return { label: "A", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400" };
  if (head === "D")
    return { label: "D", cls: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400" };
  if (head === "R")
    return { label: "R", cls: "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-400" };
  if (head === "M")
    return { label: "M", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400" };
  return {
    label: head || code || "•",
    cls: "bg-paddock-200/70 text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300",
  };
}

export interface ChangesPaneProps {
  slug: string;
  /** Initial status (already fetched by the parent to drive the tab badge). */
  status: GitProjectStatus;
  /** Re-fetch the project's status (after a commit) so the parent's badge updates too. */
  onStatusChange: (status: GitProjectStatus) => void;
}

export function ChangesPane({ slug, status, onStatusChange }: ChangesPaneProps) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [busyErr, setBusyErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const files = status.files;
  const uncommitted = files.length;

  // Fleet-wide git info drives push (ahead/behind, remote) + the GitHub flow.
  const loadInfo = useCallback(async () => {
    const next = await api.gitInfo().catch(() => null);
    if (next) setInfo(next);
  }, []);
  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  // Refetch this project's status (e.g. after a commit) + propagate up.
  const refreshStatus = useCallback(async () => {
    const next = await api.gitStatus(slug).catch(() => null);
    if (next) onStatusChange(next);
  }, [slug, onStatusChange]);

  // Keep the selected file valid as the status list changes; default to the
  // first changed file so the diff pane isn't empty when there's work to show.
  useEffect(() => {
    if (files.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((cur) => (cur && files.some((f) => f.path === cur) ? cur : files[0].path));
  }, [files]);

  const onCommit = useCallback(async () => {
    const msg = message.trim();
    if (!msg || committing) return;
    setCommitting(true);
    setBusyErr(null);
    setNote(null);
    try {
      const res = await api.gitCommit(slug, msg);
      if (res.committed) {
        setMessage("");
        setNote(res.hash ? `Committed ${res.hash.slice(0, 7)}` : "Committed");
        await refreshStatus();
        await loadInfo(); // ahead count moves after a commit
      } else {
        setNote(res.error ?? "Nothing to commit");
      }
    } catch (e) {
      setBusyErr(e instanceof ApiError ? e.message : "Commit failed");
    } finally {
      setCommitting(false);
    }
  }, [message, committing, slug, refreshStatus, loadInfo]);

  const ahead = info?.ahead ?? 0;
  const hasRemote = info?.configured ?? false;
  const canPush = hasRemote && ahead > 0 && !pushing;

  const onPush = useCallback(async () => {
    if (!canPush) return;
    setPushing(true);
    setBusyErr(null);
    setNote(null);
    try {
      const res = await api.gitPush();
      if (res.pushed) {
        setNote("Pushed to remote");
        await loadInfo();
      } else {
        setBusyErr(res.error ?? "Push failed");
      }
    } catch (e) {
      setBusyErr(e instanceof ApiError ? e.message : "Push failed");
    } finally {
      setPushing(false);
    }
  }, [canPush, loadInfo]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: branch + uncommitted count + push, with the GitHub affordance. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-paddock-200 px-4 py-2.5 dark:border-paddock-800">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-paddock-700 dark:text-paddock-200">
          <BranchIcon width={14} height={14} className="text-paddock-400" />
          {status.branch ?? "—"}
        </span>
        {status.clean ? (
          <span className="inline-flex items-center gap-1 text-xs text-paddock-400">
            <CheckIcon width={12} height={12} />
            clean
          </span>
        ) : (
          <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
            {uncommitted} uncommitted
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <GithubAffordance info={info} onChanged={loadInfo} />
          <button
            type="button"
            onClick={() => void onPush()}
            disabled={!canPush}
            title={
              !hasRemote
                ? "No remote configured"
                : ahead > 0
                  ? `Push ${ahead} commit${ahead === 1 ? "" : "s"} to the remote`
                  : "Nothing to push"
            }
            className="btn-ghost py-1.5 text-xs"
          >
            <UploadIcon width={13} height={13} />
            {pushing ? "Pushing…" : "Push"}
            {hasRemote && ahead > 0 && (
              <span className="text-[11px] font-semibold text-accent">↑{ahead}</span>
            )}
          </button>
        </div>
      </div>

      {(busyErr || note) && (
        <div className="px-4 pt-2">
          {busyErr && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-300">
              <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
              <span className="break-words">{busyErr}</span>
            </div>
          )}
          {!busyErr && note && (
            <p className="text-xs text-paddock-500">{note}</p>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Left: changed-files list. */}
        <div className="flex w-72 shrink-0 flex-col border-r border-paddock-200 dark:border-paddock-800">
          <div className="mb-1 mt-3 px-3">
            <span className="section-label px-0">Changed files</span>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {files.length === 0 ? (
              <p className="px-2 py-2 text-sm italic text-paddock-400">
                No uncommitted changes. Files you author surface here for a checkpoint.
              </p>
            ) : (
              files.map((f) => <FileRow key={f.path} file={f} active={selected === f.path} onSelect={() => setSelected(f.path)} />)
            )}
          </div>

          {/* Commit box. */}
          <div className="border-t border-paddock-200 p-3 dark:border-paddock-800">
            <textarea
              rows={2}
              value={message}
              placeholder="Commit message…"
              onChange={(e) => setMessage(e.target.value)}
              className="max-h-40 min-h-[44px] w-full resize-none rounded-lg border border-paddock-300 bg-paddock-50 px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-paddock-400 focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-paddock-700 dark:bg-paddock-950 dark:placeholder:text-paddock-600"
            />
            <button
              type="button"
              onClick={() => void onCommit()}
              disabled={!message.trim() || committing || files.length === 0}
              className="btn-primary mt-2 w-full py-1.5 text-xs"
              title={files.length === 0 ? "Nothing to commit" : "Commit the staged + tracked changes"}
            >
              <CheckIcon width={13} height={13} />
              {committing ? "Committing…" : "Commit"}
            </button>
          </div>
        </div>

        {/* Right: diff view for the selected file. */}
        <div className="min-w-0 flex-1">
          <DiffView slug={slug} file={selected} />
        </div>
      </div>
    </div>
  );
}

/** One changed-file row: status badge + path + a staged/untracked hint. */
function FileRow({
  file,
  active,
  onSelect,
}: {
  file: GitFileChange;
  active: boolean;
  onSelect: () => void;
}) {
  const badge = statusBadge(file);
  const hint = file.untracked ? "untracked" : file.staged ? "staged" : "unstaged";
  return (
    <button
      type="button"
      onClick={onSelect}
      title={file.path}
      className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
        active
          ? "bg-paddock-200/80 dark:bg-paddock-800"
          : "hover:bg-paddock-200/50 dark:hover:bg-paddock-800/50"
      }`}
    >
      <span
        className={`inline-flex h-5 w-6 shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold ${badge.cls}`}
      >
        {badge.label}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[12.5px] text-paddock-700 dark:text-paddock-200">
          {file.path}
        </span>
        <span className="text-[10px] text-paddock-400">{hint}</span>
      </span>
    </button>
  );
}

/** Fetches + renders a unified diff with simple +/- line coloring. */
function DiffView({ slug, file }: { slug: string; file: string | null }) {
  const [diff, setDiff] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setDiff("");
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .gitDiff(slug, file)
      .then((text) => {
        if (!cancelled) setDiff(text);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "Failed to load diff");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, file]);

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-paddock-400">
        Select a file to view its diff.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="space-y-3 p-6">
        <div className="h-3.5 w-2/3 animate-pulse rounded bg-paddock-200/70 dark:bg-paddock-800/70" />
        <div className="h-3.5 w-1/2 animate-pulse rounded bg-paddock-200/70 dark:bg-paddock-800/70" />
        <div className="h-3.5 w-3/5 animate-pulse rounded bg-paddock-200/70 dark:bg-paddock-800/70" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <div className="flex items-start gap-2 rounded-lg border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-300">
          <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      </div>
    );
  }
  if (!diff.trim()) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-paddock-400">
        No diff for this file
        <br />
        (untracked files have no diff until tracked).
      </div>
    );
  }

  const lines = diff.split("\n");
  return (
    <div className="h-full overflow-auto bg-paddock-50/60 dark:bg-paddock-950/60">
      <pre className="min-w-full whitespace-pre px-4 py-3 font-mono text-[12px] leading-relaxed">
        {lines.map((line, i) => (
          <div key={i} className={diffLineClass(line)}>
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

/** Color a single unified-diff line (added/removed/hunk/meta). */
function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
    return "text-paddock-400";
  if (line.startsWith("@@"))
    return "text-violet-600 dark:text-violet-400";
  if (line.startsWith("+"))
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  if (line.startsWith("-"))
    return "bg-rose-500/10 text-rose-700 dark:text-rose-400";
  return "text-paddock-600 dark:text-paddock-300";
}

/**
 * The unobtrusive "Connect GitHub" affordance in the Changes header. Behavior is
 * driven entirely by gitInfo().github:
 *   configured:false             -> a muted "not configured" note
 *   configured:true,connected:false -> a Connect button (device flow)
 *   connected:true               -> "Connected as @login" + Disconnect
 */
function GithubAffordance({
  info,
  onChanged,
}: {
  info: GitInfo | null;
  onChanged: () => Promise<void> | void;
}) {
  const [starting, setStarting] = useState(false);
  const [flow, setFlow] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollErr, setPollErr] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Cancel any in-flight poll loop on unmount / when the flow ends.
  const cancelRef = useRef(false);
  useEffect(() => {
    cancelRef.current = false;
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const github = info?.github;

  const startConnect = useCallback(async () => {
    setStarting(true);
    setPollErr(null);
    try {
      const start = await api.githubConnect();
      setFlow({ userCode: start.userCode, verificationUri: start.verificationUri });
      setPolling(true);
      cancelRef.current = false;

      const deadline = Date.now() + start.expiresIn * 1000;
      let interval = Math.max(1, start.interval) * 1000;
      // Poll until authorized / error / expiry. `slow_down` backs the interval off.
      const tick = async () => {
        if (cancelRef.current) return;
        if (Date.now() >= deadline) {
          setPolling(false);
          setFlow(null);
          setPollErr("The code expired before authorization. Try again.");
          return;
        }
        try {
          const res = await api.githubPoll(start.deviceCode);
          if (cancelRef.current) return;
          if (res.status === "authorized") {
            setPolling(false);
            setFlow(null);
            await onChanged();
            return;
          }
          if (res.status === "error") {
            setPolling(false);
            setFlow(null);
            setPollErr(res.error ?? "Authorization failed.");
            return;
          }
          if (res.status === "slow_down") interval += 5000;
          // pending | slow_down -> wait and poll again.
          window.setTimeout(() => void tick(), interval);
        } catch (e) {
          if (cancelRef.current) return;
          setPolling(false);
          setFlow(null);
          setPollErr(e instanceof ApiError ? e.message : "Polling failed.");
        }
      };
      window.setTimeout(() => void tick(), interval);
    } catch (e) {
      setPollErr(
        e instanceof ApiError
          ? e.message
          : "Could not start the GitHub connection.",
      );
    } finally {
      setStarting(false);
    }
  }, [onChanged]);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await api.githubDisconnect();
      await onChanged();
    } catch {
      /* leave the button; the next gitInfo refresh reflects reality */
    } finally {
      setDisconnecting(false);
    }
  }, [onChanged]);

  // Until gitInfo resolves, render nothing (avoids a flash of the wrong state).
  if (!github) return null;

  if (!github.configured) {
    return (
      <span
        className="hidden items-center gap-1.5 text-[11px] text-paddock-400 sm:inline-flex"
        title="Set PADDOCK_GITHUB_CLIENT_ID on the server to enable in-app GitHub auth."
      >
        <GithubIcon width={13} height={13} />
        GitHub not configured
      </span>
    );
  }

  if (github.connected) {
    return (
      <span className="inline-flex items-center gap-2 text-[11px] text-paddock-500">
        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <GithubIcon width={13} height={13} />
          @{github.login ?? "github"}
        </span>
        <button
          type="button"
          onClick={() => void disconnect()}
          disabled={disconnecting}
          className="btn-subtle px-2 py-1 text-[11px]"
          title="Disconnect GitHub"
        >
          {disconnecting ? "…" : "Disconnect"}
        </button>
      </span>
    );
  }

  // configured && !connected
  return (
    <span className="inline-flex items-center gap-2">
      {flow ? (
        <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-paddock-500">
          <span className="text-paddock-500">Enter</span>
          <code className="rounded bg-paddock-200/80 px-1.5 py-0.5 font-mono text-[12px] font-semibold tracking-widest text-paddock-800 dark:bg-paddock-800 dark:text-paddock-100">
            {flow.userCode}
          </code>
          <span className="text-paddock-500">at</span>
          <a
            href={flow.verificationUri}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-accent underline underline-offset-2 hover:text-accent-600"
          >
            <LinkIcon width={11} height={11} />
            github.com
          </a>
          {polling && <span className="text-paddock-400">· waiting…</span>}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => void startConnect()}
          disabled={starting}
          className="btn-ghost py-1.5 text-xs"
          title="Authorize paddock to push to GitHub on your behalf (device flow)."
        >
          <GithubIcon width={13} height={13} />
          {starting ? "Starting…" : "Connect GitHub"}
        </button>
      )}
      {pollErr && (
        <span className="inline-flex items-center gap-1 text-[11px] text-rose-600 dark:text-rose-400">
          <AlertIcon width={12} height={12} />
          {pollErr}
        </span>
      )}
    </span>
  );
}
