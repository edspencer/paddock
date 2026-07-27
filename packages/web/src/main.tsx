import React, { lazy, type ReactElement } from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider, useParams } from "react-router-dom";
import "./index.css";
import { AppShell } from "./components/AppShell";
import { RouteError } from "./components/RouteError";
import { ProjectsProvider, useProjects } from "./lib/projects-context";
import { registerServiceWorker } from "./lib/pwa";

// Route components are code-split (issue #11): each becomes its own async chunk
// so the heavy chat/file/markdown code isn't in the entry bundle. AppShell wraps
// <Outlet> in a Suspense boundary that covers these while they load.
const ProjectsGrid = lazy(() =>
  import("./routes/ProjectsGrid").then((m) => ({ default: m.ProjectsGrid })),
);
const ProjectView = lazy(() =>
  import("./routes/ProjectView").then((m) => ({ default: m.ProjectView })),
);
const ProjectRedirect = lazy(() =>
  import("./routes/ProjectRedirect").then((m) => ({ default: m.ProjectRedirect })),
);
const OneOffChat = lazy(() =>
  import("./routes/OneOffChat").then((m) => ({ default: m.OneOffChat })),
);
const InstanceSettings = lazy(() =>
  import("./routes/InstanceSettings").then((m) => ({ default: m.InstanceSettings })),
);

// Reflect tab visibility onto <html data-tab-hidden> so CSS can pause the
// continuous streaming animations (spinners, caret) while the tab is
// backgrounded — see index.css. Hidden tabs aren't composited to screen, but
// this also stops the renderer from ticking the animation while you're away.
const syncTabHidden = () =>
  document.documentElement.setAttribute("data-tab-hidden", document.hidden ? "true" : "false");
document.addEventListener("visibilitychange", syncTabHidden);
syncTabHidden();

/** /tags/:tag — the projects grid filtered to one domain tag (param decoded). */
function TaggedProjects() {
  const { tag } = useParams();
  return <ProjectsGrid filterTag={tag ? decodeURIComponent(tag) : undefined} />;
}

/**
 * The two top-level routes whose meaning depends on whether this instance has a
 * ROOT PROJECT (issue #516). Migration is gated on EXISTENCE, so:
 *
 *   no root project  → `/` is the projects grid and `/chat` is a scratch chat,
 *                      exactly as before. Every existing instance stays here.
 *   root project      → `/` is root Home and `/chat` is a root chat.
 *
 * Creating `<projectsRoot>/project.yaml` is the whole opt-in. Neither route
 * renders until `rootProject` resolves, so `/` never flashes the wrong page.
 */
function RootGate({
  withRoot,
  without,
}: {
  withRoot: ReactElement;
  without: ReactElement;
}) {
  const { rootProject } = useProjects();
  if (rootProject === undefined) {
    return <div className="p-8 text-sm text-paddock-500">Loading…</div>;
  }
  return rootProject ? withRoot : without;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    // Catch render errors — notably a rejected lazy-route import() (stale chunk
    // after a deploy, or a transient auth/network blip) — and reload onto the
    // current build instead of dead-ending at the default error screen (#222).
    errorElement: <RouteError />,
    children: [
      // `/` is root Home when a root project exists, the projects grid otherwise
      // (#516). No redirect and no sticky last tab at the root: `/` is the
      // instance's front door and always renders the same thing.
      {
        index: true,
        element: <RootGate withRoot={<ProjectView root />} without={<ProjectsGrid />} />,
      },
      // The projects grid keeps a real page of its own — it carries area
      // sections, collapse state and tag filtering, so it can't just be a
      // section of root Home (#516).
      { path: "projects", element: <ProjectsGrid /> },
      // The projects grid, filtered to a single domain tag (click a tag pill).
      { path: "tags/:tag", element: <TaggedProjects /> },
      // Bare project URL redirects to the sticky last tab (defaults to home).
      { path: "projects/:slug", element: <ProjectRedirect /> },
      // Deep-linkable in-project sub-routes. The active tab is derived from the
      // URL (not local state), so a deep link / reload highlights the right tab.
      { path: "projects/:slug/home", element: <ProjectView /> },
      { path: "projects/:slug/chat", element: <ProjectView /> },
      { path: "projects/:slug/chat/:sessionId", element: <ProjectView /> },
      { path: "projects/:slug/files", element: <ProjectView /> },
      // A splat so the current directory / file path nests in the URL, e.g.
      // /projects/:slug/files/design/foo.md (issue #259). Deep-linkable and
      // refresh-safe; ProjectView derives the subpath from the pathname.
      { path: "projects/:slug/files/*", element: <ProjectView /> },
      { path: "projects/:slug/changes", element: <ProjectView /> },
      { path: "projects/:slug/changes/:file", element: <ProjectView /> },
      { path: "projects/:slug/history", element: <ProjectView /> },
      { path: "projects/:slug/settings", element: <ProjectView /> },
      { path: "projects/:slug/triggers", element: <ProjectView /> },
      // Legacy Hooks route — the tab was renamed + folded into Triggers (Epic T / T4);
      // ProjectView redirects this to /triggers so old links/bookmarks don't 404.
      { path: "projects/:slug/hooks", element: <ProjectView /> },
      // Root chats when there is a root project, scratch chats otherwise (#516).
      // The URL is the same because root chats SUPERSEDE scratch — that is the
      // whole point of the design (Phase 6 deletes the scratch cluster outright).
      // Existing scratch transcripts stay on disk at `<dataDir>/scratch/.chats`
      // and are re-homed by that phase.
      { path: "chat", element: <RootGate withRoot={<ProjectView root />} without={<OneOffChat />} /> },
      {
        path: "chat/:sessionId",
        element: <RootGate withRoot={<ProjectView root />} without={<OneOffChat />} />,
      },
      // Top-level, instance-wide admin settings (edits paddock.config.yaml) — #385.
      { path: "settings", element: <InstanceSettings /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ProjectsProvider>
      <RouterProvider router={router} />
    </ProjectsProvider>
  </React.StrictMode>,
);

// Install the service worker (production only; see lib/pwa.ts) so the installed
// PWA launches offline. Registered after render so it never blocks first paint.
registerServiceWorker();
