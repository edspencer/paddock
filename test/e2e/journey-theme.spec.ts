import { expect, test } from "@playwright/test";

// Light/dark theme toggle (#23). Default is dark; the sidebar toggle flips the
// `dark` class on <html> and persists via localStorage. An inline script in
// index.html applies the saved theme before first paint (no flash).
test("theme toggle: dark → light persists across reload, then back to dark", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/dark/);

  // Toggle to light.
  await page.getByRole("button", { name: /Switch to light mode/i }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  // Persists across a reload (read from localStorage by the inline init script).
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  // Toggle back to dark.
  await page.getByRole("button", { name: /Switch to dark mode/i }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
});
