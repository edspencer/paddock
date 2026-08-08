import React, { lazy } from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider, useParams } from "react-router-dom";
import "./index.css";
import { AppShell } from "./components/AppShell";
import { RouteError } from "./components/RouteError";
import { ProjectsProvider } from "./lib/projects-context";
import { registerServiceWorker } from "./lib/pwa";
import { initAppearance } from "./lib/appearance";

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
const InstanceConfigPage = lazy(() =>
  import("./routes/InstanceConfigPage").then((m) => ({ default: m.InstanceConfigPage })),
);

// Reflect tab visibility onto <html data-tab-hidden> so CSS can pause the
// continuous streaming animations (spinners, caret) while the tab is
// backgrounded — see index.css. Hidden tabs aren't composited to screen, but
// this also stops the renderer from ticking the animation while you're away.
// Apply the saved theme + accent before the first render. index.html has
// already put the theme class and the CACHED accent channels on <html> pre-paint;
// this re-solves them properly (the cache can be stale after an upgrade) and
// installs the light/dark watcher that re-solves on a mode flip.
initAppearance();

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
      // `/` IS the root workspace's Home. The root workspace always exists — it
      // is the instance's own directory — so there is nothing to gate on and
      // nothing to wait for. No redirect and no sticky last tab: `/` is the
      // instance's front door and always renders the same thing.
      { index: true, element: <ProjectView root /> },
      // The projects grid, back on its own page (#599). It spent a release as a
      // section of root Home, but Home's opening screen now belongs to the
      // running/unread feeds — and with the section gone, `/projects` is the
      // only route that renders the grid UNFILTERED, so without it the area
      // sections and the first-project empty state would be unreachable.
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
      // Root chats (#516). `/chat` IS root chats — never a redirect to them.
      // With no root project it 404s through the shell's error boundary, the same
      // as Files/Changes/History/Triggers.
      { path: "chat", element: <ProjectView root /> },
      { path: "chat/:sessionId", element: <ProjectView root /> },
      // Root Files + Changes (#516 Phase 4). These paths have no pre-#516
      // meaning, so unlike `/` and `/chat` there is nothing to fall back TO —
      // without a root project they 404 through the shell's error boundary,
      // which is correct: the tabs that link here only render at the root.
      { path: "files", element: <ProjectView root /> },
      // A splat so the current directory / file nests in the URL, exactly as
      // the project route does (issue #259).
      { path: "files/*", element: <ProjectView root /> },
      { path: "changes", element: <ProjectView root /> },
      { path: "changes/:file", element: <ProjectView root /> },
      // Root History + Triggers (#516 Phase 5). Both were already generic
      // server-side — `/api/projects/:slug/runs` and `…/triggers` resolve through
      // `projects.get()` — so these are routes plus un-hidden tabs, nothing more.
      { path: "history", element: <ProjectView root /> },
      { path: "triggers", element: <ProjectView root /> },
      // The ROOT workspace's Settings tab — its `project.yaml`, exactly like any
      // project's. It used to ALSO render the instance-wide config beneath it as
      // a second section, which read as two pages in one; that lives at `/config`
      // now (below), so this is the plain workspace tab it should always have been.
      { path: "settings", element: <ProjectView root /> },
      // Instance-wide admin config (edits `paddock.config.yaml`) — #385. Named
      // for the file it writes, and separate from `/settings` because its
      // lifecycle is different: frozen at boot, so every save is restart-required.
      { path: "config", element: <InstanceConfigPage /> },
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
