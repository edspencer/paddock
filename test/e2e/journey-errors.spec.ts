import { test, expect } from "@playwright/test";
import { createProjectViaUI, uniq } from "./helpers";

/**
 * Journey: error + empty states.
 *
 * - Empty grid CTA: the "Create your first project" state (driven by stubbing
 *   the list endpoints to empty, so it's independent of the shared data dir).
 * - Project-with-no-chats hint.
 * - Unknown slug → an inline "not found" error.
 * - WS drop/reconnect: the connection dot reflects offline → reconnected.
 */

test("empty grid shows the 'Create your first project' CTA", async ({ page }) => {
  // The empty state only renders with zero projects AND zero inbox chats. The
  // shared server accumulates state across tests, so stub the list endpoints to
  // empty to exercise the EmptyState component deterministically.
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { projects: [] } });
    } else {
      await route.continue();
    }
  });
  await page.route("**/api/chats", async (route) => {
    await route.fulfill({ json: { chats: [] } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Create your first project/i })).toBeVisible();
  // The CTA offers both "New Project" and "Just chat once".
  await expect(page.getByRole("button", { name: /New Project/i }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: /Just chat once/i })).toBeVisible();
});

test("a project with no chats shows the 'No saved chats yet' hint", async ({ page }) => {
  const slug = await createProjectViaUI(page, { name: uniq("ER NoChats") });
  await page.goto(`/projects/${slug}/chat`);

  // The session list shows the no-chats hint, and the empty-pane hint shows in
  // the transcript area.
  await expect(page.getByText(/No saved chats yet/i)).toBeVisible();
  await expect(page.getByText(/Start the conversation/i)).toBeVisible();
});

test("an unknown project slug shows an inline 'not found' error", async ({ page }) => {
  await page.goto(`/projects/no-such-project-${Date.now().toString(36)}/chat`);
  // ProjectView surfaces the load error from the 404 in a rose error box.
  await expect(page.getByText(/Project not found|not found/i).first()).toBeVisible({
    timeout: 15_000,
  });
});

test("WS drop + reconnect: the dot leaves 'connected' on a drop, then auto-reconnects", async ({
  page,
}) => {
  // Intercept the /ws socket. The first connection is dropped immediately
  // (simulating a network blip) which exercises the client's reconnect logic;
  // subsequent attempts are proxied to the real server so the chat works again.
  // This is deterministic (no reliance on setOffline tearing down an open WS).
  let attempts = 0;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    attempts += 1;
    if (attempts === 1) {
      // Drop the very first connection right away → client schedules a reconnect.
      ws.close();
      return;
    }
    // Proxy every later attempt to the real server (full duplex passthrough).
    ws.connectToServer();
  });

  const slug = await createProjectViaUI(page, { name: uniq("ER WS") });

  // After the initial dropped connection + reconnect, the dot should settle on
  // "connected" (the second attempt proxies through).
  await expect(page.getByText("connected").first()).toBeVisible({ timeout: 20_000 });
  // More than one connection attempt was made (proves the reconnect fired).
  expect(attempts).toBeGreaterThan(1);

  // And the chat works over the reconnected socket.
  await page.goto(`/projects/${slug}/chat`);
  const composer = page.getByPlaceholder(/Message the keeper agent/i);
  await composer.fill("after reconnect");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByText(/Acknowledged: after reconnect/).first()).toBeVisible({
    timeout: 30_000,
  });
});
