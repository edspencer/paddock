import type { ChatProvenance } from "../lib/types";
import { BoltIcon, BranchIcon, ClockIcon } from "./icons";

/**
 * A small, subtle badge marking HOW a chat was created (issue #267), reading
 * A1's provenance marker (#261). Its whole point is to make the "ran without me"
 * cases legible at a glance in the chat list:
 *
 *  - `scheduled` — a schedule/cron fired it (clock icon).
 *  - `spawned`   — another chat created it, e.g. a manager fanning out
 *                  (branch icon); its spawn depth rides in the tooltip.
 *  - `hook`      — an event hook fired it, e.g. an `onArchive` cleanup
 *                  (lightning-bolt icon); the hook name rides in the tooltip
 *                  when known (Epic G / G3, GG-5).
 *
 * `human` (the default — a chat you started yourself) renders nothing, so the
 * list stays quiet and only the unattended runs stand out. Following DD-6, the
 * icon set mirrors herdctl's trigger-type icons.
 *
 * Icon-only by design: the chat title owns the row's horizontal space, so the
 * badge is a compact tinted chip with the human-readable meaning in its tooltip
 * + accessible label rather than an inline text label.
 */
export function ProvenanceBadge({
  provenance,
  hookName,
  className = "",
}: {
  provenance?: ChatProvenance;
  /** The owning hook's name, shown in the `hook` badge's tooltip when known. */
  hookName?: string;
  className?: string;
}) {
  const origin = provenance?.origin;
  if (origin !== "scheduled" && origin !== "spawned" && origin !== "hook") return null;

  if (origin === "hook") {
    const label = hookName ? `Hook — the “${hookName}” event hook fired this chat` : "Hook — an event hook fired this chat";
    return (
      <span
        data-provenance="hook"
        aria-label="Hook chat"
        title={label}
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-sky-600 dark:text-sky-400 ${className}`}
      >
        <BoltIcon width={12} height={12} />
      </span>
    );
  }

  if (origin === "scheduled") {
    return (
      <span
        data-provenance="scheduled"
        aria-label="Scheduled chat"
        title="Scheduled — a schedule started this chat"
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-amber-600 dark:text-amber-400 ${className}`}
      >
        <ClockIcon width={12} height={12} />
      </span>
    );
  }

  // spawned
  const depth = provenance?.depth ?? 0;
  const depthNote = depth > 1 ? ` (${depth} levels deep)` : "";
  return (
    <span
      data-provenance="spawned"
      aria-label="Spawned chat"
      title={`Spawned — another chat created this one${depthNote}`}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-violet-600 dark:text-violet-400 ${className}`}
    >
      <BranchIcon width={12} height={12} />
    </span>
  );
}
