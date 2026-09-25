/**
 * The "Derived" settings card: read-only state the keeper and the sweeper
 * maintain, as opposed to anything the user sets here.
 *
 * Extracted from `SettingsPane.tsx` (issue #923) to bring that file back under
 * the repo's ~1000-line limit.
 */
import type { Project } from "../../lib/types";
import { CheckIcon, PinIcon } from "../icons";
import { Section } from "../ui";
import { ReadOnly } from "./fields";

export function DerivedSection({ project }: { project: Project }) {
  return (
    <Section
      title="Derived"
      description="Read-only state Claude and sweeps maintain."
    >
      <dl className="grid grid-cols-1 gap-y-3 sm:grid-cols-2">
        <ReadOnly
          label="Overview"
          value={
            project.hasOverview ? (
              <span className="inline-flex items-center gap-1 text-success">
                <CheckIcon width={12} height={12} /> OVERVIEW.md written by a sweep
              </span>
            ) : (
              <span className="text-fg-subtle">No OVERVIEW.md yet</span>
            )
          }
        />
        <ReadOnly
          label="Pinned files"
          value={
            project.pinned.length > 0 ? (
              <span className="flex flex-wrap gap-1.5">
                {project.pinned.map((f) => (
                  <span
                    key={f}
                    className="inline-flex items-center gap-1 rounded-md bg-surface-active px-1.5 py-0.5 font-mono text-xs text-fg-muted"
                  >
                    <PinIcon width={11} height={11} className="text-accent" />
                    {f}
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-fg-subtle">None — pin files from the Files tab</span>
            )
          }
        />
      </dl>
    </Section>
  );
}
