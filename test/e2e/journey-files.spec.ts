import { test, expect } from "@playwright/test";
import { seedProject, uniq } from "./helpers";

/**
 * Journey: Files tab — list, open, render (markdown / Mermaid / sandboxed HTML),
 * pin-as-tab + unpin, and pinned-tab persistence across reload.
 *
 * Disk-seeded with the three render kinds. Pinning is a pure REST + project.yaml
 * operation (no keeper agent needed), so disk seeding is faithful here.
 */

const MERMAID_MD = "# Diagram\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n";
const HTML_DOC =
  "<!doctype html><html><body><h1 id='sandboxed-marker'>Sandboxed Page</h1>" +
  "<script>document.body.dataset.ran='1'</script></body></html>";

test("lists files and opens a markdown file (rendered, not raw)", async ({ page }) => {
  const slug = seedProject({
    name: uniq("FL List"),
    files: {
      "notes.md": "# Notes\n\nThis is **bold** and a [link](https://example.com).",
      "raw.txt": "plain text content",
    },
  });

  await page.goto(`/projects/${slug}/files`);
  await expect(page.getByText("notes.md")).toBeVisible();
  await expect(page.getByText("raw.txt")).toBeVisible();

  await page.getByText("notes.md").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/files/notes.md`));
  // Markdown renders: bold -> <strong>, link -> <a target=_blank>.
  await expect(page.locator("strong", { hasText: "bold" })).toBeVisible();
  await expect(page.getByRole("link", { name: "link" })).toHaveAttribute("target", "_blank");
});

test("renders a Mermaid diagram to inline SVG", async ({ page }) => {
  const slug = seedProject({ name: uniq("FL Mermaid"), files: { "diagram.md": MERMAID_MD } });
  await page.goto(`/projects/${slug}/files/diagram.md`);

  // The Mermaid host renders an <svg> once the lazy mermaid bundle loads.
  const host = page.getByTestId("mermaid");
  await expect(host).toBeVisible({ timeout: 20_000 });
  await expect(host.locator("svg")).toBeVisible({ timeout: 20_000 });
});

test("renders sandboxed HTML inside an isolated iframe", async ({ page }) => {
  const slug = seedProject({ name: uniq("FL Html"), files: { "page.html": HTML_DOC } });
  await page.goto(`/projects/${slug}/files/page.html`);

  // The sandbox banner is shown, and the content renders in an iframe whose
  // srcDoc carries the HTML. sandbox="allow-scripts" (no allow-same-origin).
  await expect(page.getByText(/renders in.*sandboxed frame/i)).toBeVisible();
  const frame = page.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  // The iframe's document contains the marker (scripts allowed, isolated).
  const inner = page.frameLocator("iframe");
  await expect(inner.locator("#sandboxed-marker")).toHaveText("Sandboxed Page", { timeout: 15_000 });
});

test("pin a file as a tab, unpin it; the tab disappears", async ({ page }) => {
  const slug = seedProject({ name: uniq("FL Pin"), files: { "pinme.md": "# Pin me" } });

  await page.goto(`/projects/${slug}/files/pinme.md`);
  // Pin via the reader's "Pin as tab" button.
  await page.getByRole("button", { name: /Pin as tab/i }).click();
  // A sibling pinned tab appears for the file.
  const pinnedTab = page.getByRole("tab", { name: /Open pinme.md tab/i });
  await expect(pinnedTab).toBeVisible();
  // The reader's button now reads "Pinned".
  await expect(page.getByRole("button", { name: /Pinned/i }).first()).toBeVisible();

  // Unpin via the tab's "x".
  await page.getByRole("button", { name: /Unpin pinme.md/i }).click();
  await expect(page.getByRole("tab", { name: /Open pinme.md tab/i })).toHaveCount(0);
});

test("pinned tab persists across reload (project.yaml-backed)", async ({ page }) => {
  const slug = seedProject({ name: uniq("FL PinPersist"), files: { "keep.md": "# Keep" } });

  await page.goto(`/projects/${slug}/files/keep.md`);
  await page.getByRole("button", { name: /Pin as tab/i }).click();
  await expect(page.getByRole("tab", { name: /Open keep.md tab/i })).toBeVisible();

  // Reload → the pinned tab is still there (read from project.pinned on disk).
  await page.reload();
  await expect(page.getByRole("tab", { name: /Open keep.md tab/i })).toBeVisible();

  // And navigating to the bare project URL restores the pinned-file tab (sticky).
  await page.goto(`/projects/${slug}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/files/keep.md`));
});
