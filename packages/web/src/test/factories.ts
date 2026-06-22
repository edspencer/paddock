// Small fixture factories for web component/unit tests.
import type { Chat, Project } from "../lib/types";

export function makeProject(over: Partial<Project> = {}): Project {
  const slug = over.slug ?? "test-project";
  return {
    name: "Test Project",
    slug,
    status: "active",
    domain: [],
    group: "",
    visibility: "public",
    started: "2026-06-01",
    updated: "2026-06-21",
    created: "2026-06-01",
    summary: "",
    links: [],
    dir: `/data/projects/${slug}`,
    hasOverview: false,
    pinned: [],
    model: "claude-opus-4-8",
    ...over,
  };
}

export function makeChat(over: Partial<Chat> = {}): Chat {
  return {
    sessionId: "sess-1",
    workingDirectory: "/data/scratch/.chats",
    name: "A chat",
    updatedAt: "2026-06-21T10:00:00.000Z",
    resumable: true,
    preview: "hello",
    ...over,
  };
}
