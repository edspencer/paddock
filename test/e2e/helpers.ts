import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Shared E2E helpers. The server + SPA are REAL (see server.mjs); the fake
 * `claude` echoes prompts as "Acknowledged: <prompt>". The server's temp data
 * dir is shared with the test process via PADDOCK_E2E_TMP, so specs can seed
 * real files into a project's directory on disk (the keeper agent would
 * otherwise author them — the fake only writes transcripts).
 */

/** The projects root on disk (matches server.mjs). */
export function projectsRoot(): string {
  const tmp = process.env.PADDOCK_E2E_TMP;
  if (!tmp) throw new Error("PADDOCK_E2E_TMP not set — run via the playwright config");
  return path.join(tmp, "data", "projects");
}

/** Write a file directly into a project's on-disk directory (as the keeper would). */
export function seedProjectFile(slug: string, name: string, content: string): void {
  const dir = path.join(projectsRoot(), slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, "utf8");
}

/** Create a project via the New Project modal; returns its slug from the URL. */
export async function createProject(
  page: Page,
  name: string,
  opts: { area?: string; tags?: string } = {},
): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: /New Project/i }).first().click();
  const dialog = page.locator("form").filter({ hasText: "New project" });
  await dialog.getByPlaceholder(/Garage Water Heater/i).fill(name);
  if (opts.area) {
    await dialog.getByRole("combobox").first().selectOption({ label: opts.area });
  }
  if (opts.tags) {
    await dialog.getByPlaceholder(/home, plumbing/i).fill(opts.tags);
  }
  await dialog.getByRole("button", { name: /Create project/i }).click();
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+/);
  const m = page.url().match(/\/projects\/([a-z0-9-]+)/);
  if (!m) throw new Error(`could not read slug from ${page.url()}`);
  return m[1];
}

/** Send a chat turn in the currently-open ChatPane and wait for the echoed reply. */
export async function sendChat(page: Page, message: string, placeholder = /Message the keeper agent/i) {
  await page.getByPlaceholder(placeholder).fill(message);
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByText(`Acknowledged: ${message}`).first()).toBeVisible({ timeout: 30_000 });
}
