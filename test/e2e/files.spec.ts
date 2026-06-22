import { test, expect } from "@playwright/test";
import { createProject, seedProjectFile } from "./helpers";

/**
 * File rendering + pin-as-tab, end-to-end. Files are seeded onto disk (as the
 * keeper agent would author them) and rendered by the real FileView: markdown
 * (with a Mermaid fence → SVG), sandboxed HTML in an iframe, and plain text.
 * Then a file is pinned as a sibling tab and the pin survives a reload.
 */

test("renders a markdown file (with a Mermaid diagram) from the Files tab", async ({ page }) => {
  const slug = await createProject(page, "E2E Markdown Render", { area: "Homelab" });
  seedProjectFile(
    slug,
    "design.md",
    [
      "# Design Doc",
      "",
      "Some **bold** prose and a diagram:",
      "",
      "```mermaid",
      "graph TD; A[Start] --> B[End];",
      "```",
      "",
    ].join("\n"),
  );

  await page.goto(`/projects/${slug}/files`);
  await page.getByText("design.md").click();

  // Markdown heading + prose render.
  await expect(page.getByRole("heading", { name: "Design Doc" })).toBeVisible();
  await expect(page.getByText("bold")).toBeVisible();
  // The Mermaid fence renders to an SVG inside the mermaid host.
  const mermaid = page.getByTestId("mermaid");
  await expect(mermaid).toBeVisible({ timeout: 15_000 });
  await expect(mermaid.locator("svg")).toBeVisible({ timeout: 15_000 });
});

test("renders an HTML file inside a sandboxed iframe", async ({ page }) => {
  const slug = await createProject(page, "E2E Html Render", { area: "Homelab" });
  seedProjectFile(
    slug,
    "report.html",
    "<!doctype html><html><body><h1 id='hdr'>Sandboxed Report</h1></body></html>",
  );

  await page.goto(`/projects/${slug}/files`);
  await page.getByText("report.html").click();

  // The security note + a sandboxed iframe (scripts allowed, NOT same-origin).
  await expect(page.getByText(/sandboxed frame/i)).toBeVisible();
  const frame = page.locator('iframe[title="report.html"]');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  // The framed document renders its own heading.
  await expect(frame.contentFrame().getByRole("heading", { name: "Sandboxed Report" })).toBeVisible();
});

test("pin a file as a sibling tab; the pin survives reload", async ({ page }) => {
  const slug = await createProject(page, "E2E Pin Tab", { area: "House" });
  seedProjectFile(slug, "page.html", "<h1>Pinned Page</h1>");

  await page.goto(`/projects/${slug}/files`);
  // Pin from the files list.
  await page.getByRole("button", { name: /^Pin page.html$/ }).click();

  // A pinned sibling tab appears in the tab bar.
  const pinnedTab = page.getByRole("tab", { name: /Open page.html tab/i });
  await expect(pinnedTab).toBeVisible();

  // Reload → the pin persists (server-stored) and the tab is still there.
  await page.reload();
  const tab = page.getByRole("tab", { name: /Open page.html tab/i });
  await expect(tab).toBeVisible({ timeout: 10_000 });

  // Open the pinned tab so the file reader (not the files list) is showing, then
  // unpin via the tab's "x" — the tab disappears.
  await tab.click();
  await expect(page).toHaveURL(/\/files\/page\.html$/);
  await page.getByRole("button", { name: /^Unpin page.html$/ }).click();
  await expect(page.getByRole("tab", { name: /Open page.html tab/i })).toHaveCount(0);
});

test("pinning the file you're viewing keeps it rendered (no jump)", async ({ page }) => {
  const slug = await createProject(page, "E2E Pin Viewed", { area: "Homelab" });
  seedProjectFile(slug, "notes.md", "# Visible Notes\n\nbody\n");

  await page.goto(`/projects/${slug}/files/notes.md`);
  await expect(page.getByRole("heading", { name: "Visible Notes" })).toBeVisible();

  // Pin from the file reader's "Pin as tab" button.
  await page.getByRole("button", { name: /Pin as tab/i }).click();
  // The reader still shows the same file (its heading), now labelled "Pinned".
  await expect(page.getByRole("heading", { name: "Visible Notes" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Pinned/i })).toBeVisible();
});
