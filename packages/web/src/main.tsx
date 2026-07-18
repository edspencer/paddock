import React, { lazy } from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider, useParams } from "react-router-dom";
import "./index.css";
import { AppShell } from "./components/AppShell";
import { RouteError } from "./components/RouteError";
import { ProjectsProvider } from "./lib/projects-context";
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

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    // Catch render errors — notably a rejected lazy-route import() (stale chunk
    // after a deploy, or a transient auth/network blip) — and reload onto the
    // current build instead of dead-ending at the default error screen (#222).
    errorElement: <RouteError />,
    children: [
      { index: true, element: <ProjectsGrid /> },
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
      { path: "chat", element: <OneOffChat /> },
      { path: "chat/:sessionId", element: <OneOffChat /> },
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
