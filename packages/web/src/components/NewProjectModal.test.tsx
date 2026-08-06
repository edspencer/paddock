import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewProjectModal } from "./NewProjectModal";
import { makeProject } from "../test/factories";

// Mock the api client so we can assert the payload the modal builds.
const createProject = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { createProject: (...a: unknown[]) => createProject(...a) } };
});

describe("NewProjectModal", () => {
  beforeEach(() => {
    createProject.mockReset();
    createProject.mockResolvedValue(makeProject({ slug: "new-one", name: "New One" }));
  });

  it("does not render when closed", () => {
    const { container } = render(
      <NewProjectModal open={false} onClose={() => {}} onCreated={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("disables Create until a name is entered (validation)", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    const submit = screen.getByRole("button", { name: /create project/i });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "My Project");
    expect(submit).toBeEnabled();
  });

  it("does not call the API when name is blank on submit", () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    // Submitting the form directly (bypassing the disabled button) is a no-op.
    fireEvent.submit(screen.getByRole("button", { name: /create project/i }).closest("form")!);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("builds the create payload: name trimmed, area, summary, and split/trimmed/filtered tags", async () => {
    const onCreated = vi.fn();
    render(<NewProjectModal open onClose={() => {}} onCreated={onCreated} />);

    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "  Water Heater  ");
    await userEvent.type(screen.getByPlaceholderText(/One line on what/i), "  fix the heater  ");
    await userEvent.type(screen.getByPlaceholderText(/home, plumbing/i), "home, , plumbing ,");
    // Pick an area.
    fireEvent.change(screen.getByDisplayValue("Unsorted"), { target: { value: "homelab" } });
    // Status defaults to "active".

    fireEvent.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(createProject).toHaveBeenCalledWith({
      name: "Water Heater",
      status: "active",
      group: "homelab",
      summary: "fix the heater",
      domain: ["home", "plumbing"],
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it("omits group when Unsorted and summary when blank", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "Bare");
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    const payload = createProject.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.group).toBeUndefined();
    expect(payload.summary).toBeUndefined();
    expect(payload.domain).toEqual([]);
  });

  it("includes the git repo URL in the payload when provided (issue #187)", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "Repo Proj");
    await userEvent.type(
      screen.getByPlaceholderText(/github\.com\/owner\/repo/i),
      "  https://github.com/owner/repo.git  ",
    );
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    const payload = createProject.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.repo).toBe("https://github.com/owner/repo.git");
  });

  it("omits repo when the URL field is left blank (notebook project)", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "Notebook");
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    const payload = createProject.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.repo).toBeUndefined();
    expect(payload.path).toBeUndefined();
  });

  it("includes the directory path in the payload when provided (issue #206)", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "Linked Proj");
    await userEvent.type(screen.getByPlaceholderText("/home/ed/Code/foo"), "  /home/ed/Code/foo  ");
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    const payload = createProject.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.path).toBe("/home/ed/Code/foo");
    // A path is independent of `repo`; leaving the URL blank must not send one.
    expect(payload.repo).toBeUndefined();
    // A path with no repo is the ambiguous shape, so the choice IS sent — and it
    // defaults to a code checkout paddock keeps its hands off.
    expect(payload.managed).toBe(false);
  });

  it("offers the notes/checkout choice only for a path with no repo (issue #206)", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    const notes = /These are notes/i;
    // Neither field: derived managed, nothing to ask.
    expect(screen.queryByText(notes)).not.toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("/home/ed/Code/foo"), "/home/ed/Code/foo");
    expect(screen.getByText(notes)).toBeInTheDocument();

    // Naming a repo settles it — that's code, so the question disappears again.
    await userEvent.type(
      screen.getByPlaceholderText(/github\.com\/owner\/repo/i),
      "https://github.com/owner/repo.git",
    );
    expect(screen.queryByText(notes)).not.toBeInTheDocument();
  });

  it("sends managed:true when the user says the directory holds notes (issue #206)", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "My Notes");
    await userEvent.type(screen.getByPlaceholderText("/home/ed/Code/foo"), "/home/ed/notes");
    await userEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    const payload = createProject.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.managed).toBe(true);
    expect(payload.path).toBe("/home/ed/notes");
  });

  it("omits `managed` when the shape already settles it, so one rule decides", async () => {
    render(<NewProjectModal open onClose={() => {}} onCreated={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "Cloned");
    await userEvent.type(
      screen.getByPlaceholderText(/github\.com\/owner\/repo/i),
      "https://github.com/owner/repo.git",
    );
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    const payload = createProject.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.managed).toBeUndefined();
  });

  it("surfaces an API error and stays open", async () => {
    const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    createProject.mockRejectedValueOnce(new ApiError("Project already exists: bare", 409));
    const onCreated = vi.fn();
    render(<NewProjectModal open onClose={() => {}} onCreated={onCreated} />);
    await userEvent.type(screen.getByPlaceholderText(/Garage Water Heater/i), "Bare");
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await waitFor(() =>
      expect(screen.getByText(/Project already exists/i)).toBeInTheDocument(),
    );
    expect(onCreated).not.toHaveBeenCalled();

    // The error must PERSIST after the busy→idle toggle settles (regression: the
    // reset effect used to re-fire on `busy` and wipe both the error and the
    // form). Give the finally() re-render a chance to land, then re-assert.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/Project already exists/i)).toBeInTheDocument();
    // The typed name is retained so the user can fix + resubmit (not blanked).
    expect(screen.getByPlaceholderText(/Garage Water Heater/i)).toHaveValue("Bare");
  });
});
