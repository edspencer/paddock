import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeleteProjectDialog, deleteUnlinksOnly } from "./DeleteProjectDialog";
import { readLastTab, writeLastTab } from "../lib/lastTab";
import { makeProject } from "../test/factories";

const deleteProject = vi.fn();
const listProjects = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      deleteProject: (...a: unknown[]) => deleteProject(...a),
      listProjects: (...a: unknown[]) => listProjects(...a),
    },
  };
});

// The dialog drops the deleted project from the projects context, so it needs a
// real provider around it. `listProjects` feeds the provider's boot fetch.
import { ProjectsProvider } from "../lib/projects-context";

/** A MANAGED project: its working dir IS its metadata dir, so delete removes the files. */
const managed = makeProject({
  slug: "hushpod",
  name: "Hushpod",
  dir: "/data/projects/hushpod",
  workingDir: "/data/projects/hushpod",
});

/** A LINKED project (#206): the working dir is the user's own clone, outside the root. */
const linked = makeProject({
  slug: "warren",
  name: "Warren",
  managed: false,
  dir: "/data/projects/warren",
  workingDir: "/home/ed/code/warren",
  path: "/home/ed/code/warren",
});

function renderDialog(project = managed, onDeleted?: () => void) {
  return render(
    <ProjectsProvider>
      <DeleteProjectDialog project={project} open onClose={() => {}} onDeleted={onDeleted} />
    </ProjectsProvider>,
  );
}

describe("deleteUnlinksOnly", () => {
  it("is false when the working dir IS the metadata dir (notebook project)", () => {
    expect(deleteUnlinksOnly(managed)).toBe(false);
  });

  // #187: promotion clones INTO `<dir>/<repo-name>`, which the delete does remove.
  it("is false for a repo-backed project's nested checkout", () => {
    expect(
      deleteUnlinksOnly({ ...managed, workingDir: "/data/projects/hushpod/hushpod" }),
    ).toBe(false);
  });

  it("is true when the working dir is outside the metadata dir", () => {
    expect(deleteUnlinksOnly(linked)).toBe(true);
  });

  // A prefix test without the separator would call this one contained, and then
  // tell a user their untouched clone was being permanently removed.
  it("respects path-segment boundaries", () => {
    expect(
      deleteUnlinksOnly({ ...managed, dir: "/data/projects/hush", workingDir: "/data/projects/hushpod" }),
    ).toBe(true);
  });

  // A MANAGED project can also have an external `path` (#206) — Paddock curates
  // notes in there, but the delete still only removes the metadata dir. So this
  // branches on containment, NOT on `managed`.
  it("is true for a managed project with an external path", () => {
    expect(
      deleteUnlinksOnly({ ...managed, workingDir: "/home/ed/notes/hushpod" }),
    ).toBe(true);
  });
});

describe("DeleteProjectDialog", () => {
  beforeEach(() => {
    deleteProject.mockReset().mockResolvedValue(undefined);
    listProjects.mockReset().mockResolvedValue({ projects: [], root: null });
    localStorage.clear();
  });

  it("warns that files are permanently removed for a managed project", () => {
    renderDialog(managed);
    expect(screen.getByText(/all its chats and files will be permanently removed/i))
      .toBeInTheDocument();
  });

  // The bug this whole shared dialog exists to fix: three copies all claimed the
  // user's clone was being deleted.
  it("says the working directory is left alone for a linked project", () => {
    renderDialog(linked);
    expect(screen.getByText(/will be unlinked/i)).toBeInTheDocument();
    expect(screen.getByText("/home/ed/code/warren")).toBeInTheDocument();
    expect(screen.getByText(/Nothing in there is deleted/i)).toBeInTheDocument();
    expect(screen.queryByText(/all its chats and files will be permanently removed/i)).toBeNull();
  });

  it("performs every post-delete side effect on confirm", async () => {
    writeLastTab("hushpod", "files");
    const onDeleted = vi.fn();
    renderDialog(managed, onDeleted);

    await userEvent.click(screen.getByRole("button", { name: "Delete project" }));

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("hushpod"));
    // `remove()` — the provider's list is the observable half of the context drop.
    // `clearLastTab()` — the grid's copy of this flow used to skip it entirely.
    await waitFor(() => expect(readLastTab("hushpod")).toBeNull());
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it("deletes nothing when cancelled", async () => {
    writeLastTab("hushpod", "files");
    renderDialog(managed);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteProject).not.toHaveBeenCalled();
    expect(readLastTab("hushpod")).toBe("files");
  });

  // A failed delete must stay on screen and retryable rather than vanishing as
  // if it had worked.
  it("keeps the dialog open and reports a failed delete", async () => {
    deleteProject.mockRejectedValue(new Error("Refusing to delete the root workspace"));
    const onDeleted = vi.fn();
    renderDialog(managed, onDeleted);

    await userEvent.click(screen.getByRole("button", { name: "Delete project" }));

    await waitFor(() =>
      expect(screen.getByText("Refusing to delete the root workspace")).toBeInTheDocument(),
    );
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete project" })).toBeInTheDocument();
  });
});
