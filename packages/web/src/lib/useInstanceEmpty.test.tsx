import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useInstanceEmpty } from "./useInstanceEmpty";
import { makeChat, makeProject } from "../test/factories";
import type { Project } from "./types";

let mockProjects: Project[] = [];
let mockLoading = false;
vi.mock("./projects-context", () => ({
  useProjects: () => ({
    projects: mockProjects,
    rootWorkspace: null,
    loading: mockLoading,
    error: null,
    refresh: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
  }),
}));

const listProjectChats = vi.fn();
vi.mock("./api", () => ({ api: { listProjectChats: (...a: unknown[]) => listProjectChats(...a) } }));

describe("useInstanceEmpty", () => {
  beforeEach(() => {
    mockProjects = [];
    mockLoading = false;
    listProjectChats.mockReset();
    listProjectChats.mockResolvedValue([]);
  });

  it("is empty when there are no projects and the root has no chats", async () => {
    const { result } = renderHook(() => useInstanceEmpty());
    await waitFor(() => expect(result.current.empty).toBe(true));
    expect(listProjectChats).toHaveBeenCalledWith("");
  });

  it("is NOT empty once the root workspace has a chat", async () => {
    // The root always exists, so it cannot be the thing that makes an instance
    // non-empty — but someone who has started a conversation here has used the
    // thing, and replacing their front door with an import screen would be rude.
    listProjectChats.mockResolvedValue([makeChat()]);
    const { result } = renderHook(() => useInstanceEmpty());
    await waitFor(() => expect(result.current.empty).toBe(false));
  });

  it("is NOT empty when a non-root project exists, and asks nothing further", async () => {
    mockProjects = [makeProject({ slug: "a" })];
    const { result } = renderHook(() => useInstanceEmpty());
    await waitFor(() => expect(result.current.empty).toBe(false));
    expect(listProjectChats).not.toHaveBeenCalled();
  });

  it("reports UNKNOWN, not 'not empty', while the project list is still loading", () => {
    // Collapsing the unknown into `false` renders the ordinary home for a beat
    // and then swaps it — worst on exactly the fresh install this is for.
    mockLoading = true;
    const { result } = renderHook(() => useInstanceEmpty());
    expect(result.current.empty).toBeNull();
    expect(listProjectChats).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the root's chats cannot be read", async () => {
    // An unreadable root is not an empty one: offering to import over the top of
    // a workspace we could not read is the wrong way to be wrong.
    listProjectChats.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useInstanceEmpty());
    await waitFor(() => expect(result.current.empty).toBe(false));
  });

  it("re-asks on recheck", async () => {
    const { result } = renderHook(() => useInstanceEmpty());
    await waitFor(() => expect(result.current.empty).toBe(true));
    listProjectChats.mockResolvedValue([makeChat()]);
    act(() => result.current.recheck());
    await waitFor(() => expect(result.current.empty).toBe(false));
  });
});
