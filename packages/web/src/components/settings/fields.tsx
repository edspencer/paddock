/**
 * The small read/hint primitives the project Settings sections share.
 *
 * Extracted from `SettingsPane.tsx` (issue #923) along with the sections that
 * use them — the file was over the repo's ~1000-line limit before the Danger
 * Zone was added to it.
 */
import { AlertIcon } from "../icons";

/** A one-line help/hint under a field. */
export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs leading-snug text-fg-muted">{children}</p>;
}

/** A caution note for a dangerous setting. */
export function Caution({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 flex items-start gap-1.5 text-xs leading-snug text-warn">
      <AlertIcon width={13} height={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** A read-only labelled value (immutable / derived fields). */
export function ReadOnly({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm text-fg-muted">{value}</dd>
    </div>
  );
}
