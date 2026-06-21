import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./index.css";
import { AppShell } from "./components/AppShell";
import { ProjectsGrid } from "./routes/ProjectsGrid";
import { ProjectView } from "./routes/ProjectView";
import { OneOffChat } from "./routes/OneOffChat";

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <ProjectsGrid /> },
      { path: "projects/:slug", element: <ProjectView /> },
      { path: "chat/:id", element: <OneOffChat /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
