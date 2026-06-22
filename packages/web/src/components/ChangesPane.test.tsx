import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangesPane } from "./ChangesPane";
import type { GitInfo, GitProjectStatus } from "../lib/types";

const gitInfo = vi.fn();
const gitStatus = vi.fn();
const gitDiff = vi.fn();
const gitCommit = vi.fn();
const gitPush = vi.fn();
const githubConnect = vi.fn();
const githubPoll = vi.fn();
const githubDisconnect = vi.fn();
const apiMock = { gitInfo, gitStatus, gitDiff, gitCommit, gitPush, githubConnect, githubPoll, githubDisconnect };
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      gitInfo: (...a: unknown[]) => gitInfo(...a),
      gitStatus: (...a: unknown[]) => gitStatus(...a),
      gitDiff: (...a: unknown[]) => gitDiff(...a),
      gitCommit: (...a: unknown[]) => gitCommit(...a),
      gitPush: (...a: unknown[]) => gitPush(...a),
      githubConnect: (...a: unknown[]) => githubConnect(...a),
      githubPoll: (...a: unknown[]) => githubPoll(...a),
      githubDisconnect: (...a: unknown[]) => githubDisconnect(...a),
    },
  };
});

function makeStatus(over: Partial<GitProjectStatus> = {}): GitProjectStatus {
  return {
    repo: true,
    branch: "main",
    clean: false,
    files: [
      { path: "notes.md", status: "M", staged: false, untracked: false },
      { path: "new.txt", status: "??", staged: false, untracked: true },
    ],
    ...over,
  };
}

function makeInfo(over: Partial<GitInfo> = {}): GitInfo {
  return {
    repo: true,
    configured: false,
    branch: "main",
    ahead: 0,
    behind: 0,
    github: { configured: false, connected: false },
    ...over,
  };
}

beforeEach(() => {
  Object.values(apiMock).forEach((m) => m.mockReset());
  apiMock.gitInfo.mockResolvedValue(makeInfo());
  apiMock.gitStatus.mockResolvedValue(makeStatus());
  apiMock.gitDiff.mockResolvedValue("diff --git a/notes.md b/notes.md\n@@ -1 +1 @@\n-old\n+new");
  apiMock.gitCommit.mockResolvedValue({ committed: true, hash: "abcdef1234" });
  apiMock.gitPush.mockResolvedValue({ pushed: true });
});

function renderPane(status = makeStatus(), onStatusChange = vi.fn()) {
  render(<ChangesPane slug="proj" status={status} onStatusChange={onStatusChange} />);
  return { onStatusChange };
}

describe("ChangesPane: status + diff", () => {
  it("lists changed files with their status badges + branch", async () => {
    renderPane();
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("new.txt")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("2 uncommitted")).toBeInTheDocument();
    // untracked hint
    expect(screen.getByText("untracked")).toBeInTheDocument();
  });

  it("auto-selects the first file and renders its colored diff", async () => {
    renderPane();
    // The diff for notes.md loads (it's the first file → auto-selected).
    await waitFor(() => expect(apiMock.gitDiff).toHaveBeenCalledWith("proj", "notes.md"));
    expect(await screen.findByText("+new")).toBeInTheDocument();
    expect(screen.getByText("-old")).toBeInTheDocument();
  });

  it("selecting another file fetches its diff", async () => {
    renderPane();
    await waitFor(() => expect(apiMock.gitDiff).toHaveBeenCalledWith("proj", "notes.md"));
    apiMock.gitDiff.mockResolvedValueOnce("");
    fireEvent.click(screen.getByText("new.txt"));
    await waitFor(() => expect(apiMock.gitDiff).toHaveBeenCalledWith("proj", "new.txt"));
    // An untracked/empty diff shows the explanatory message.
    expect(await screen.findByText(/untracked files have no diff/i)).toBeInTheDocument();
  });

  it("shows a clean state when there are no changes", () => {
    renderPane(makeStatus({ clean: true, files: [] }));
    expect(screen.getByText("clean")).toBeInTheDocument();
    expect(screen.getByText(/No uncommitted changes/i)).toBeInTheDocument();
  });

  it("surfaces a diff load error", async () => {
    const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    apiMock.gitDiff.mockRejectedValueOnce(new ApiError("diff boom", 500));
    renderPane();
    expect(await screen.findByText("diff boom")).toBeInTheDocument();
  });
});

