// Typed REST client for the paddock-server API.
//
// Falls back to mock data when the API is unreachable (so the UI is usable in
// pure-frontend dev). Set VITE_API_BASE to point at a non-default server.
import type { Chat, CreateProjectInput, Project } from "./types";

const BASE = import.meta.env.VITE_API_BASE ?? "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const api = {
  async listProjects(): Promise<Project[]> {
    try {
      const { projects } = await req<{ projects: Project[] }>("/api/projects");
      return projects;
    } catch {
      return MOCK_PROJECTS;
    }
  },

  async getProject(slug: string): Promise<Project> {
    try {
      const { project } = await req<{ project: Project }>(`/api/projects/${slug}`);
      return project;
    } catch {
      const mock = MOCK_PROJECTS.find((p) => p.slug === slug);
      if (mock) return mock;
      throw new ApiError(`Project not found: ${slug}`, 404);
    }
  },

  async createProject(input: CreateProjectInput): Promise<Project> {
    const { project } = await req<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return project;
  },

  async listProjectChats(slug: string): Promise<Chat[]> {
    try {
      const { chats } = await req<{ chats: Chat[] }>(`/api/projects/${slug}/chats`);
      return chats;
    } catch {
      return [];
    }
  },

  async listAdhocChats(): Promise<Chat[]> {
    try {
      const { chats } = await req<{ chats: Chat[] }>("/api/chats");
      return chats;
    } catch {
      return [];
    }
  },

  async changelog(slug: string): Promise<string> {
    try {
      const res = await fetch(`${BASE}/api/projects/${slug}/changelog`);
      if (!res.ok) return "";
      return await res.text();
    } catch {
      return "";
    }
  },
};

// --- mock data (used only when the API is unreachable) ---

const MOCK_PROJECTS: Project[] = [
  {
    name: "Garage Water Heater Replacement",
    slug: "water-heater-garage",
    status: "active",
    domain: ["home", "plumbing"],
    visibility: "public",
    started: "2026-05-01",
    updated: "2026-06-20",
    created: "2026-05-01",
    summary: "Heat-pump hybrid swap; 30A circuit is the open question.",
    dir: "/data/projects/water-heater-garage",
  },
  {
    name: "Firewall HA Migration",
    slug: "firewall-ha-migration",
    status: "active",
    domain: ["network", "infra"],
    visibility: "public",
    started: "2026-04-10",
    updated: "2026-06-18",
    created: "2026-04-10",
    summary: "Move OPNsense to an HA pair without dropping the homelab.",
    dir: "/data/projects/firewall-ha-migration",
  },
  {
    name: "Kiwix Offline Wiki",
    slug: "kiwix-offline-wiki",
    status: "idea",
    domain: ["prepping", "media"],
    visibility: "public",
    started: "2026-06-01",
    updated: "2026-06-12",
    created: "2026-06-01",
    summary: "Self-hosted offline knowledge base for the rack.",
    dir: "/data/projects/kiwix-offline-wiki",
  },
];
