/**
 * The project Settings tab's danger zone (issue #923) — the delete affordance
 * for someone standing *inside* a project.
 *
 * Until now the only two ways to delete were the header `⋯` menu and a card on
 * the projects grid. #919 removes the first of those, which would otherwise
 * leave a user inside a project with no way out of it.
 */
import { useState } from "react";
import { isRootKey } from "../../routes/ProjectView/urls";
import type { Project } from "../../lib/types";
import { DeleteProjectDialog, deleteUnlinksOnly } from "../DeleteProjectDialog";
import { TrashIcon } from "../icons";
import { Section } from "../ui";

export function DangerZoneSection({
  project,
  onDeleted,
}: {
  project: Project;
  /** Run once the project is gone — the caller is standing on a page that no longer exists. */
  onDeleted?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  // The ROOT workspace cannot be deleted — `ProjectsService.remove` refuses,
  // because the root's directory IS the whole projects root (#516). Hidden
  // entirely rather than disabled: there is no state in which it becomes
  // available, so a greyed-out button would only ever pose a question with no
  // answer.
  //
  // Gated on `isRootKey`, NEVER on `project.slug ? …` or `!project.slug`. The
  // root's slug IS the empty string — a real, routable key — so every
  // truthiness test on it reads "root" as "missing" and is right only by
  // accident. Same call this file's neighbour makes for the Slug field.
  if (isRootKey(project.slug)) return null;

  const unlinks = deleteUnlinksOnly(project);

  return (
    <Section
      title="Danger zone"
      description={
        unlinks
          ? "Deleting unlinks this project: Paddock’s notes, settings and chats go, and the directory it works in is left untouched."
          : "Deleting removes this project’s directory — its notes, settings, chats and files."
      }
    >
      <button
        type="button" // inside the settings <form>: must never submit it
        className="btn btn-danger gap-1.5"
        onClick={() => setConfirming(true)}
      >
        <TrashIcon width={14} height={14} />
        Delete project…
      </button>
      {/* Mounted only while open. The dialog reads the projects context, and a
          pane rendered outside a `ProjectsProvider` (every SettingsPane unit
          test) must not pay for a modal it never shows. */}
      {confirming && (
        <DeleteProjectDialog
          project={project}
          open
          onClose={() => setConfirming(false)}
          onDeleted={onDeleted}
        />
      )}
    </Section>
  );
}
