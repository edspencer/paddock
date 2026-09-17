import { useCallback } from "react";
import { api } from "../lib/api";
import { clearLastTab } from "../lib/lastTab";
import { useProjects } from "../lib/projects-context";
import type { Project } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * The fields the delete flow actually reads. Narrower than `Project` so a test
 * can build one without the other thirty, and so it is obvious that the copy
 * branches on the two directory fields and nothing else.
 */
export type DeletableProject = Pick<Project, "name" | "slug" | "dir" | "workingDir">;

/** Is `child` the same as, or beneath, `parent`? Segment-aware, so `/a/bc` is NOT inside `/a/b`. */
function isPathInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/**
 * Whether deleting this project LEAVES THE USER'S FILES ALONE — i.e. whether it
 * is an unlink rather than a removal (issue #923).
 *
 * `ProjectsService.remove` only ever `rm`s the project's METADATA dir
 * (`rmInsideRoot(this.dirFor(slug))`, `projects.ts`). So the user's working tree
 * survives exactly when `workingDir` is not underneath `dir` — which is the case
 * for a LINKED project and for a managed one with an external `path` (#206), and
 * is NOT the case for a repo-backed project whose checkout is nested under `dir`
 * (#187).
 *
 * Deliberately containment rather than `!project.managed`, which is what the
 * header's "Linked" badge uses: a MANAGED project with an external `path` also
 * keeps its directory, and telling that user their files are being permanently
 * removed would be exactly the false alarm this function exists to stop.
 */
export function deleteUnlinksOnly(project: DeletableProject): boolean {
  return !isPathInside(project.workingDir, project.dir);
}

/**
 * The confirmation body — the ONE copy for all three delete call sites (the
 * project header menu, the projects grid card, and the Settings danger zone).
 *
 * It used to be three hand-copies that all said "and all its chats and files
 * will be permanently removed", which is false and alarming for a linked
 * project: nothing under their clone is touched.
 */
export function DeleteProjectMessage({ project }: { project: DeletableProject }) {
  const name = <span className="font-medium text-fg">{project.name}</span>;
  if (deleteUnlinksOnly(project)) {
    return (
      <>
        {name} will be unlinked. Paddock’s notes, settings and chats for it are permanently
        removed, and this cannot be undone — but the directory it works in is left alone:
        <span className="mt-1.5 block break-all font-mono text-xs text-fg">
          {project.workingDir}
        </span>
        <span className="mt-1.5 block">Nothing in there is deleted.</span>
      </>
    );
  }
  return (
    <>
      {name} and all its chats and files will be permanently removed. This cannot be undone.
    </>
  );
}

/**
 * Delete a project and forget it everywhere the client remembers it.
 *
 * All three side effects, always. The grid used to do `remove()` only and leak a
 * `paddock:lastTab:<slug>` entry behind every deleted project; folding that in
 * here is what stops the set drifting apart again.
 */
export function useDeleteProject(): (slug: string) => Promise<void> {
  const { remove } = useProjects();
  return useCallback(
    async (slug: string) => {
      await api.deleteProject(slug);
      remove(slug); // drop from the projects context
      clearLastTab(slug); // forget the remembered tab
    },
    [remove],
  );
}

/**
 * The shared "Delete project?" confirmation (issue #923).
 *
 * Callers supply `onDeleted` for whatever they must do *after* the project is
 * gone — the grid closes the dialog; a caller standing INSIDE the project has to
 * navigate away from a page that no longer exists.
 *
 * Errors are surfaced by `ConfirmDialog` itself and leave the dialog open, so a
 * failed delete is retryable rather than silently dismissed.
 */
export function DeleteProjectDialog({
  project,
  open,
  onClose,
  onDeleted,
}: {
  project: DeletableProject;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const deleteProject = useDeleteProject();
  const unlinks = deleteUnlinksOnly(project);
  return (
    <ConfirmDialog
      open={open}
      // Same title in both cases: it names the affordance the user just clicked.
      // The linked-vs-managed difference is what the BODY is for.
      title="Delete project?"
      message={<DeleteProjectMessage project={project} />}
      confirmLabel="Delete project"
      // The linked body names a path and has three lines to read; the backdrop
      // is an easy mis-click at that size.
      wide={unlinks}
      dismissOnBackdrop={!unlinks}
      onConfirm={async () => {
        await deleteProject(project.slug);
        onDeleted?.();
      }}
      onClose={onClose}
    />
  );
}
