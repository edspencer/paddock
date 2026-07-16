/**
 * RouteError as a router errorElement (issue #222): a rejected lazy import (a
 * chunk error) reloads once onto the current build; a non-chunk error, or a
 * chunk error that already survived a reload, shows a friendly error instead of
 * looping.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { RouteError } from "./RouteError";

function renderThrowing(error: unknown) {
  function Boom(): never {
    throw error;
  }
  const router = createMemoryRouter([
    { path: "/", element: <Boom />, errorElement: <RouteError /> },
  ]);
  return render(<RouterProvider router={router} />);
}

let reloadMock: ReturnType<typeof vi.fn>;
const originalLocation = window.location;

beforeEach(() => {
  sessionStorage.clear();
  reloadMock = vi.fn();
  Object.defineProperty(window, "location", { value: { reload: reloadMock }, configurable: true });
  // React logs caught render errors; keep test output quiet.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(window, "location", { value: originalLocation, configurable: true });
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("RouteError (issue #222)", () => {
  it("reloads once on a fresh chunk-load error and shows the updating spinner", () => {
    renderThrowing(new Error("Failed to fetch dynamically imported module: /assets/x.js"));
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Updating…")).toBeInTheDocument();
  });

  it("shows the error (no reload) for a non-chunk error", () => {
    renderThrowing(new Error("Cannot read properties of undefined"));
    expect(reloadMock).not.toHaveBeenCalled();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Cannot read properties of undefined")).toBeInTheDocument();
  });

  it("does NOT loop: a chunk error that already reloaded shows the error UI", () => {
    // Simulate a reload having just happened.
    sessionStorage.setItem("paddock:chunkReloadAt", String(Date.now()));
    renderThrowing(new Error("Importing a module script failed."));
    expect(reloadMock).not.toHaveBeenCalled();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });
});