describe("ChangesPane: commit", () => {
  it("disables Commit until there's a message", () => {
    renderPane();
    const commit = screen.getByRole("button", { name: /^Commit$/ });
    expect(commit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/Commit message/i), { target: { value: "wip" } });
    expect(commit).toBeEnabled();
  });

  it("commits, clears the box, shows the short hash, and refreshes status", async () => {
    const onStatusChange = vi.fn();
    apiMock.gitStatus.mockResolvedValue(makeStatus({ clean: true, files: [] }));
    renderPane(makeStatus(), onStatusChange);
    const box = screen.getByPlaceholderText(/Commit message/i);
    fireEvent.change(box, { target: { value: "checkpoint" } });
    fireEvent.click(screen.getByRole("button", { name: /^Commit$/ }));

    await waitFor(() => expect(apiMock.gitCommit).toHaveBeenCalledWith("proj", "checkpoint"));
    expect(await screen.findByText(/Committed abcdef1/i)).toBeInTheDocument();
    expect((box as HTMLTextAreaElement).value).toBe("");
    // Refreshed status propagated up.
    await waitFor(() => expect(onStatusChange).toHaveBeenCalled());
  });

  it("reports 'nothing to commit' without erroring", async () => {
    apiMock.gitCommit.mockResolvedValue({ committed: false });
    renderPane();
    fireEvent.change(screen.getByPlaceholderText(/Commit message/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^Commit$/ }));
    expect(await screen.findByText(/Nothing to commit/i)).toBeInTheDocument();
  });

  it("surfaces a commit error", async () => {
    const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    apiMock.gitCommit.mockRejectedValueOnce(new ApiError("pre-commit hook failed", 500));
    renderPane();
    fireEvent.change(screen.getByPlaceholderText(/Commit message/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^Commit$/ }));
    expect(await screen.findByText("pre-commit hook failed")).toBeInTheDocument();
  });
});

describe("ChangesPane: push", () => {
  it("disables Push when there's no remote", async () => {
    apiMock.gitInfo.mockResolvedValue(makeInfo({ configured: false, ahead: 0 }));
    renderPane();
    const push = await screen.findByRole("button", { name: /Push/ });
    expect(push).toBeDisabled();
    expect(push).toHaveAttribute("title", expect.stringMatching(/No remote configured/i));
  });

  it("enables Push with ↑N when ahead, and pushes", async () => {
    apiMock.gitInfo.mockResolvedValue(makeInfo({ configured: true, ahead: 3 }));
    renderPane();
    const push = await screen.findByRole("button", { name: /Push/ });
    await waitFor(() => expect(push).toBeEnabled());
    expect(within(push).getByText("↑3")).toBeInTheDocument();
    fireEvent.click(push);
    await waitFor(() => expect(apiMock.gitPush).toHaveBeenCalled());
    expect(await screen.findByText(/Pushed to remote/i)).toBeInTheDocument();
  });

  it("surfaces a push failure", async () => {
    apiMock.gitInfo.mockResolvedValue(makeInfo({ configured: true, ahead: 1 }));
    apiMock.gitPush.mockResolvedValue({ pushed: false, error: "auth required" });
    renderPane();
    const push = await screen.findByRole("button", { name: /Push/ });
    await waitFor(() => expect(push).toBeEnabled());
    fireEvent.click(push);
    expect(await screen.findByText("auth required")).toBeInTheDocument();
  });
});

describe("ChangesPane: GitHub affordance", () => {
  it("shows 'not configured' when no client id is set on the server", async () => {
    apiMock.gitInfo.mockResolvedValue(makeInfo({ github: { configured: false, connected: false } }));
    renderPane();
    expect(await screen.findByText(/GitHub not configured/i)).toBeInTheDocument();
  });

  it("shows the connected login + Disconnect, and disconnects", async () => {
    apiMock.gitInfo.mockResolvedValue(
      makeInfo({ github: { configured: true, connected: true, login: "ed" } }),
    );
    apiMock.githubDisconnect.mockResolvedValue(undefined);
    renderPane();
    expect(await screen.findByText("@ed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Disconnect/i }));
    await waitFor(() => expect(apiMock.githubDisconnect).toHaveBeenCalled());
  });

  it("Connect starts the device flow and renders the user code + verification link", async () => {
    apiMock.gitInfo.mockResolvedValue(makeInfo({ github: { configured: true, connected: false } }));
    apiMock.githubConnect.mockResolvedValue({
      userCode: "WXYZ-1234",
      verificationUri: "https://github.com/login/device",
      deviceCode: "dev-code",
      interval: 5,
      expiresIn: 900,
    });
    // Keep polling pending so the flow stays on screen for assertions.
    apiMock.githubPoll.mockResolvedValue({ status: "pending" });
    renderPane();
    const connect = await screen.findByRole("button", { name: /Connect GitHub/i });
    fireEvent.click(connect);
    expect(await screen.findByText("WXYZ-1234")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /github.com/i });
    expect(link).toHaveAttribute("href", "https://github.com/login/device");
  });

  it("surfaces a connect error", async () => {
    apiMock.gitInfo.mockResolvedValue(makeInfo({ github: { configured: true, connected: false } }));
    const { ApiError } = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    apiMock.githubConnect.mockRejectedValueOnce(new ApiError("rate limited", 429));
    renderPane();
    fireEvent.click(await screen.findByRole("button", { name: /Connect GitHub/i }));
    expect(await screen.findByText("rate limited")).toBeInTheDocument();
  });
});
