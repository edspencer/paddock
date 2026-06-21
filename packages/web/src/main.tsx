import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./index.css";
import { AppShell } from "./components/AppShell";
import { ProjectsProvider } from "./lib/projects-context";
import { ProjectsGrid } from "./routes/ProjectsGrid";
import { ProjectView } from "./routes/ProjectView";
import { ProjectRedirect } from "./routes/ProjectRedirect";
import { OneOffChat } from "./routes/OneOffChat";

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <ProjectsGrid /> },
      // Bare project URL redirects to the sticky last tab (defaults to chat).
      { path: "projects/:slug", element: <ProjectRedirect /> },
      // Deep-linkable in-project sub-routes. The active tab is derived from the
      // URL (not local state), so a deep link / reload highlights the right tab.
      { path: "projects/:slug/chat", element: <ProjectView /> },
      { path: "projects/:slug/chat/:sessionId", element: <ProjectView /> },
      { path: "projects/:slug/files", element: <ProjectView /> },
      { path: "projects/:slug/files/:name", element: <ProjectView /> },
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
