import { describe, it, expect } from "vitest";
import {
  ROOT_SLUG,
  decodeFilesSubpath,
  deriveView,
  gridUrl,
  homeUrl,
  viewBase,
} from "./urls";

/**
 * The URL seam that lets one `ProjectView` serve both a project and the ROOT
 * project (issue #516 Phase 3). These are pure string functions, so the whole
 * generalisation is testable here rather than through the component.
 *
 * The project cases are the pre-#516 behaviour, asserted unchanged — the
 * generalisation must be invisible to an instance with no root project.
 */
describe("viewBase / homeUrl", () => {
  it("gives a project a namespaced base and the root a bare one", () => {
    expect(viewBase("paddock")).toBe("/projects/paddock");
    expect(viewBase(ROOT_SLUG)).toBe("");
  });

  it("points Home at /home in a project and at `/` at the root", () => {
    // The one asymmetry in the scheme: `/` IS root Home, so there is no
    // `/home` at the root and no redirect to it.
    expect(homeUrl("/projects/paddock")).toBe("/projects/paddock/home");
    expect(homeUrl("")).toBe("/");
  });
});

describe("deriveView — projects (unchanged)", () => {
  const base = "/projects/paddock";
  it.each([
    ["/projects/paddock/home", "home"],
    ["/projects/paddock/chat", "chat"],
    ["/projects/paddock/chat/abc-123", "chat"],
    ["/projects/paddock/files", "files"],
    ["/projects/paddock/files/design/a.md", "files"],
    ["/projects/paddock/changes", "changes"],
    ["/projects/paddock/changes/a.md", "changes"],
    ["/projects/paddock/history", "history"],
    ["/projects/paddock/settings", "settings"],
    ["/projects/paddock/triggers", "triggers"],
    // The legacy Hooks route still resolves to Triggers (Epic T / T4).
    ["/projects/paddock/hooks", "triggers"],
    // A bare project URL still falls through to chat, as before.
    ["/projects/paddock", "chat"],
  ])("%s -> %s", (pathname, expected) => {
    expect(deriveView(pathname, base)).toBe(expected);
  });
});

describe("deriveView — the root", () => {
  it.each([
    // `/` is Home. This is the whole point: no redirect, no sticky last tab.
    ["/", "home"],
    ["/chat", "chat"],
    ["/chat/abc-123", "chat"],
    ["/files", "files"],
    ["/files/notes/a.md", "files"],
    ["/changes", "changes"],
    ["/history", "history"],
    ["/settings", "settings"],
    ["/triggers", "triggers"],
    ["/hooks", "triggers"],
  ])("%s -> %s", (pathname, expected) => {
    expect(deriveView(pathname, "")).toBe(expected);
  });

  it("does not mistake a project URL for a root tab", () => {
    // With base "" every path is its own tail, so `/projects/...` must not
    // accidentally match one of the root's prefixes.
    expect(deriveView("/projects/paddock/files", "")).toBe("home");
  });
});

describe("decodeFilesSubpath", () => {
  it("reads the nested subpath under either base, decoding per segment", () => {
    expect(decodeFilesSubpath("/projects/p/files/design/a%20b.md", "/projects/p")).toBe(
      "design/a b.md",
    );
    expect(decodeFilesSubpath("/files/design/a%20b.md", "")).toBe("design/a b.md");
  });

  it("returns '' for the bare files route and for a non-files path", () => {
    expect(decodeFilesSubpath("/projects/p/files", "/projects/p")).toBe("");
    expect(decodeFilesSubpath("/files", "")).toBe("");
    expect(decodeFilesSubpath("/projects/p/chat", "/projects/p")).toBe("");
  });
});

describe("gridUrl", () => {
  it("keeps the grid at `/` until a root project takes that slot", () => {
    // Load-bearing for the migration promise: an instance with no root project
    // must behave exactly as before, and `/` is the URL every existing link,
    // bookmark and E2E assertion already uses for the grid.
    expect(gridUrl(false)).toBe("/");
    expect(gridUrl(true)).toBe("/projects");
  });
});
